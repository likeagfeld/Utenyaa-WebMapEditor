#!/usr/bin/env python3
"""Mirror a saved .UTE map across its X axis.

Use case: when the editor's display orientation was wrong, maps
authored in the broken view have entity/tile X coordinates that
don't reflect the author's intent. Running this once flips:

  - Each row of TileData[20×20] is reversed (slot (x, y) ↔ (19-x, y))
  - Each entity's e.x becomes (MAP_DIMENSION - 1 - e.x)
  - Each row of Gourad[20×20] is reversed (per-tile lighting follows
    the tile it's painted on)
  - Each row of Normals[20×20] is reversed AND each normal's X
    component is negated (face-normal vectors flip on mirror)

Usage:  mirror_map_x.py <slug>
        — reads/writes <slug>.UTE in UTENYAA_MAPS_DIR plus its sidecar.

Idempotent if you run it twice (mirroring twice = identity).
"""
from __future__ import annotations
import sys
import os
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import ute_format
from ute_format import (
    parse, serialize, MAP_DIMENSION, FxVector,
)
from storage import MapStore


def mirror(level):
    n = MAP_DIMENSION
    # Reverse each row of tiles
    new_tiles = list(level.tiles)
    for y in range(n):
        new_tiles[y * n : y * n + n] = list(reversed(new_tiles[y * n : y * n + n]))
    level.tiles = new_tiles

    # Reverse each row of gourad colors (lighting follows the tile)
    new_g = list(level.gourad)
    for y in range(n):
        new_g[y * n : y * n + n] = list(reversed(new_g[y * n : y * n + n]))
    level.gourad = new_g

    # Reverse each row of normals AND negate the X component
    new_n = list(level.normals)
    for y in range(n):
        new_n[y * n : y * n + n] = list(reversed(new_n[y * n : y * n + n]))
    # Then flip normal.x sign (mirror across X axis flips X component
    # of the normal vector — otherwise terrain lighting is wrong)
    flipped = []
    for v in new_n:
        flipped.append(FxVector(-v.x, v.y, v.z))
    level.normals = flipped

    # Mirror entity X coordinates
    for e in level.entities:
        e.x = (n - 1) - e.x


def main():
    if len(sys.argv) != 2:
        print("usage: mirror_map_x.py <slug>", file=sys.stderr)
        sys.exit(2)
    slug = sys.argv[1]
    maps_dir = os.environ.get(
        "UTENYAA_MAPS_DIR",
        str(HERE / "maps"))
    store = MapStore(maps_dir)

    # Find the .UTE
    candidates = [
        Path(maps_dir) / f"{slug.upper()}.UTE",
        Path(maps_dir) / f"{slug}.UTE",
        Path(maps_dir) / f"{slug}.ute",
    ]
    ute_path = None
    for p in candidates:
        if p.is_file():
            ute_path = p
            break
    if ute_path is None:
        print(f"no .UTE found for slug={slug!r} in {maps_dir}", file=sys.stderr)
        sys.exit(1)

    raw = ute_path.read_bytes()
    print(f"loaded {ute_path.name}: {len(raw)} bytes")
    level = parse(raw)
    mirror(level)
    out = serialize(level)
    print(f"mirrored: {len(out)} bytes (entities: {len(level.entities)})")

    # Backup the original before overwriting
    backup_path = ute_path.with_suffix(ute_path.suffix + ".pre_mirror_bak")
    if not backup_path.exists():
        backup_path.write_bytes(raw)
        print(f"backup saved: {backup_path.name}")
    ute_path.write_bytes(out)
    print(f"wrote: {ute_path.name}")

    # Also rewrite the JSON sidecar so the editor opens the mirrored map.
    json_path = ute_path.with_suffix(".json")
    if json_path.is_file():
        # Use storage.level_to_json to keep the editor-facing schema stable.
        from storage import level_to_json
        sidecar = level_to_json(level)
        # Preserve metadata (name, author, description, updated_at)
        try:
            old = json.loads(json_path.read_text())
            for k in ("name", "author", "description", "updated_at"):
                if k in old:
                    sidecar[k] = old[k]
        except Exception:
            pass
        json_backup = json_path.with_suffix(".json.pre_mirror_bak")
        if not json_backup.exists():
            json_backup.write_text(json_path.read_text())
        json_path.write_text(json.dumps(sidecar, indent=2))
        print(f"wrote: {json_path.name}")


if __name__ == "__main__":
    main()
