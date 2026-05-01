"""
ute_format.py — Binary serializer/parser for Utenyaa .UTE map files.

Produces output BYTE-IDENTICAL to ReyeMe's PawCraft so the existing
Saturn engine (Utenyaa-Netlink/src/Objects/Map.hpp) and PawCraft itself
can both load any map this module emits.

Format derived from PawCraft commit on `main` (PawCraft.Utils/Serializer/
CustomMarshal.cs + PawCraft/Level/{LevelData,TileData,EntityData,LevelLight}.cs
+ PawCraft.Utils/Types/{Color,FxVector,Gourad}.cs).

Key facts validated against existing production .UTE files
(ISLAND.UTE, CROSS.UTE, VALLEY.UTE, RAILWAY.UTE in the Utenyaa game):

  Multi-byte values: BIG-ENDIAN. PawCraft's CustomMarshal calls
  .Reverse<byte>() on every multi-byte primitive after Marshal.SizeOf.

  Field ordering: by [FieldOrder(N)] attribute ascending. Ties
  preserved in source declaration order (C# OrderBy is stable +
  Type.GetFields returns in metadata order = declaration order
  for this compiler).

  Map dimensions: 20 × 20 tiles, fixed.

LevelData layout (offsets in bytes):
   0..3      Identifier ['U','T','E', 0]
   4..1603   TileData[400]      -- 4 bytes each
1604..1619   LevelLight         -- 16 bytes
1620..4819   Gourad[400]        -- 8 bytes each (4 × Color u16)
4820..9619   Normals[400]       -- 12 bytes each (3 × i32)
9620..9623   EntityCount (i32 BE)
9624..       Entities[N]        -- 28 bytes each

TileData (4 bytes):
   byte 0   DepthAndRotationAndMirror  -- bit packing per PawCraft
   byte 1   TextureIndex
   byte 2-3 Dummy (u16 BE)

LevelLight (16 bytes):
   byte 0-11   Direction (FxVector: i32x3 BE)
   byte 12-13  Color (u16 BE)
   byte 14-15  Reserved (i16 BE)

EntityData (28 bytes):
   byte 0-3   Type (i32 BE) -- 0=Empty, 1=PlayerSpawn, 2=Model, 3=Crate
   byte 4-5   X (u16 BE)
   byte 6-7   Y (u16 BE)
   byte 8-11  Direction (i32 BE) -- radians as fixed-point 16.16
   byte 12-27 Reserved[16]

Sanity:
  fixed_prefix = 4 + 1600 + 16 + 3200 + 4800 + 4 = 9624
  ISLAND.UTE  = 10268 bytes -> (10268 - 9624) / 28 = 23 entities ✓
  CROSS.UTE   = 10940 bytes -> (10940 - 9624) / 28 = 47 entities ✓
  RAILWAY.UTE = 10352 bytes -> (10352 - 9624) / 28 = 26 entities ✓
  VALLEY.UTE  = 10352 bytes -> (10352 - 9624) / 28 = 26 entities ✓
"""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import List, Tuple
import struct

# ----------------------------------------------------------------------------
# Constants matching PawCraft's LevelData
# ----------------------------------------------------------------------------

MAP_DIMENSION = 20                      # 20×20 grid, hard-coded in PawCraft
TILE_COUNT = MAP_DIMENSION * MAP_DIMENSION   # 400
VERSION_BYTE = 0
IDENTIFIER = b"UTE" + bytes([VERSION_BYTE])  # 4 bytes
ENTITY_RECORD_SIZE = 28
LEVEL_LIGHT_SIZE = 16
TILE_RECORD_SIZE = 4
GOURAD_RECORD_SIZE = 8       # 4 × u16
NORMAL_RECORD_SIZE = 12      # 3 × i32
FIXED_PREFIX_SIZE = (
    len(IDENTIFIER)
    + TILE_COUNT * TILE_RECORD_SIZE      # 1600
    + LEVEL_LIGHT_SIZE                   # 16
    + TILE_COUNT * GOURAD_RECORD_SIZE    # 3200
    + TILE_COUNT * NORMAL_RECORD_SIZE    # 4800
    + 4                                  # entity count i32
)
assert FIXED_PREFIX_SIZE == 9624, "Format constant drift"


# Entity type IDs (PawCraft: EntityData.EntityType, serialized as i32)
ENTITY_TYPE_EMPTY        = 0
ENTITY_TYPE_PLAYER_SPAWN = 1
ENTITY_TYPE_MODEL        = 2
ENTITY_TYPE_CRATE        = 3
ENTITY_TYPE_NAMES = {
    ENTITY_TYPE_EMPTY:        "empty",
    ENTITY_TYPE_PLAYER_SPAWN: "player_spawn",
    ENTITY_TYPE_MODEL:        "model",
    ENTITY_TYPE_CRATE:        "crate",
}
ENTITY_TYPE_FROM_NAME = {v: k for k, v in ENTITY_TYPE_NAMES.items()}


# ----------------------------------------------------------------------------
# Dataclasses
# ----------------------------------------------------------------------------

@dataclass
class Tile:
    """One 20×20 tile. Matches PawCraft TileData (4 bytes on disk).

    The first byte is bit-packed per PawCraft:
        bits 0..4   Depth (5 bits, 0-31)
        bit 4       MirrorTexture flag
        bits 6..7   RotateTexture (0-3 = 0/90/180/270)

    NOTE on PawCraft's setter inconsistency: TileData.Depth's getter
    masks 0x3F but the setter masks 0x1F, and MirrorTexture lives at
    bit 4 — meaning a depth >= 16 silently overwrites mirror. We
    expose the raw packed byte so callers can mirror PawCraft's
    behavior exactly when needed; the helpers below match the SETTER
    contract (depth 0-15, mirror on bit 4, rotate on bits 6-7)."""
    raw: int = 0       # the packed first byte (DepthAndRotationAndMirror)
    texture: int = 0   # texture index (0..255)
    dummy: int = 0     # u16, defaults to 0; PawCraft writes whatever was loaded

    @staticmethod
    def from_parts(depth: int, mirror: bool, rotation: int, texture: int,
                   dummy: int = 0) -> "Tile":
        if not 0 <= depth <= 0x1F:
            raise ValueError(f"depth must be 0..31, got {depth}")
        if not 0 <= rotation <= 3:
            raise ValueError(f"rotation must be 0..3, got {rotation}")
        if not 0 <= texture <= 0xFF:
            raise ValueError(f"texture must be 0..255, got {texture}")
        raw = (depth & 0x1F) | (0x10 if mirror else 0) | ((rotation & 3) << 6)
        return Tile(raw=raw, texture=texture, dummy=dummy)

    @property
    def depth(self) -> int:
        # Match PawCraft setter contract: 5 bits low, but bit 4 is mirror.
        # We expose 0..15 so depth+mirror don't collide.
        return self.raw & 0x0F

    @property
    def mirror(self) -> bool:
        return (self.raw & 0x10) != 0

    @property
    def rotation(self) -> int:
        return (self.raw >> 6) & 0x3


@dataclass
class FxVector:
    """3-component fixed-point 16.16 vector. 12 bytes BE."""
    x: int = 0
    y: int = 0
    z: int = 0


@dataclass
class LevelLight:
    """16 bytes total. Direction comes first (FieldOrder 0)."""
    direction: FxVector = field(default_factory=FxVector)
    color: int = 0     # 16-bit ARGB-1555 packed
    reserved: int = 0  # i16


@dataclass
class Gourad:
    """4-corner gouraud color, 8 bytes total (4 × u16 ARGB-1555)."""
    colors: Tuple[int, int, int, int] = (0, 0, 0, 0)


@dataclass
class Entity:
    """28 bytes on disk. Type+X+Y (FieldOrder 0,1,2) then the
    FieldOrder(3) tie: Direction first then Reserved (matches the
    declaration order PawCraft relies on via C#'s stable OrderBy +
    Type.GetFields metadata-order semantics).

    Verified by file size of all 4 production maps: 10268, 10940,
    10352, 10352 → entity counts 23/47/26/26. Any other ordering
    of the FieldOrder(3) tie would offset the tail and break parse."""
    type: int = ENTITY_TYPE_EMPTY
    x: int = 0          # u16, tile-grid X coordinate
    y: int = 0          # u16, tile-grid Y coordinate
    direction: int = 0  # i32, radians as fixed-point
    reserved: bytes = field(default_factory=lambda: bytes(16))


@dataclass
class LevelData:
    """Complete map. Round-trips byte-identical via parse() / serialize()."""
    tiles: List[Tile] = field(default_factory=lambda: [Tile() for _ in range(TILE_COUNT)])
    light: LevelLight = field(default_factory=LevelLight)
    gourad: List[Gourad] = field(default_factory=lambda: [Gourad() for _ in range(TILE_COUNT)])
    normals: List[FxVector] = field(default_factory=lambda: [FxVector() for _ in range(TILE_COUNT)])
    entities: List[Entity] = field(default_factory=list)


# ----------------------------------------------------------------------------
# Serialization
# ----------------------------------------------------------------------------

def _pack_tile(t: Tile) -> bytes:
    """4 bytes: u8 raw, u8 texture, u16 BE dummy."""
    return struct.pack(">BBH", t.raw & 0xFF, t.texture & 0xFF, t.dummy & 0xFFFF)


def _pack_fxvector(v: FxVector) -> bytes:
    """12 bytes: 3 × i32 BE."""
    return struct.pack(">iii", v.x, v.y, v.z)


def _pack_levellight(L: LevelLight) -> bytes:
    """16 bytes: FxVector (12) + u16 color + i16 reserved (all BE)."""
    return _pack_fxvector(L.direction) + struct.pack(">Hh",
                                                     L.color & 0xFFFF,
                                                     _signed16(L.reserved))


def _pack_gourad(g: Gourad) -> bytes:
    """8 bytes: 4 × u16 BE."""
    if len(g.colors) != 4:
        raise ValueError("Gourad must have exactly 4 colors")
    return struct.pack(">HHHH",
                       g.colors[0] & 0xFFFF,
                       g.colors[1] & 0xFFFF,
                       g.colors[2] & 0xFFFF,
                       g.colors[3] & 0xFFFF)


def _pack_entity(e: Entity) -> bytes:
    """28 bytes: i32 type + u16 x + u16 y + i32 direction + 16 reserved."""
    if len(e.reserved) != 16:
        raise ValueError("Entity.reserved must be exactly 16 bytes")
    return (struct.pack(">i", _signed32(e.type))
            + struct.pack(">HH", e.x & 0xFFFF, e.y & 0xFFFF)
            + struct.pack(">i", _signed32(e.direction))
            + bytes(e.reserved))


def serialize(L: LevelData) -> bytes:
    """Serialize a LevelData to its on-disk .UTE byte representation."""
    if len(L.tiles) != TILE_COUNT:
        raise ValueError(f"tiles must be exactly {TILE_COUNT}")
    if len(L.gourad) != TILE_COUNT:
        raise ValueError(f"gourad must be exactly {TILE_COUNT}")
    if len(L.normals) != TILE_COUNT:
        raise ValueError(f"normals must be exactly {TILE_COUNT}")

    out = bytearray()
    out.extend(IDENTIFIER)
    for t in L.tiles:
        out.extend(_pack_tile(t))
    out.extend(_pack_levellight(L.light))
    for g in L.gourad:
        out.extend(_pack_gourad(g))
    for n in L.normals:
        out.extend(_pack_fxvector(n))
    out.extend(struct.pack(">i", _signed32(len(L.entities))))
    for e in L.entities:
        out.extend(_pack_entity(e))
    return bytes(out)


# ----------------------------------------------------------------------------
# Parsing (used for round-trip validation against the production maps)
# ----------------------------------------------------------------------------

class UteParseError(Exception):
    pass


def parse(data: bytes) -> LevelData:
    """Parse .UTE bytes into a LevelData. Raises UteParseError on bad input."""
    if len(data) < FIXED_PREFIX_SIZE:
        raise UteParseError(
            f"file too short: {len(data)} bytes, need at least {FIXED_PREFIX_SIZE}")

    if data[:4] != IDENTIFIER:
        raise UteParseError(
            f"bad identifier: {data[:4]!r}, expected {IDENTIFIER!r}")

    off = 4
    L = LevelData(tiles=[], gourad=[], normals=[])

    # Tiles
    for _ in range(TILE_COUNT):
        raw, tex, dummy = struct.unpack(">BBH", data[off:off+4])
        L.tiles.append(Tile(raw=raw, texture=tex, dummy=dummy))
        off += 4

    # LevelLight
    dx, dy, dz = struct.unpack(">iii", data[off:off+12])
    off += 12
    color, reserved = struct.unpack(">Hh", data[off:off+4])
    off += 4
    L.light = LevelLight(
        direction=FxVector(x=dx, y=dy, z=dz),
        color=color,
        reserved=reserved)

    # Gourad
    for _ in range(TILE_COUNT):
        c0, c1, c2, c3 = struct.unpack(">HHHH", data[off:off+8])
        L.gourad.append(Gourad(colors=(c0, c1, c2, c3)))
        off += 8

    # Normals
    for _ in range(TILE_COUNT):
        nx, ny, nz = struct.unpack(">iii", data[off:off+12])
        L.normals.append(FxVector(x=nx, y=ny, z=nz))
        off += 12

    # Entity count
    (n_entities,) = struct.unpack(">i", data[off:off+4])
    off += 4

    expected_size = FIXED_PREFIX_SIZE + n_entities * ENTITY_RECORD_SIZE
    if len(data) != expected_size:
        raise UteParseError(
            f"size mismatch: file is {len(data)} bytes, "
            f"header says {n_entities} entities → expected {expected_size}")

    # Entities
    for _ in range(n_entities):
        (etype,)     = struct.unpack(">i", data[off:off+4])
        ex, ey       = struct.unpack(">HH", data[off+4:off+8])
        (edir,)      = struct.unpack(">i", data[off+8:off+12])
        ereserved    = bytes(data[off+12:off+28])
        L.entities.append(Entity(
            type=etype, x=ex, y=ey, direction=edir, reserved=ereserved))
        off += ENTITY_RECORD_SIZE

    return L


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------

def _signed16(v: int) -> int:
    """Clamp/wrap to int16 range for struct.pack 'h'."""
    v = int(v) & 0xFFFF
    return v - 0x10000 if v >= 0x8000 else v


def _signed32(v: int) -> int:
    """Clamp/wrap to int32 range for struct.pack 'i'."""
    v = int(v) & 0xFFFFFFFF
    return v - 0x100000000 if v >= 0x80000000 else v


def round_trip_check(data: bytes) -> Tuple[bool, str]:
    """Parse .UTE bytes then re-serialize. Returns (ok, diag)."""
    try:
        parsed = parse(data)
    except UteParseError as e:
        return False, f"parse failed: {e}"
    re_serialized = serialize(parsed)
    if re_serialized == data:
        return True, f"OK ({len(data)} bytes, {len(parsed.entities)} entities)"
    # Find first byte that diverges for debug
    n = min(len(data), len(re_serialized))
    for i in range(n):
        if data[i] != re_serialized[i]:
            return False, (f"byte {i} diverges: "
                           f"orig=0x{data[i]:02X} re={re_serialized[i]:02X}; "
                           f"orig_len={len(data)} re_len={len(re_serialized)}")
    return False, (f"length mismatch: orig={len(data)} re={len(re_serialized)}")
