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
import json
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
# Two deployment modes drive admin behavior:
#
#   UTENYAA_AUTO_ADMIN=1   (used by the saturn-admin /admin/editor/ mount)
#       Every visitor is automatically an admin — they got past the
#       upstream basic-auth gate so they're trusted. /api/admin/status
#       returns is_admin=true unconditionally.
#
#   UTENYAA_PUBLIC_MODE=1  (used by the unauth /mapeditor/ mount)
#       No upstream gate. Visitors are NEVER admins, regardless of any
#       login attempt — destructive ops like map delete return 403.
#       The editor's own login modal is also hidden via CSS so users
#       don't see a redundant prompt.
#
# Default (neither set): standalone tool — original behavior. User
# starts as non-admin, can promote via /api/admin/login with the
# username/password env vars.
AUTO_ADMIN  = os.environ.get("UTENYAA_AUTO_ADMIN",  "0") not in ("0", "", "false", "False")
PUBLIC_MODE = os.environ.get("UTENYAA_PUBLIC_MODE", "0") not in ("0", "", "false", "False")
# Persist across server restarts so existing admin sessions survive.
DEFAULT_SESSION_SECRET = os.environ.get(
    "UTENYAA_SESSION_SECRET",
    "")  # blank → generated per-process at create_app() time
DEFAULT_PAK_PATH = os.environ.get(
    "UTENYAA_TERRAIN_PAK",
    str(HERE.parent / "reference_pak" / "TERRAIN.PAK"))
DEFAULT_CHARS_PAK_PATH = os.environ.get(
    "UTENYAA_CHARS_PAK",
    str(HERE.parent / "reference_pak" / "CHARS.PAK"))
# Per-frame customizations live next to the editor's maps dir so a
# single backup of /opt/utenyaa-editor/webapp/ captures both maps and
# custom sprites. Each modified sprite is saved as a raw ARGB-1555
# big-endian binary at <CUSTOM_CHARS_DIR>/<idx>.dat (W*H*2 bytes,
# matching the on-disk PAK encoding of one NyaTexture's pixel block).
DEFAULT_CUSTOM_CHARS_DIR = os.environ.get(
    "UTENYAA_CUSTOM_CHARS_DIR",
    str(HERE / "custom_chars"))
# Custom CHARACTERS (each with name + creator metadata + 5 sprite
# frames) live here. Different from the per-frame override system
# above — these are NEW characters, not edits of the built-in 5.
# One <slug>.json per character, parallel to the maps/ directory.
DEFAULT_CUSTOM_CHARACTERS_DIR = os.environ.get(
    "UTENYAA_CUSTOM_CHARACTERS_DIR",
    str(HERE / "custom_characters"))
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
               chars_pak_path: str = DEFAULT_CHARS_PAK_PATH,
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
    chars_cache = TextureCache(chars_pak_path)
    app.config["CHARS"] = chars_cache
    custom_chars_dir = Path(DEFAULT_CUSTOM_CHARS_DIR)
    custom_chars_dir.mkdir(parents=True, exist_ok=True)
    app.config["CUSTOM_CHARS_DIR"] = str(custom_chars_dir)
    custom_characters_dir = Path(DEFAULT_CUSTOM_CHARACTERS_DIR)
    custom_characters_dir.mkdir(parents=True, exist_ok=True)
    app.config["CUSTOM_CHARACTERS_DIR"] = str(custom_characters_dir)
    model_cache = ModelCache(models_dir)
    app.config["MODELS"] = model_cache

    def _is_admin() -> bool:
        # PUBLIC_MODE forcibly denies admin regardless of session state —
        # destructive ops (delete) always 403. AUTO_ADMIN forcibly grants
        # admin for any visitor — they got past the upstream auth gate.
        # Otherwise honor the per-session flag set by /api/admin/login.
        if PUBLIC_MODE: return False
        if AUTO_ADMIN:  return True
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
        # Editor frontend reads this on load to decide UI affordances
        # (delete buttons visible when admin). Includes the deploy-time
        # mode flags so the editor can adjust behavior — public_mode
        # disables admin promotion entirely.
        return jsonify({
            "is_admin": _is_admin(),
            "public_mode": PUBLIC_MODE,
            "auto_admin":  AUTO_ADMIN,
        })

    @app.route("/api/admin/login", methods=["POST"])
    def admin_login():
        if PUBLIC_MODE:
            return jsonify({"error": "public_mode"}), 403
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

    @app.route("/api/maps/<slug>/mirror_x", methods=["POST"])
    def mirror_map_x_endpoint(slug):
        """Mirror an already-saved map across its X axis. Idempotent —
        running twice produces the original. Same logic as the
        standalone mirror_map_x.py script: reverse each row of
        TileData/Gourad/Normals, negate normal.x, flip entity X.
        Useful for fixing maps authored in a wrong-orientation editor
        OR for trying out a horizontally flipped variant of an
        existing map. The save endpoint protects against race-by-
        cached-tab by NOT auto-reloading; client must re-fetch."""
        from mirror_map_x import mirror as _mirror_level
        try:
            data = store.load(slug)
        except FileNotFoundError:
            abort(404)
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        try:
            level = level_from_json(data)
        except Exception as e:
            return jsonify({"error": f"load failed: {e}"}), 400
        _mirror_level(level)
        # Re-save through the normal storage path so both .UTE and
        # .json sidecar are kept in lock-step.
        body = level_to_json(level)
        # Preserve metadata that level_to_json may not carry forward.
        for k in ("name", "author", "description"):
            if k in data:
                body[k] = data[k]
        result = store.save(slug, body)
        return jsonify({
            "ok": True,
            "slug": slug,
            "entities": len(level.entities),
            "ute_size_bytes": result.get("ute_size_bytes", 0),
        })

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

    def _custom_char_path(idx: int) -> Path:
        return Path(app.config["CUSTOM_CHARS_DIR"]) / f"{idx}.dat"

    def _char_dimensions(idx: int) -> tuple[int, int]:
        """Width/height of frame `idx` per the source CHARS.PAK."""
        chars_cache._ensure_loaded()
        if not 0 <= idx < len(chars_cache._textures):
            raise IndexError(idx)
        t = chars_cache._textures[idx]
        return t.width, t.height

    def _load_char_pixels(idx: int) -> tuple[int, int, list[int]]:
        """Return (W, H, [argb1555 u16, ...]) for frame `idx`.
        Custom file takes precedence; falls back to source PAK."""
        w, h = _char_dimensions(idx)
        cp = _custom_char_path(idx)
        if cp.exists():
            raw = cp.read_bytes()
            if len(raw) != w * h * 2:
                # Stale custom file (W or H changed). Ignore + use source.
                pass
            else:
                pixels = [(raw[i*2] << 8) | raw[i*2+1] for i in range(w * h)]
                return w, h, pixels
        # Fall back to source PAK. We don't have ARGB-1555 ints cached
        # in TextureCache (it stores RGBA), so re-parse the PAK byte
        # range for this frame to recover the original u16 values.
        chars_cache._ensure_loaded()
        with open(chars_cache.pak_path, "rb") as f:
            data = f.read()
        # Walk frames up to idx; each frame is W(u16)+H(u16)+W*H*2 bytes.
        off = 0
        for i in range(idx + 1):
            fw = (data[off] << 8) | data[off+1]
            fh = (data[off+2] << 8) | data[off+3]
            off += 4
            if i == idx:
                pixels = [(data[off + j*2] << 8) | data[off + j*2 + 1]
                          for j in range(fw * fh)]
                return fw, fh, pixels
            off += fw * fh * 2
        raise IndexError(idx)

    def _save_char_pixels(idx: int, w: int, h: int, pixels: list[int]) -> int:
        """Persist a modified sprite as raw ARGB-1555 BE bytes.
        Returns the file size on disk."""
        if w * h != len(pixels):
            raise ValueError(f"pixel count mismatch: w*h={w*h} vs len={len(pixels)}")
        raw = bytearray(w * h * 2)
        for i, p in enumerate(pixels):
            v = int(p) & 0xFFFF
            raw[i*2]   = (v >> 8) & 0xFF
            raw[i*2+1] = v & 0xFF
        cp = _custom_char_path(idx)
        cp.parent.mkdir(parents=True, exist_ok=True)
        cp.write_bytes(bytes(raw))
        # Drop PNG cache so next /api/chars/<idx>.png reflects the edit.
        chars_cache._png_cache.pop(idx, None)
        return len(raw)

    def _custom_char_pixels_to_png(idx: int) -> bytes:
        """Render the CUSTOM file (not PAK) to PNG via pak_format helpers."""
        w, h, pixels = _load_char_pixels(idx)
        rgba = bytearray(w * h * 4)
        for i, p in enumerate(pixels):
            R, G, B, A = pak_format._argb1555_to_rgba(p)
            rgba[i*4]   = R
            rgba[i*4+1] = G
            rgba[i*4+2] = B
            rgba[i*4+3] = A
        return pak_format.encode_png(bytes(rgba), w, h)

    @app.route("/api/chars", methods=["GET"])
    def list_chars():
        """List all sprite frames in CHARS.PAK. The Saturn engine
        loads CHARS.PAK as 5 characters × 5 frames each = 25 sprites
        (per main.cxx: FramesPerController=5, num_characters=5).
        Frame layout per Player::Draw rotation logic:
          frame 0 = facing south (default)
          frame 1 = facing south-west / south-east
          frame 2 = facing north
          frame 3 = west / east
          frame 4 = dead/charred
        Each character row is 5 consecutive PAK indices.
        `customized` lists which indices have a saved edit."""
        custom_dir = Path(app.config["CUSTOM_CHARS_DIR"])
        customized = sorted(
            int(p.stem) for p in custom_dir.glob("*.dat")
            if p.stem.isdigit()
        )
        return jsonify({
            "pak_path":   chars_cache.pak_path,
            "count":      chars_cache.count,
            "characters": 5,
            "frames_per_character": 5,
            "frame_labels": ["south", "diagonal", "north", "side", "dead"],
            "textures":   chars_cache.info(),
            "customized": customized,
        })

    @app.route("/api/chars/<int:idx>.png", methods=["GET"])
    def char_png(idx: int):
        """Serve one character sprite frame as a PNG. If a custom
        version exists at custom_chars/<idx>.dat it's served instead
        of the original PAK frame."""
        cp = _custom_char_path(idx)
        from flask import Response
        try:
            if cp.exists():
                png = _custom_char_pixels_to_png(idx)
            else:
                png = chars_cache.png(idx)
        except IndexError:
            abort(404)
        # No long cache — custom edits invalidate immediately.
        return Response(png, mimetype="image/png",
                        headers={"Cache-Control": "no-cache"})

    @app.route("/api/chars/<int:idx>/pixels", methods=["GET"])
    def get_char_pixels(idx: int):
        """Return raw ARGB-1555 pixels (u16 BE per pixel) for frame
        `idx` as a JSON array of ints (length = W*H). Used by the
        sprite editor to populate the editable canvas."""
        try:
            w, h, pixels = _load_char_pixels(idx)
        except IndexError:
            abort(404)
        return jsonify({
            "index":  idx,
            "width":  w,
            "height": h,
            "pixels": pixels,
            "custom": _custom_char_path(idx).exists(),
        })

    @app.route("/api/chars/<int:idx>/pixels", methods=["POST"])
    def post_char_pixels(idx: int):
        """Save modified pixels for frame `idx`. Body: JSON
        {width, height, pixels:[argb1555 ints]}. Width/height MUST
        match the source PAK frame size (no resize support yet)."""
        if not _is_admin():
            abort(403)
        try:
            src_w, src_h = _char_dimensions(idx)
        except IndexError:
            abort(404)
        body = request.get_json(silent=True) or {}
        w = int(body.get("width", 0))
        h = int(body.get("height", 0))
        pixels = body.get("pixels", [])
        if w != src_w or h != src_h:
            return jsonify({"error":
                f"size {w}x{h} != source {src_w}x{src_h}"}), 400
        if len(pixels) != w * h:
            return jsonify({"error":
                f"pixels length {len(pixels)} != w*h={w*h}"}), 400
        bytes_written = _save_char_pixels(idx, w, h, pixels)
        return jsonify({"index": idx, "bytes": bytes_written, "saved": True})

    @app.route("/api/chars/<int:idx>/reset", methods=["POST"])
    def reset_char(idx: int):
        """Delete the custom override for frame `idx` so the original
        PAK pixels are served again."""
        if not _is_admin():
            abort(403)
        cp = _custom_char_path(idx)
        existed = cp.exists()
        if existed:
            cp.unlink()
            chars_cache._png_cache.pop(idx, None)
        return jsonify({"index": idx, "had_custom": existed, "reset": True})

    # Each Saturn pixel becomes a 16×16 block in the downloaded
    # template. With 16×16 source sprites, a single cell is 256×256
    # in the template; the full 5×5 sheet is 1280×1280. That gives
    # editors plenty of room and makes pixel boundaries obvious so
    # the download doesn't appear "blurry" in default image viewers.
    # The import path detects this scale and samples each block's
    # top-left to recover the Saturn pixel.
    TEMPLATE_SCALE = 16

    @app.route("/api/chars/template.png", methods=["GET"])
    def chars_template():
        """Build a 5×5 sheet PNG of all 25 sprite frames for the
        operator to download, edit, and re-upload.

        Layout (each Saturn pixel rendered as a 16×16 block):
            row    = character index (0..4)
            column = frame within character (0..4 = south/diagonal/north/side/dead)
            pak_idx = row*5 + column

        Transparent source pixels render as bright magenta so they're
        obvious in editors. The import path treats alpha<128 as
        transparent regardless of color — magenta is just a marker."""
        chars_cache._ensure_loaded()
        if not chars_cache._textures:
            abort(404)
        sx = TEMPLATE_SCALE
        cell_w = chars_cache._textures[0].width
        cell_h = chars_cache._textures[0].height
        cols, rows = 5, 5
        sheet_w = cols * cell_w * sx
        sheet_h = rows * cell_h * sx
        sheet = bytearray(sheet_w * sheet_h * 4)
        for ci in range(min(rows * cols, len(chars_cache._textures))):
            r = ci // cols
            c = ci % cols
            try:
                _, _, pixels = _load_char_pixels(ci)
            except IndexError:
                continue
            for py in range(cell_h):
                for px in range(cell_w):
                    p = pixels[py * cell_w + px]
                    R, G, B, A = pak_format._argb1555_to_rgba(p)
                    if A == 0:
                        rr, gg, bb, aa = 255, 0, 255, 0
                    else:
                        rr, gg, bb, aa = R, G, B, 255
                    base_x = (c * cell_w + px) * sx
                    base_y = (r * cell_h + py) * sx
                    for dy in range(sx):
                        di = ((base_y + dy) * sheet_w + base_x) * 4
                        for dx in range(sx):
                            sheet[di]   = rr
                            sheet[di+1] = gg
                            sheet[di+2] = bb
                            sheet[di+3] = aa
                            di += 4
        png = pak_format.encode_png(bytes(sheet), sheet_w, sheet_h)
        from flask import Response
        return Response(png, mimetype="image/png",
                        headers={
                            "Cache-Control": "no-cache",
                            "Content-Disposition":
                                f'attachment; filename="utenyaa-chars-template-{sheet_w}x{sheet_h}.png"',
                        })

    @app.route("/api/chars/import", methods=["POST"])
    def chars_import():
        """Accept a PNG sheet (5 cols × 5 rows) and save each cell as
        a custom override. Body: raw PNG bytes (Content-Type:
        image/png) OR multipart form with 'file' field.

        Auto-detects scale: native 1× (80×80, one PNG pixel per Saturn
        pixel) or 16× upscaled (1280×1280, one Saturn pixel per 16×16
        block — matches the /api/chars/template.png download). Other
        scales are rejected with a clear error.

        IMPORTANT: this writes to webapp/custom_chars/<idx>.dat — the
        SOURCE CHARS.PAK on disk is NEVER modified. The /api/chars/<idx>/
        reset endpoint deletes the override; /api/chars/reset_all clears
        every override at once. Originals are always recoverable."""
        if not _is_admin():
            abort(403)
        chars_cache._ensure_loaded()
        if not chars_cache._textures:
            return jsonify({"error": "CHARS.PAK not loaded"}), 500
        cell_w = chars_cache._textures[0].width
        cell_h = chars_cache._textures[0].height
        cols, rows = 5, 5

        # Accept either raw image/png body or a multipart form upload.
        data = b""
        if request.content_type and request.content_type.startswith("image/png"):
            data = request.get_data() or b""
        else:
            up = request.files.get("file")
            if up is not None:
                data = up.read() or b""
        if not data:
            return jsonify({"error": "no PNG data in request"}), 400

        try:
            w, h, rgba = pak_format.decode_png_rgba(data)
        except ValueError as e:
            return jsonify({"error": f"PNG decode failed: {e}"}), 400

        native_w = cols * cell_w
        native_h = rows * cell_h
        if w == native_w and h == native_h:
            block = 1
        elif w == native_w * TEMPLATE_SCALE and h == native_h * TEMPLATE_SCALE:
            block = TEMPLATE_SCALE
        else:
            return jsonify({
                "error":
                    f"sheet must be {native_w}x{native_h} (1×) or "
                    f"{native_w*TEMPLATE_SCALE}x{native_h*TEMPLATE_SCALE} "
                    f"({TEMPLATE_SCALE}× — the template download size); "
                    f"got {w}x{h}. Use /api/chars/template.png as a starting point."
            }), 400

        saved = []
        for ci in range(rows * cols):
            r = ci // cols
            c = ci % cols
            cell_rgba = bytearray(cell_w * cell_h * 4)
            # Sample the top-left pixel of each `block`x`block` block to
            # recover the Saturn-native pixel. The user's sprite editor
            # was instructed to use a 1-pixel pencil tool with no AA;
            # if they used smoothing/gradient tools the top-left sample
            # is the most predictable result (matches what they'd see
            # if they snapped their drawing to the nearest pixel grid).
            for py in range(cell_h):
                for px in range(cell_w):
                    sx = (c * cell_w + px) * block
                    sy = (r * cell_h + py) * block
                    src = (sy * w + sx) * 4
                    di = (py * cell_w + px) * 4
                    cell_rgba[di]   = rgba[src]
                    cell_rgba[di+1] = rgba[src+1]
                    cell_rgba[di+2] = rgba[src+2]
                    cell_rgba[di+3] = rgba[src+3]
            pixels = pak_format.rgba8_to_argb1555(bytes(cell_rgba), cell_w, cell_h)
            _save_char_pixels(ci, cell_w, cell_h, pixels)
            saved.append(ci)
        return jsonify({"saved": saved, "count": len(saved),
                        "sheet": f"{w}x{h}", "cell": f"{cell_w}x{cell_h}",
                        "scale": block,
                        "originals_preserved": True})

    # ------------------------------------------------------------------
    # Custom CHARACTERS — full named characters (5 frames each) authored
    # by users and saved with name + creator metadata, parallel to the
    # maps/ directory. Saturn-side download flow + lobby integration is
    # Phase B/C/D — for now the editor stores these so users can author
    # and the catalog is ready when Saturn-side delivery lands.
    # ------------------------------------------------------------------

    CUSTOM_CHAR_SCHEMA_VERSION = 1
    CUSTOM_CHAR_FRAMES = 5    # matches Saturn engine FramesPerController
    CUSTOM_CHAR_W = 16        # all CHARS.PAK frames are 16x16
    CUSTOM_CHAR_H = 16

    def _custom_character_path(slug: str) -> Path:
        return Path(app.config["CUSTOM_CHARACTERS_DIR"]) / f"{slug}.json"

    def _validate_char_slug(slug: str) -> str | None:
        """Returns error string if slug is bad, else None. Slugs must be
        [a-z0-9_-]+ and 1..32 chars; reject anything that could escape
        the dir (.., /, \\)."""
        if not slug or len(slug) > 32:
            return "slug must be 1..32 chars"
        for c in slug:
            if not (c.isalnum() or c in "-_") or c.isupper():
                return "slug must match [a-z0-9_-]+"
        return None

    @app.route("/api/custom_chars", methods=["GET"])
    def list_custom_characters():
        """List all saved custom characters with metadata thumbnails.
        Body: {characters: [{slug, name, creator, modified}]}"""
        d = Path(app.config["CUSTOM_CHARACTERS_DIR"])
        out = []
        for jf in sorted(d.glob("*.json")):
            try:
                data = json.loads(jf.read_text())
            except (OSError, ValueError):
                continue
            out.append({
                "slug":     jf.stem,
                "name":     data.get("name") or jf.stem,
                "creator":  data.get("creator") or "",
                "modified": data.get("modified") or "",
            })
        return jsonify({"characters": out})

    @app.route("/api/custom_chars/<slug>", methods=["GET"])
    def get_custom_character(slug):
        err = _validate_char_slug(slug)
        if err: return jsonify({"error": err}), 400
        path = _custom_character_path(slug)
        if not path.exists(): abort(404)
        try:
            data = json.loads(path.read_text())
        except ValueError as e:
            return jsonify({"error": f"corrupt: {e}"}), 500
        return jsonify(data)

    @app.route("/api/custom_chars/<slug>", methods=["POST"])
    def save_custom_character(slug):
        """Save a custom character. Body:
            {name: string, creator: string,
             frames: [[<256 argb1555 ints>], ...5 frames]}
        Validates dimensions and pixel ranges."""
        if not _is_admin():
            abort(403)
        err = _validate_char_slug(slug)
        if err: return jsonify({"error": err}), 400
        body = request.get_json(silent=True) or {}
        name = (body.get("name") or "").strip()
        if not name:
            return jsonify({"error": "name required"}), 400
        creator = (body.get("creator") or "").strip()
        frames = body.get("frames") or []
        if (not isinstance(frames, list)
            or len(frames) != CUSTOM_CHAR_FRAMES):
            return jsonify({
                "error": f"frames must be {CUSTOM_CHAR_FRAMES} arrays"
            }), 400
        npix = CUSTOM_CHAR_W * CUSTOM_CHAR_H
        for fi, fr in enumerate(frames):
            if not isinstance(fr, list) or len(fr) != npix:
                return jsonify({
                    "error":
                        f"frame {fi}: expected {npix} pixels, "
                        f"got {len(fr) if isinstance(fr, list) else type(fr).__name__}"
                }), 400
            for v in fr:
                if not isinstance(v, int) or not (0 <= v <= 0xFFFF):
                    return jsonify({
                        "error":
                            f"frame {fi}: pixel values must be 0..65535 ints"
                    }), 400

        from datetime import datetime, timezone
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        path = _custom_character_path(slug)
        prior = {}
        if path.exists():
            try: prior = json.loads(path.read_text())
            except ValueError: prior = {}
        record = {
            "schema_version": CUSTOM_CHAR_SCHEMA_VERSION,
            "slug":     slug,
            "name":     name,
            "creator":  creator,
            "width":    CUSTOM_CHAR_W,
            "height":   CUSTOM_CHAR_H,
            "frames":   [list(fr) for fr in frames],
            "created":  prior.get("created") or now,
            "modified": now,
        }
        path.write_text(json.dumps(record))
        return jsonify({"saved": True, "slug": slug,
                        "name": name, "creator": creator})

    @app.route("/api/custom_chars/<slug>", methods=["DELETE"])
    def delete_custom_character(slug):
        if not _is_admin():
            abort(403)
        err = _validate_char_slug(slug)
        if err: return jsonify({"error": err}), 400
        path = _custom_character_path(slug)
        if not path.exists():
            return jsonify({"error": "not found"}), 404
        path.unlink()
        return jsonify({"deleted": True, "slug": slug})

    @app.route("/api/custom_chars/<slug>/frame/<int:frame>.png",
               methods=["GET"])
    def custom_character_frame_png(slug, frame):
        """Serve one frame of a saved custom character as a PNG."""
        err = _validate_char_slug(slug)
        if err: abort(400)
        if not 0 <= frame < CUSTOM_CHAR_FRAMES: abort(404)
        path = _custom_character_path(slug)
        if not path.exists(): abort(404)
        try:
            data = json.loads(path.read_text())
        except ValueError:
            abort(500)
        frames = data.get("frames") or []
        if frame >= len(frames): abort(404)
        pixels = frames[frame]
        w, h = data.get("width", CUSTOM_CHAR_W), data.get("height", CUSTOM_CHAR_H)
        rgba = bytearray(w * h * 4)
        for i, p in enumerate(pixels):
            R, G, B, A = pak_format._argb1555_to_rgba(p)
            rgba[i*4]   = R
            rgba[i*4+1] = G
            rgba[i*4+2] = B
            rgba[i*4+3] = A
        png = pak_format.encode_png(bytes(rgba), w, h)
        from flask import Response
        return Response(png, mimetype="image/png",
                        headers={"Cache-Control": "no-cache"})

    @app.route("/api/custom_chars/template.png", methods=["GET"])
    def custom_character_blank_template():
        """Single-character blank template — 5 frames horizontal,
        rendered at 16× scale (1280×256) with magenta transparency
        markers on every pixel. Ready for the user to paint in any
        image editor and re-upload via /api/custom_chars/<slug>/import."""
        sx = TEMPLATE_SCALE
        cell_w, cell_h = CUSTOM_CHAR_W, CUSTOM_CHAR_H
        cols, rows = CUSTOM_CHAR_FRAMES, 1
        sheet_w = cols * cell_w * sx
        sheet_h = rows * cell_h * sx
        sheet = bytearray(sheet_w * sheet_h * 4)
        # Fill with magenta (transparency marker).
        for i in range(0, len(sheet), 4):
            sheet[i] = 255; sheet[i+1] = 0; sheet[i+2] = 255; sheet[i+3] = 0
        # Draw faint cell borders so users see frame boundaries.
        for ci in range(cols):
            for py in range(0, sheet_h):
                bx = ci * cell_w * sx
                bi = (py * sheet_w + bx) * 4
                sheet[bi]   = 64; sheet[bi+1] = 64; sheet[bi+2] = 64; sheet[bi+3] = 255
        png = pak_format.encode_png(bytes(sheet), sheet_w, sheet_h)
        from flask import Response
        return Response(png, mimetype="image/png",
                        headers={
                            "Cache-Control": "no-cache",
                            "Content-Disposition":
                                'attachment; filename="utenyaa-custom-character-template.png"',
                        })

    @app.route("/api/custom_chars/<slug>/template.png", methods=["GET"])
    def custom_character_template(slug):
        """5-frame horizontal strip template for editing an EXISTING
        custom character. 16× scale (1280×256). Each Saturn pixel
        becomes a 16×16 block. Same transparency-marker convention
        as the bulk template."""
        err = _validate_char_slug(slug)
        if err: abort(400)
        path = _custom_character_path(slug)
        if not path.exists(): abort(404)
        try:
            data = json.loads(path.read_text())
        except ValueError:
            abort(500)
        frames = data.get("frames") or []
        sx = TEMPLATE_SCALE
        cell_w, cell_h = CUSTOM_CHAR_W, CUSTOM_CHAR_H
        cols, rows = CUSTOM_CHAR_FRAMES, 1
        sheet_w = cols * cell_w * sx
        sheet_h = rows * cell_h * sx
        sheet = bytearray(sheet_w * sheet_h * 4)
        for fi in range(min(cols, len(frames))):
            pixels = frames[fi]
            for py in range(cell_h):
                for px in range(cell_w):
                    p = pixels[py * cell_w + px] if py * cell_w + px < len(pixels) else 0
                    R, G, B, A = pak_format._argb1555_to_rgba(p)
                    if A == 0:
                        rr, gg, bb, aa = 255, 0, 255, 0
                    else:
                        rr, gg, bb, aa = R, G, B, 255
                    base_x = (fi * cell_w + px) * sx
                    base_y = py * sx
                    for dy in range(sx):
                        di = ((base_y + dy) * sheet_w + base_x) * 4
                        for dx in range(sx):
                            sheet[di]   = rr
                            sheet[di+1] = gg
                            sheet[di+2] = bb
                            sheet[di+3] = aa
                            di += 4
        png = pak_format.encode_png(bytes(sheet), sheet_w, sheet_h)
        from flask import Response
        return Response(png, mimetype="image/png",
                        headers={
                            "Cache-Control": "no-cache",
                            "Content-Disposition":
                                f'attachment; filename="utenyaa-custom-{slug}-template.png"',
                        })

    @app.route("/api/custom_chars/<slug>/import", methods=["POST"])
    def custom_character_import(slug):
        """Upload a 5-frame strip PNG to overwrite a custom character's
        sprite frames. Accepts native (80×16) or 16× (1280×256).
        Body: image/png. Form field 'name' / 'creator' optional —
        if present they update the metadata; otherwise prior values
        retained (for new characters, name defaults to slug).

        IMPORTANT: This OVERRIDES the named custom character. The
        built-in CHARS.PAK is never modified by this endpoint."""
        if not _is_admin():
            abort(403)
        err = _validate_char_slug(slug)
        if err: return jsonify({"error": err}), 400

        # Accept name/creator from query string (works with both raw
        # PNG body and multipart) — body is the image data.
        name = (request.args.get("name") or "").strip()
        creator = (request.args.get("creator") or "").strip()

        cell_w, cell_h = CUSTOM_CHAR_W, CUSTOM_CHAR_H
        cols, rows = CUSTOM_CHAR_FRAMES, 1

        # Body: raw image/png OR multipart 'file'
        data = b""
        if request.content_type and request.content_type.startswith("image/png"):
            data = request.get_data() or b""
        else:
            up = request.files.get("file")
            if up is not None:
                data = up.read() or b""
        if not data:
            return jsonify({"error": "no PNG data"}), 400
        try:
            w, h, rgba = pak_format.decode_png_rgba(data)
        except ValueError as e:
            return jsonify({"error": f"PNG decode: {e}"}), 400

        nat_w, nat_h = cols * cell_w, rows * cell_h
        if w == nat_w and h == nat_h:
            block = 1
        elif w == nat_w * TEMPLATE_SCALE and h == nat_h * TEMPLATE_SCALE:
            block = TEMPLATE_SCALE
        else:
            return jsonify({
                "error":
                    f"strip must be {nat_w}x{nat_h} (1×) or "
                    f"{nat_w*TEMPLATE_SCALE}x{nat_h*TEMPLATE_SCALE} "
                    f"({TEMPLATE_SCALE}×); got {w}x{h}"
            }), 400

        frames = []
        for fi in range(cols):
            cell_rgba = bytearray(cell_w * cell_h * 4)
            for py in range(cell_h):
                for px in range(cell_w):
                    sx = (fi * cell_w + px) * block
                    sy = py * block
                    src = (sy * w + sx) * 4
                    di = (py * cell_w + px) * 4
                    cell_rgba[di]   = rgba[src]
                    cell_rgba[di+1] = rgba[src+1]
                    cell_rgba[di+2] = rgba[src+2]
                    cell_rgba[di+3] = rgba[src+3]
            pixels = pak_format.rgba8_to_argb1555(bytes(cell_rgba),
                                                  cell_w, cell_h)
            frames.append(pixels)

        # Reuse save endpoint logic for metadata upsert
        path = _custom_character_path(slug)
        prior = {}
        if path.exists():
            try: prior = json.loads(path.read_text())
            except ValueError: prior = {}
        if not name: name = prior.get("name") or slug
        if not creator: creator = prior.get("creator") or ""
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        record = {
            "schema_version": CUSTOM_CHAR_SCHEMA_VERSION,
            "slug": slug, "name": name, "creator": creator,
            "width": cell_w, "height": cell_h,
            "frames": frames,
            "created": prior.get("created") or now,
            "modified": now,
        }
        path.write_text(json.dumps(record))
        return jsonify({"saved": True, "slug": slug, "name": name,
                        "creator": creator,
                        "imported_from": f"{w}x{h}", "scale": block})

    @app.route("/api/chars/reset_all", methods=["POST"])
    def reset_all_chars():
        """Wipe ALL custom sprite overrides at once. Restores the
        original CHARS.PAK pixels for every frame. The source PAK on
        disk is never touched; this just deletes the override files."""
        if not _is_admin():
            abort(403)
        custom_dir = Path(app.config["CUSTOM_CHARS_DIR"])
        deleted = 0
        for p in custom_dir.glob("*.dat"):
            if p.stem.isdigit():
                p.unlink(missing_ok=True)
                deleted += 1
        chars_cache._png_cache.clear()
        return jsonify({"deleted": deleted, "reset": True})

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
