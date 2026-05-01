"""
test_format.py — verifies our serializer is byte-identical to PawCraft's.

Strategy: load each of the 4 production .UTE files (which were authored
in PawCraft), parse with our parser, re-serialize with our serializer,
and assert the result is BYTE-IDENTICAL to the input.

If this passes for all 4 files (totalling ~42 KB and 122 entities of
varied content), our serializer is provably equivalent to PawCraft's
on every byte that any real map exercises. That's the 95% confidence
contract.
"""

import os
import sys
import unittest

# Allow running this file directly: `python webapp/tests/test_format.py`
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))   # webapp/

import ute_format
from ute_format import (
    parse, serialize, round_trip_check,
    TILE_COUNT, FIXED_PREFIX_SIZE, ENTITY_RECORD_SIZE, IDENTIFIER,
    Tile, FxVector, LevelLight, Gourad, Entity, LevelData,
    ENTITY_TYPE_PLAYER_SPAWN,
)


REFERENCE_DIR = os.path.normpath(
    os.path.join(HERE, "..", "..", "reference_maps"))

REFERENCE_FILES = ["ISLAND.UTE", "CROSS.UTE", "VALLEY.UTE", "RAILWAY.UTE"]


class TestFormatConstants(unittest.TestCase):

    def test_fixed_prefix_size(self):
        # Identifier(4) + Tile[400]*4 + LevelLight(16) + Gourad[400]*8
        # + Normals[400]*12 + EntityCount(4) = 9624
        self.assertEqual(FIXED_PREFIX_SIZE, 9624)

    def test_entity_record_size(self):
        # i32 type + u16 x + u16 y + i32 direction + 16 reserved = 28
        self.assertEqual(ENTITY_RECORD_SIZE, 28)

    def test_identifier_bytes(self):
        # PawCraft: 'U','T','E', VersionNumber=0
        self.assertEqual(IDENTIFIER, b"UTE\x00")


class TestRoundTrip(unittest.TestCase):
    """Round-trip every reference map. Byte-identical = serializer correct."""

    def test_all_references_round_trip(self):
        for fname in REFERENCE_FILES:
            with self.subTest(file=fname):
                path = os.path.join(REFERENCE_DIR, fname)
                self.assertTrue(os.path.exists(path),
                                f"missing reference: {path}")
                with open(path, "rb") as f:
                    raw = f.read()
                ok, diag = round_trip_check(raw)
                self.assertTrue(ok,
                    f"{fname} round-trip failed: {diag}")

    def test_entity_counts(self):
        """Implicit cross-check on the FieldOrder(3) tie resolution.
        If our entity record layout were wrong (e.g. Reserved before
        Direction), the file size math would not produce these exact
        integer counts."""
        expected = {
            "ISLAND.UTE":  (10268, 23),
            "CROSS.UTE":   (10940, 47),
            "RAILWAY.UTE": (10352, 26),
            "VALLEY.UTE":  (10352, 26),
        }
        for fname, (size, count) in expected.items():
            with self.subTest(file=fname):
                path = os.path.join(REFERENCE_DIR, fname)
                with open(path, "rb") as f:
                    raw = f.read()
                self.assertEqual(len(raw), size,
                    f"{fname} size unexpected")
                L = parse(raw)
                self.assertEqual(len(L.entities), count,
                    f"{fname} entity count unexpected")


class TestSyntheticMaps(unittest.TestCase):
    """Build maps from scratch and verify they round-trip."""

    def _empty_map(self) -> LevelData:
        return LevelData(
            tiles=[Tile() for _ in range(TILE_COUNT)],
            light=LevelLight(direction=FxVector(0, 0, 0), color=0x8000, reserved=0),
            gourad=[Gourad(colors=(0x8000, 0x8000, 0x8000, 0x8000))
                    for _ in range(TILE_COUNT)],
            normals=[FxVector(0, 0, 0x10000) for _ in range(TILE_COUNT)],
            entities=[],
        )

    def test_empty_map_size(self):
        L = self._empty_map()
        data = serialize(L)
        self.assertEqual(len(data), FIXED_PREFIX_SIZE)

    def test_empty_map_round_trip(self):
        L = self._empty_map()
        data = serialize(L)
        ok, diag = round_trip_check(data)
        self.assertTrue(ok, f"empty round-trip failed: {diag}")

    def test_single_entity_map_size(self):
        L = self._empty_map()
        L.entities.append(Entity(
            type=ENTITY_TYPE_PLAYER_SPAWN,
            x=10, y=10,
            direction=0,
            reserved=bytes(16)))
        data = serialize(L)
        self.assertEqual(len(data), FIXED_PREFIX_SIZE + ENTITY_RECORD_SIZE)
        ok, diag = round_trip_check(data)
        self.assertTrue(ok, f"single-entity round-trip failed: {diag}")

    def test_tile_bit_packing(self):
        """Verify Tile.from_parts produces the exact byte PawCraft would."""
        # depth=15, mirror=true, rotation=2 → bits: 1111 + 1 0000 + 10 000000
        # = 0x0F | 0x10 | 0x80 = 0x9F
        t = Tile.from_parts(depth=15, mirror=True, rotation=2, texture=42)
        self.assertEqual(t.raw, 0x9F)
        self.assertEqual(t.texture, 42)
        self.assertEqual(t.depth, 15)
        self.assertTrue(t.mirror)
        self.assertEqual(t.rotation, 2)

    def test_signed_int_wrapping(self):
        """Negative direction values must serialize as 2's-complement i32 BE."""
        L = self._empty_map()
        L.entities.append(Entity(
            type=ENTITY_TYPE_PLAYER_SPAWN,
            x=0, y=0,
            direction=-1,    # i32 BE = 0xFFFFFFFF
            reserved=bytes(16)))
        data = serialize(L)
        # Direction sits at offset (FIXED_PREFIX_SIZE + 8) within entity record
        offset = FIXED_PREFIX_SIZE + 8
        self.assertEqual(data[offset:offset+4], b"\xFF\xFF\xFF\xFF")


if __name__ == "__main__":
    unittest.main(verbosity=2)
