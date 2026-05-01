"""seed_reference_maps.py — populate webapp/maps/ with the 4 production
stages so they show up in the editor's Load dialog. Useful for first-run
demos and as a baseline for derivative maps."""

import os
import sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, "..")))

import ute_format
import storage

REF_DIR = os.path.normpath(os.path.join(HERE, "..", "..", "reference_maps"))
MAPS_DIR = os.path.normpath(os.path.join(HERE, "..", "maps"))

REF_MAPS = [
    ("ISLAND.UTE",  "Island",  "ReyeMe / robertoduarte"),
    ("CROSS.UTE",   "Cross",   "ReyeMe / robertoduarte"),
    ("VALLEY.UTE",  "Valley",  "ReyeMe / robertoduarte"),
    ("RAILWAY.UTE", "Railway", "ReyeMe / robertoduarte"),
]


def main():
    store = storage.MapStore(MAPS_DIR)
    for fname, display_name, author in REF_MAPS:
        src = os.path.join(REF_DIR, fname)
        if not os.path.exists(src):
            print(f"  SKIP {fname} (not found at {src})")
            continue
        with open(src, "rb") as f:
            level_data = ute_format.parse(f.read())
        slug = storage.slugify(display_name)
        json_data = storage.level_to_json(level_data, meta={
            "name": display_name,
            "author": author,
            "description": f"Original Utenyaa stage (imported from {fname})",
        })
        result = store.save(slug, json_data)
        print(f"  seeded {slug}: {result['ute_size_bytes']} B .UTE")


if __name__ == "__main__":
    main()
