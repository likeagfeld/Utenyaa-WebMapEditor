"""
nya_format.py — Parser for Utenyaa .NYA model files.

Format mirrored from the SATURN ENGINE'S loader (see
Utenyaa-Netlink/src/Objects/Model.hpp — the authoritative consumer)
which reads a `ModelHeader { MeshCount, TextureCount }` with NO Type
field. PawCraft's Obj2Nya/NyaGroup C# class declares a Type field but
that field is NOT present on disk in any of the 7 production models
(CRATE/PLAYER/TREE/WALL/WALL2/WALL3/BOMB.NYA). Verified by file-size
math against multiple files.

Multi-byte values BIG-ENDIAN (Saturn SH-2 native).

ModelHeader (8 bytes):
   off  size  field
   0    4     MeshCount (i32 BE)        size_t = uint32 on SH-2 GCC
   4    4     TextureCount (i32 BE)

Then MeshCount × Mesh, then TextureCount × Texture.

NyaMesh:
   off  size  field
   0    4     PointCount (i32 BE)
   4    4     PolygonCount (i32 BE)
   8    PC*12 Points[PointCount]   FxVector each (i32 x,y,z BE)
   ...  PG*20 Polygons[PolygonCount]  NyaPolygon each
   ...  PG*8  FaceFlags[PolygonCount]  NyaFaceFlags each

NyaSmoothMesh = NyaMesh + per-vertex Normals at end:
   ...  PC*12 Normals[PointCount]   FxVector each

NyaPolygon (20 bytes):
   off  size  field
   0    12    Normal (FxVector i32x3 BE)
   12   2*4   Vertices[4] (short BE each)

NyaFaceFlags (8 bytes):
   off  size  field
   0    1     Flags (bit 7 = HasTexture, 6 = MeshEffect, 5 = DoubleSided,
                      4 = HalfTransparent, 0..3 = engine reserved)
   1    1     Reserved
   2    2     BaseColor (u16 ARGB-1555 BE)
   4    4     TextureId (i32 BE) — index into the group's Textures[]

NyaTexture (variable size):
   off  size  field
   0    2     Width (u16 BE)
   2    2     Height (u16 BE)
   4    W*H*2 Data (W*H pixels of u16 ARGB-1555 BE)
"""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import List
import struct

FXP = 65536.0   # fxp 16.16 → float scale


# ---- dataclasses --------------------------------------------------------

@dataclass
class NyaPolygon:
    nx: float = 0.0
    ny: float = 0.0
    nz: float = 0.0
    vertices: List[int] = field(default_factory=lambda: [0, 0, 0, 0])


@dataclass
class NyaFaceFlags:
    flags: int = 0
    reserved: int = 0
    base_color: int = 0     # ARGB-1555 u16
    texture_id: int = 0
    @property
    def has_texture(self):     return (self.flags & 0x80) != 0
    @property
    def has_mesh(self):        return (self.flags & 0x40) != 0
    @property
    def is_double_sided(self): return (self.flags & 0x20) != 0
    @property
    def is_half_trans(self):   return (self.flags & 0x10) != 0


@dataclass
class NyaMesh:
    points: List[tuple] = field(default_factory=list)        # [(x,y,z) floats]
    polygons: List[NyaPolygon] = field(default_factory=list)
    face_flags: List[NyaFaceFlags] = field(default_factory=list)
    normals: List[tuple] = field(default_factory=list)       # smooth-mesh per-vertex normals


@dataclass
class NyaTexture:
    width: int = 0
    height: int = 0
    rgba: bytes = b""


@dataclass
class NyaModel:
    meshes: List[NyaMesh] = field(default_factory=list)
    textures: List[NyaTexture] = field(default_factory=list)


# ---- parser -------------------------------------------------------------

class NyaParseError(Exception): pass


def _argb1555_to_rgba(pixel: int) -> tuple:
    a = 255 if (pixel & 0x8000) else 0
    blue  = (pixel >> 10) & 0x1F
    green = (pixel >> 5)  & 0x1F
    red   = pixel         & 0x1F
    R = (red   << 3) | (red   >> 2)
    G = (green << 3) | (green >> 2)
    B = (blue  << 3) | (blue  >> 2)
    return (R, G, B, a)


def parse(data: bytes) -> NyaModel:
    """Parse .NYA bytes into a NyaModel."""
    n = len(data)
    if n < 12:
        raise NyaParseError(f"file too short: {n} bytes")

    off = [0]
    def read_i32():
        if off[0] + 4 > n:
            raise NyaParseError(f"i32 read off end at {off[0]}")
        v = struct.unpack(">i", data[off[0]:off[0]+4])[0]
        off[0] += 4
        return v

    def read_u16():
        if off[0] + 2 > n:
            raise NyaParseError(f"u16 read off end at {off[0]}")
        v = struct.unpack(">H", data[off[0]:off[0]+2])[0]
        off[0] += 2
        return v

    def read_i16():
        if off[0] + 2 > n:
            raise NyaParseError(f"i16 read off end at {off[0]}")
        v = struct.unpack(">h", data[off[0]:off[0]+2])[0]
        off[0] += 2
        return v

    def read_u8():
        if off[0] + 1 > n:
            raise NyaParseError(f"u8 read off end at {off[0]}")
        v = data[off[0]]
        off[0] += 1
        return v

    def read_fxvec():
        x = read_i32() / FXP
        y = read_i32() / FXP
        z = read_i32() / FXP
        return (x, y, z)

    model = NyaModel()
    mesh_count = read_i32()
    tex_count  = read_i32()
    if mesh_count < 0 or mesh_count > 256:
        raise NyaParseError(f"implausible mesh count {mesh_count}")
    if tex_count < 0 or tex_count > 256:
        raise NyaParseError(f"implausible texture count {tex_count}")

    # The Saturn loader's flat-mesh format only — Utenyaa's actual game
    # never ships smooth-shaded NYAs (no per-vertex normals on disk).
    for _ in range(mesh_count):
        m = NyaMesh()
        point_count   = read_i32()
        polygon_count = read_i32()
        if point_count < 0 or point_count > 65535:
            raise NyaParseError(f"implausible point count {point_count}")
        if polygon_count < 0 or polygon_count > 65535:
            raise NyaParseError(f"implausible polygon count {polygon_count}")
        for _i in range(point_count):
            m.points.append(read_fxvec())
        for _i in range(polygon_count):
            poly = NyaPolygon()
            poly.nx, poly.ny, poly.nz = read_fxvec()
            poly.vertices = [read_i16(), read_i16(), read_i16(), read_i16()]
            m.polygons.append(poly)
        for _i in range(polygon_count):
            ff = NyaFaceFlags()
            ff.flags     = read_u8()
            ff.reserved  = read_u8()
            ff.base_color = read_u16()
            ff.texture_id = read_i32()
            m.face_flags.append(ff)
        model.meshes.append(m)

    for _ in range(tex_count):
        t = NyaTexture()
        t.width  = read_u16()
        t.height = read_u16()
        pixels = t.width * t.height
        rgba = bytearray(pixels * 4)
        for i in range(pixels):
            pix = (data[off[0] + i*2] << 8) | data[off[0] + i*2 + 1]
            R, G, B, A = _argb1555_to_rgba(pix)
            rgba[i*4 + 0] = R
            rgba[i*4 + 1] = G
            rgba[i*4 + 2] = B
            rgba[i*4 + 3] = A
        off[0] += pixels * 2
        t.rgba = bytes(rgba)
        model.textures.append(t)

    return model


# ---- summary helpers ----------------------------------------------------

def summarize(model: NyaModel) -> dict:
    return {
        "mesh_count": len(model.meshes),
        "texture_count": len(model.textures),
        "total_points":   sum(len(m.points) for m in model.meshes),
        "total_polygons": sum(len(m.polygons) for m in model.meshes),
        "textures": [{"index": i, "width": t.width, "height": t.height}
                     for i, t in enumerate(model.textures)],
    }


def main():
    """CLI: dump info for a .NYA file."""
    import argparse, json
    p = argparse.ArgumentParser()
    p.add_argument("nya")
    args = p.parse_args()
    with open(args.nya, "rb") as f:
        data = f.read()
    model = parse(data)
    print(json.dumps(summarize(model), indent=2))


if __name__ == "__main__":
    main()
