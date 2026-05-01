"""
app.py — Flask web app for the Utenyaa map editor.

Cross-platform: relies on stdlib + Flask only. Runs identically on
Windows desktop and Linux server.

Endpoints:
    GET  /                       → editor UI (static index.html)
    GET  /static/...             → CSS / JS assets
    GET  /api/maps               → list saved maps
    GET  /api/maps/<slug>        → load a map's JSON
    POST /api/maps/<slug>        → save (JSON body == editor state)
    DELETE /api/maps/<slug>      → remove
    GET  /api/maps/<slug>/ute    → download the binary .UTE
    POST /api/validate           → run validator on a JSON payload, return
                                   {errors, warnings, ute_size_bytes}
    GET  /api/health             → liveness check

NOT wired up to the Saturn server. This app stands alone — its only
output is .UTE files in webapp/maps/, which a future integration can
slurp up.
"""

from __future__ import annotations
import os
import sys
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory, abort

# Allow running from project root: `python webapp/app.py`
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import ute_format
import validator
import storage
from storage import MapStore, slugify, level_from_json, level_to_json


# ----------------------------------------------------------------------------
# Configuration (env-overridable)
# ----------------------------------------------------------------------------

DEFAULT_MAPS_DIR = os.environ.get(
    "UTENYAA_MAPS_DIR",
    str(HERE / "maps"))
DEFAULT_PORT = int(os.environ.get("UTENYAA_EDITOR_PORT", "5000"))
DEFAULT_HOST = os.environ.get("UTENYAA_EDITOR_HOST", "127.0.0.1")


# ----------------------------------------------------------------------------
# App factory
# ----------------------------------------------------------------------------

def create_app(maps_dir: str = DEFAULT_MAPS_DIR) -> Flask:
    static_folder = str(HERE / "static")
    app = Flask(__name__,
                static_folder=static_folder,
                static_url_path="/static")
    store = MapStore(maps_dir)
    app.config["MAP_STORE"] = store

    @app.route("/")
    def index():
        return send_from_directory(app.static_folder, "index.html")

    @app.route("/api/health")
    def health():
        return jsonify({"ok": True, "maps_dir": str(store.root)})

    @app.route("/api/maps", methods=["GET"])
    def list_maps():
        return jsonify({"maps": store.list_maps()})

    @app.route("/api/maps/<slug>", methods=["GET"])
    def get_map(slug):
        try:
            data = store.load(slug)
        except FileNotFoundError:
            abort(404)
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        return jsonify(data)

    @app.route("/api/maps/<slug>", methods=["POST"])
    def save_map(slug):
        body = request.get_json(silent=True)
        if body is None:
            return jsonify({"error": "body must be JSON"}), 400

        # Run validator before save — block on hard errors but allow
        # warnings (caller can override with ?force=1)
        try:
            level = level_from_json(body)
        except Exception as e:
            return jsonify({"error": f"invalid level json: {e}"}), 400

        force = request.args.get("force", "0") == "1"
        errors, warnings = validator.validate(level)
        if errors and not force:
            return jsonify({
                "error": "validation_failed",
                "errors": errors,
                "warnings": warnings,
            }), 400

        try:
            result = store.save(slug, body)
        except ValueError as e:
            return jsonify({"error": str(e)}), 400

        result["errors"] = errors
        result["warnings"] = warnings
        return jsonify(result)

    @app.route("/api/maps/<slug>", methods=["DELETE"])
    def delete_map(slug):
        try:
            removed = store.delete(slug)
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        if not removed:
            abort(404)
        return jsonify({"ok": True})

    @app.route("/api/maps/<slug>/ute", methods=["GET"])
    def download_ute(slug):
        try:
            data = store.get_ute_bytes(slug)
        except FileNotFoundError:
            abort(404)
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        from flask import Response
        return Response(
            data,
            mimetype="application/octet-stream",
            headers={
                "Content-Disposition":
                    f'attachment; filename="{slug.upper()}.UTE"',
                "Content-Length": str(len(data)),
            },
        )

    @app.route("/api/validate", methods=["POST"])
    def validate_only():
        body = request.get_json(silent=True)
        if body is None:
            return jsonify({"error": "body must be JSON"}), 400
        try:
            level = level_from_json(body)
        except Exception as e:
            return jsonify({"error": f"invalid level json: {e}"}), 400
        errors, warnings = validator.validate(level)
        ute_size = len(ute_format.serialize(level)) if not errors else 0
        return jsonify({
            "errors": errors,
            "warnings": warnings,
            "ute_size_bytes": ute_size,
        })

    @app.route("/api/slugify", methods=["GET"])
    def slugify_endpoint():
        name = request.args.get("name", "")
        return jsonify({"slug": slugify(name)})

    @app.route("/api/format-info", methods=["GET"])
    def format_info():
        """Static info about the .UTE binary format. Useful for the editor
        UI to sanity-check its model and for debugging."""
        return jsonify({
            "map_dimension": ute_format.MAP_DIMENSION,
            "tile_count": ute_format.TILE_COUNT,
            "fixed_prefix_size": ute_format.FIXED_PREFIX_SIZE,
            "entity_record_size": ute_format.ENTITY_RECORD_SIZE,
            "version_byte": ute_format.VERSION_BYTE,
            "entity_types": [
                {"id": k, "name": v} for k, v in
                sorted(ute_format.ENTITY_TYPE_NAMES.items())
            ],
            "min_player_spawns": validator.MIN_PLAYER_SPAWNS,
            "max_player_spawns": validator.MAX_PLAYER_SPAWNS,
            "max_total_entities": validator.MAX_TOTAL_ENTITIES,
        })

    return app


def main():
    app = create_app()
    print(f"Utenyaa Map Editor")
    print(f"  maps dir: {app.config['MAP_STORE'].root}")
    print(f"  open http://{DEFAULT_HOST}:{DEFAULT_PORT}/")
    # debug=False so request reloads don't surprise; set FLASK_DEBUG=1 to
    # enable. host=0.0.0.0 if you want LAN access.
    debug = os.environ.get("FLASK_DEBUG", "0") == "1"
    app.run(host=DEFAULT_HOST, port=DEFAULT_PORT, debug=debug)


if __name__ == "__main__":
    main()
