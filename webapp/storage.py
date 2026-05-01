"""
storage.py — Filesystem-backed map storage.

Each map is stored as two files in webapp/maps/:
    <slug>.json    — editor-side representation (tiles, entities, metadata)
    <slug>.UTE     — engine-loadable binary, generated from the JSON

The JSON form is the authoritative editor source so users can re-edit
without fidelity loss. The .UTE is regenerated on every save and is
what gets served to the Saturn client (when wiring is added later).

slug = lowercase alphanumeric + dashes, derived from the map name.
"""

from __future__ import annotations
import json
import os
import re
import time
from pathlib import Path
from typing import Dict, List, Optional

import ute_format
from ute_format import (
    LevelData, Tile, FxVector, LevelLight, Gourad, Entity,
    TILE_COUNT, MAP_DIMENSION,
    ENTITY_TYPE_NAMES, ENTITY_TYPE_FROM_NAME,
)


_SLUG_RE = re.compile(r"[^a-z0-9-]+")


def slugify(name: str) -> str:
    """Convert a map name into a filesystem-safe slug.

    Letters lowercased, runs of non-alnum collapsed to '-', stripped.
    Empty result yields 'map' so we always have a non-empty filename."""
    s = name.strip().lower()
    s = _SLUG_RE.sub("-", s)
    s = s.strip("-")
    return s or "map"


# ----------------------------------------------------------------------------
# JSON ↔ LevelData conversion
# ----------------------------------------------------------------------------

def level_to_json(L: LevelData, meta: Optional[Dict] = None) -> Dict:
    """Serialize a LevelData (plus optional metadata) to a JSON-safe dict."""
    return {
        "schema_version": 1,
        "meta": meta or {},
        "light": {
            "direction": [L.light.direction.x, L.light.direction.y, L.light.direction.z],
            "color": L.light.color,
            "reserved": L.light.reserved,
        },
        "tiles": [
            {"raw": t.raw, "texture": t.texture, "dummy": t.dummy}
            for t in L.tiles
        ],
        "gourad": [list(g.colors) for g in L.gourad],
        "normals": [[n.x, n.y, n.z] for n in L.normals],
        "entities": [
            {
                "type": ENTITY_TYPE_NAMES.get(e.type, str(e.type)),
                "type_id": e.type,
                "x": e.x,
                "y": e.y,
                "direction": e.direction,
                "reserved": list(e.reserved),
            }
            for e in L.entities
        ],
    }


def level_from_json(d: Dict) -> LevelData:
    """Reverse of level_to_json. Tolerant of missing optional fields."""
    if d.get("schema_version") not in (None, 1):
        raise ValueError(f"unsupported schema_version: {d.get('schema_version')}")

    light_d = d.get("light", {})
    direction = light_d.get("direction", [0, 0, 0])
    light = LevelLight(
        direction=FxVector(x=int(direction[0]), y=int(direction[1]), z=int(direction[2])),
        color=int(light_d.get("color", 0)),
        reserved=int(light_d.get("reserved", 0)),
    )

    tiles_d = d.get("tiles", [])
    tiles = []
    for i in range(TILE_COUNT):
        if i < len(tiles_d):
            t = tiles_d[i]
            tiles.append(Tile(
                raw=int(t.get("raw", 0)),
                texture=int(t.get("texture", 0)),
                dummy=int(t.get("dummy", 0)),
            ))
        else:
            tiles.append(Tile())

    gourad_d = d.get("gourad", [])
    gourad = []
    for i in range(TILE_COUNT):
        if i < len(gourad_d):
            cs = gourad_d[i]
            gourad.append(Gourad(colors=tuple(int(c) for c in cs[:4])))
        else:
            gourad.append(Gourad())

    normals_d = d.get("normals", [])
    normals = []
    for i in range(TILE_COUNT):
        if i < len(normals_d):
            n = normals_d[i]
            normals.append(FxVector(x=int(n[0]), y=int(n[1]), z=int(n[2])))
        else:
            normals.append(FxVector(z=0x10000))   # default up-vector

    entities = []
    for ed in d.get("entities", []):
        # Accept either type_id (int) or type (string name)
        if "type_id" in ed:
            type_id = int(ed["type_id"])
        else:
            type_id = ENTITY_TYPE_FROM_NAME.get(ed.get("type", "empty"), 0)
        reserved = bytes(ed.get("reserved", [0] * 16))
        if len(reserved) != 16:
            # Pad/truncate to 16
            reserved = (bytes(reserved) + bytes(16))[:16]
        entities.append(Entity(
            type=type_id,
            x=int(ed.get("x", 0)),
            y=int(ed.get("y", 0)),
            direction=int(ed.get("direction", 0)),
            reserved=reserved,
        ))

    return LevelData(tiles=tiles, light=light, gourad=gourad,
                     normals=normals, entities=entities)


# ----------------------------------------------------------------------------
# Filesystem storage
# ----------------------------------------------------------------------------

class MapStore:
    """Manage maps under a single directory. Cross-platform via pathlib."""

    def __init__(self, root: os.PathLike):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _json_path(self, slug: str) -> Path:
        return self.root / f"{slug}.json"

    def _ute_path(self, slug: str) -> Path:
        return self.root / f"{slug}.UTE"

    def _safe_slug(self, slug: str) -> str:
        """Disallow path traversal."""
        if not re.match(r"^[a-z0-9][a-z0-9-]{0,63}$", slug):
            raise ValueError(f"invalid slug: {slug!r}")
        return slug

    def list_maps(self) -> List[Dict]:
        """Return list of {slug, name, author, updated_at, size_bytes}."""
        out = []
        for p in sorted(self.root.glob("*.json")):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    data = json.load(f)
                meta = data.get("meta", {})
                ute = self._ute_path(p.stem)
                out.append({
                    "slug":       p.stem,
                    "name":       meta.get("name", p.stem),
                    "author":     meta.get("author", ""),
                    "description": meta.get("description", ""),
                    "updated_at": meta.get("updated_at", 0),
                    "size_bytes": ute.stat().st_size if ute.exists() else 0,
                })
            except (OSError, json.JSONDecodeError, KeyError):
                continue
        return out

    def load(self, slug: str) -> Dict:
        """Read the JSON form. Raises FileNotFoundError if missing."""
        slug = self._safe_slug(slug)
        with open(self._json_path(slug), "r", encoding="utf-8") as f:
            return json.load(f)

    def load_level(self, slug: str) -> LevelData:
        """Read JSON and convert to LevelData."""
        return level_from_json(self.load(slug))

    def save(self, slug: str, level_json: Dict) -> Dict:
        """Write the JSON form AND regenerate the .UTE binary.

        Returns a dict with {slug, ute_size_bytes}.
        """
        slug = self._safe_slug(slug)
        # Stamp updated_at
        meta = level_json.setdefault("meta", {})
        meta["updated_at"] = int(time.time())

        # Regenerate .UTE
        L = level_from_json(level_json)
        ute_bytes = ute_format.serialize(L)

        # Write JSON first, then UTE — atomic on Linux/Windows via rename
        json_path = self._json_path(slug)
        ute_path = self._ute_path(slug)
        json_tmp = json_path.with_suffix(".json.tmp")
        ute_tmp = ute_path.with_suffix(".UTE.tmp")

        with open(json_tmp, "w", encoding="utf-8") as f:
            json.dump(level_json, f, indent=2)
        with open(ute_tmp, "wb") as f:
            f.write(ute_bytes)

        os.replace(json_tmp, json_path)
        os.replace(ute_tmp, ute_path)

        return {"slug": slug, "ute_size_bytes": len(ute_bytes)}

    def delete(self, slug: str) -> bool:
        slug = self._safe_slug(slug)
        removed = False
        for p in (self._json_path(slug), self._ute_path(slug)):
            if p.exists():
                p.unlink()
                removed = True
        return removed

    def get_ute_bytes(self, slug: str) -> bytes:
        slug = self._safe_slug(slug)
        with open(self._ute_path(slug), "rb") as f:
            return f.read()
