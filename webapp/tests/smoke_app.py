"""smoke_app.py — end-to-end Flask app smoke test.

Boots the Flask app via test_client() (no real socket), exercises every
endpoint with realistic payloads, and asserts shape.
"""
import os
import sys
import tempfile
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, "..")))

from app import create_app


def main():
    tmp = tempfile.mkdtemp(prefix="utewme_smoke_")
    try:
        app = create_app(tmp)
        c = app.test_client()

        # health
        r = c.get("/api/health")
        assert r.status_code == 200, r.get_json()
        assert r.get_json()["ok"] is True

        # format-info
        r = c.get("/api/format-info")
        assert r.status_code == 200
        assert r.get_json()["fixed_prefix_size"] == 9624

        # slugify
        r = c.get("/api/slugify?name=Hello%20World!")
        assert r.get_json()["slug"] == "hello-world"

        # empty list
        assert c.get("/api/maps").get_json() == {"maps": []}

        # static
        assert c.get("/").status_code == 200
        assert b"Utenyaa Map Editor" in c.get("/").data
        assert c.get("/static/editor.js").status_code == 200
        assert c.get("/static/editor.css").status_code == 200

        # save a valid map
        valid = {
            "schema_version": 1,
            "meta": {"name": "smoke", "author": "tester"},
            "light": {"direction": [0, 0, -65536], "color": 0x8000, "reserved": 0},
            "tiles":   [{"raw": 0, "texture": 0, "dummy": 0} for _ in range(400)],
            "gourad":  [[0xFFFF] * 4 for _ in range(400)],
            "normals": [[0, 0, 0x10000] for _ in range(400)],
            "entities": [
                {"type": "player_spawn", "x": 5,  "y": 5,  "direction": 0, "reserved": [0]*16},
                {"type": "player_spawn", "x": 14, "y": 14, "direction": 0, "reserved": [0]*16},
                {"type": "crate",        "x": 10, "y": 10, "direction": 0,
                 "reserved": [0x07] + [0] * 15},
            ],
        }
        r = c.post("/api/maps/smoke", json=valid)
        assert r.status_code == 200, (r.status_code, r.get_json())
        body = r.get_json()
        assert body["ute_size_bytes"] == 9624 + 3 * 28
        assert body["errors"] == []

        # listing now non-empty
        listing = c.get("/api/maps").get_json()
        assert any(m["slug"] == "smoke" for m in listing["maps"])

        # download .UTE
        ute_resp = c.get("/api/maps/smoke/ute")
        assert ute_resp.status_code == 200
        assert ute_resp.data[:4] == b"UTE\x00"
        assert len(ute_resp.data) == 9624 + 3 * 28

        # round-trip via load
        loaded = c.get("/api/maps/smoke").get_json()
        assert loaded["meta"]["name"] == "smoke"
        assert len(loaded["entities"]) == 3

        # validate-only with valid map
        r = c.post("/api/validate", json=valid)
        body = r.get_json()
        assert body["errors"] == []
        assert body["ute_size_bytes"] == 9624 + 3 * 28

        # bad map: 0 spawns -> 400
        bad = dict(valid)
        bad["entities"] = []
        r = c.post("/api/maps/badmap", json=bad)
        assert r.status_code == 400
        assert "errors" in r.get_json()
        assert r.get_json()["error"] == "validation_failed"

        # delete
        r = c.delete("/api/maps/smoke")
        assert r.status_code == 200
        assert c.get("/api/maps/smoke").status_code == 404

        # path-traversal slug rejected
        r = c.get("/api/maps/..%2F..%2Fetc%2Fpasswd")
        assert r.status_code in (400, 404)

        print("All smoke checks passed.")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
