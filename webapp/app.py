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
import secrets
import sys
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory, abort, session

# Allow running from project root: `python webapp/app.py`
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import ute_format
import validator
import storage
import pak_format
import nya_format
from storage import MapStore, slugify, level_from_json, level_to_json


# ----------------------------------------------------------------------------
# Configuration (env-overridable)
# ----------------------------------------------------------------------------

DEFAULT_MAPS_DIR = os.environ.get(
    "UTENYAA_MAPS_DIR",
    str(HERE / "maps"))
# Admin credentials. Single shared password gates destructive ops
# (DELETE map, future overwrite-of-others) — fine for a small homebrew
# tool with trusted operators. Override via env var when deploying.
DEFAULT_ADMIN_USERNAME = os.environ.get("UTENYAA_ADMIN_USER", "admin")
DEFAULT_ADMIN_PASSWORD = os.environ.get("UTENYAA_ADMIN_PASS", "coup2025")
# Persist across server restarts so existing admin sessions survive.
DEFAULT_SESSION_SECRET = os.environ.get(
    "UTENYAA_SESSION_SECRET",
    "")  # blank → generated per-process at create_app() time
DEFAULT_PAK_PATH = os.environ.get(
    "UTENYAA_TERRAIN_PAK",
    str(HERE.parent / "reference_pak" / "TERRAIN.PAK"))
DEFAULT_MODELS_DIR = os.environ.get(
    "UTENYAA_MODELS_DIR",
    str(HERE.parent / "reference_models"))

# Model index mapping mirrors main.cxx ModelManager::LoadModel order:
#   index 0 = CRATE,  1 = PLAYER, 2 = TREE,
#   3 = WALL,         4 = WALL2,  5 = WALL3,
#   6 = BOMB.
# entity.Reserved[1] holds this index for Crate / Model entities.
MODEL_NAMES = ["CRATE", "PLAYER", "TREE", "WALL", "WALL2", "WALL3", "BOMB"]
DEFAULT_PORT = int(os.environ.get("UTENYAA_EDITOR_PORT", "5000"))
DEFAULT_HOST = os.environ.get("UTENYAA_EDITOR_HOST", "127.0.0.1")


# ----------------------------------------------------------------------------
# In-memory cache of decoded textures (parsed once on first request)
# ----------------------------------------------------------------------------

class TextureCache:
    """Lazy-load and cache textures from a single .PAK on disk."""

    def __init__(self, pak_path: str):
        self.pak_path = pak_path
        self._textures = None      # parsed list, lazily populated
        self._png_cache: dict[int, bytes] = {}

    def _ensure_loaded(self):
        if self._textures is not None:
            return
        try:
            with open(self.pak_path, "rb") as f:
                data = f.read()
            self._textures = pak_format.parse(data)
        except (FileNotFoundError, OSError):
            self._textures = []

    @property
    def count(self) -> int:
        self._ensure_loaded()
        return len(self._textures)

    def info(self) -> list:
        self._ensure_loaded()
        return [{"index": i, "width": t.width, "height": t.height}
                for i, t in enumerate(self._textures)]

    def png(self, idx: int) -> bytes:
        self._ensure_loaded()
        if not 0 <= idx < len(self._textures):
            raise IndexError(idx)
        if idx in self._png_cache:
            return self._png_cache[idx]
        t = self._textures[idx]
        png = pak_format.encode_png(t.rgba, t.width, t.height)
        self._png_cache[idx] = png
        return png


# ----------------------------------------------------------------------------
# App factory
# ----------------------------------------------------------------------------

class ModelCache:
    """Lazy-load + cache parsed NYA models from a directory."""

    def __init__(self, models_dir: str):
        self.dir = Path(models_dir).resolve()
        self._cache: dict[int, dict] = {}      # model index → JSON-safe dict

    def _build(self, idx: int) -> dict:
        if not 0 <= idx < len(MODEL_NAMES):
            raise IndexError(idx)
        path = self.dir / f"{MODEL_NAMES[idx]}.NYA"
        if not path.exists():
            raise FileNotFoundError(str(path))
        with open(path, "rb") as f:
            data = f.read()
        m = nya_format.parse(data)

        # Convert to a JSON-safe payload sized for the browser. Each
        # mesh's points + polygons + face-flags get flattened into
        # arrays the Three.js builder can consume directly.
        meshes = []
        for mesh in m.meshes:
            meshes.append({
                "points":   [list(p) for p in mesh.points],
                "polygons": [
                    {"normal": [poly.nx, poly.ny, poly.nz],
                     "vertices": list(poly.vertices)}
                    for poly in mesh.polygons
                ],
                "face_flags": [
                    {"flags": ff.flags,
                     "has_texture": ff.has_texture,
                     "has_mesh":    ff.has_mesh,
                     "is_double_sided": ff.is_double_sided,
                     "is_half_trans":   ff.is_half_trans,
                     "base_color": ff.base_color,
                     "texture_id": ff.texture_id}
                    for ff in mesh.face_flags
                ],
            })
        textures = []
        for t in m.textures:
            png = pak_format.encode_png(t.rgba, t.width, t.height)
            import base64
            textures.append({
                "width": t.width,
                "height": t.height,
                "png_base64": base64.b64encode(png).decode("ascii"),
            })
        return {
            "index": idx,
            "name": MODEL_NAMES[idx],
            "filename": path.name,
            "mesh_count": len(meshes),
            "texture_count": len(textures),
            "meshes": meshes,
            "textures": textures,
        }

    def get(self, idx: int) -> dict:
        if idx in self._cache:
            return self._cache[idx]
        v = self._build(idx)
        self._cache[idx] = v
        return v

    def info(self) -> list:
        out = []
        for i, name in enumerate(MODEL_NAMES):
            path = self.dir / f"{name}.NYA"
            out.append({
                "index": i,
                "name": name,
                "filename": path.name,
                "exists": path.exists(),
            })
        return out


def create_app(maps_dir: str = DEFAULT_MAPS_DIR,
               pak_path: str = DEFAULT_PAK_PATH,
               models_dir: str = DEFAULT_MODELS_DIR,
               admin_user: str = DEFAULT_ADMIN_USERNAME,
               admin_pass: str = DEFAULT_ADMIN_PASSWORD,
               session_secret: str = DEFAULT_SESSION_SECRET) -> Flask:
    static_folder = str(HERE / "static")
    app = Flask(__name__,
                static_folder=static_folder,
                static_url_path="/static")
    # Sign session cookies. Per-process random key when none supplied
    # via env — admin sessions are invalidated on each server restart,
    # which is fine for a tool with one operator.
    app.secret_key = session_secret or secrets.token_hex(32)
    app.config["UTENYAA_ADMIN_USER"] = admin_user
    app.config["UTENYAA_ADMIN_PASS"] = admin_pass
    store = MapStore(maps_dir)
    app.config["MAP_STORE"] = store
    tex_cache = TextureCache(pak_path)
    app.config["TEXTURES"] = tex_cache
    model_cache = ModelCache(models_dir)
    app.config["MODELS"] = model_cache

    def _is_admin() -> bool:
        return bool(session.get("is_admin"))

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
        if not _is_admin():
            return jsonify({
                "error": "admin_required",
                "message": "Only admins can delete maps. "
                           "If you want to make changes to this map, clone it first."
            }), 403
        try:
            removed = store.delete(slug)
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        if not removed:
            abort(404)
        return jsonify({"ok": True})

    # ------------------------------------------------------------------
    # Admin auth — single shared credential. Destructive ops (delete)
    # require an active admin session. Read/save remain open.
    # ------------------------------------------------------------------

    @app.route("/api/admin/status", methods=["GET"])
    def admin_status():
        return jsonify({"is_admin": _is_admin()})

    @app.route("/api/admin/login", methods=["POST"])
    def admin_login():
        body = request.get_json(silent=True) or {}
        u = body.get("username", "")
        p = body.get("password", "")
        # Constant-time compare to avoid trivial timing distinguisher.
        ok_user = secrets.compare_digest(str(u), str(app.config["UTENYAA_ADMIN_USER"]))
        ok_pass = secrets.compare_digest(str(p), str(app.config["UTENYAA_ADMIN_PASS"]))
        if not (ok_user and ok_pass):
            # Sleep briefly to slow brute-force loops without affecting
            # legitimate users.
            import time
            time.sleep(0.3)
            return jsonify({"error": "invalid_credentials"}), 401
        session["is_admin"] = True
        session.permanent = True
        return jsonify({"is_admin": True})

    @app.route("/api/admin/logout", methods=["POST"])
    def admin_logout():
        session.pop("is_admin", None)
        return jsonify({"is_admin": False})

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

    @app.route("/api/textures", methods=["GET"])
    def list_textures():
        """List all textures in the loaded TERRAIN.PAK."""
        return jsonify({
            "pak_path": tex_cache.pak_path,
            "count": tex_cache.count,
            "textures": tex_cache.info(),
        })

    @app.route("/api/textures/<int:idx>.png", methods=["GET"])
    def texture_png(idx: int):
        """Serve one texture as a PNG (cached after first decode)."""
        try:
            png = tex_cache.png(idx)
        except IndexError:
            abort(404)
        from flask import Response
        return Response(png, mimetype="image/png",
                        headers={"Cache-Control": "public, max-age=3600"})

    @app.route("/api/models", methods=["GET"])
    def list_models():
        """List the 7 known NYA models (mirrors ModelManager indices)."""
        return jsonify({
            "models_dir": str(model_cache.dir),
            "models": model_cache.info(),
        })

    @app.route("/api/models/<int:idx>", methods=["GET"])
    def get_model(idx: int):
        """Get a fully-decoded NYA model as JSON (geometry + base64 PNG textures)."""
        try:
            data = model_cache.get(idx)
        except (IndexError, FileNotFoundError):
            abort(404)
        return jsonify(data)

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
