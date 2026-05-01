"""
pak_format.py — Parse Utenyaa .PAK texture archives.

Format derived from PawCraft (Tex2Pak/Program.cs + Obj2Nya/NyaTexture.cs):
each .PAK is a concatenation of NyaTextures with NO outer header.

NyaTexture (variable size):
   off  size  field
   0    2     Width  (u16 BE)
   2    2     Height (u16 BE)
   4    W*H*2 Data (W*H pixels, each ARGB-1555 u16 BE)

Pixel format: ARGB-1555 (Saturn VDP1 native)
   bit 15    Alpha (1 = opaque, 0 = transparent)
   bits 14-10 Blue  (5 bits)
   bits 9-5   Green (5 bits)
   bits 4-0   Red   (5 bits)

NOTE: PawCraft's Color setters write Red into the LOW 5 bits and Blue
into the HIGH 5 bits. This matches the Saturn VDP1 convention but is
the OPPOSITE of typical PC RGB-1555. Verified by reading Color.cs.

Texture indices in TileData refer to position in the PAK (0-based,
in file order) — the Saturn engine's PakTextureLoader allocates
sequential sprite IDs starting at FirstGroundTextureIndex.

This module supports stand-alone use (extract textures to PNG via PIL
if installed) and read-only access from the Flask app (raw RGBA bytes
for serving as on-the-fly PNGs).
"""

from __future__ import annotations
from dataclasses import dataclass
from typing import List
import struct


@dataclass
class PakTexture:
    width: int
    height: int
    rgba: bytes   # raw 4-bytes-per-pixel RGBA data, top-left first


def _argb1555_to_rgba(pixel: int) -> tuple:
    """Convert one Saturn ARGB-1555 u16 to (R,G,B,A) bytes."""
    a = 255 if (pixel & 0x8000) else 0
    blue  = (pixel >> 10) & 0x1F
    green = (pixel >> 5)  & 0x1F
    red   = pixel         & 0x1F
    # Scale 5-bit (0..31) to 8-bit (0..255). Use the standard
    # bit-replication formula: out = (v << 3) | (v >> 2).
    R = (red   << 3) | (red   >> 2)
    G = (green << 3) | (green >> 2)
    B = (blue  << 3) | (blue  >> 2)
    return (R, G, B, a)


def parse(data: bytes) -> List[PakTexture]:
    """Walk a .PAK, return the list of decoded textures.

    Stops when fewer than 4 bytes remain (header truncated) or when a
    declared texture size would run off the file end."""
    textures: List[PakTexture] = []
    off = 0
    n = len(data)
    while off + 4 <= n:
        w, h = struct.unpack(">HH", data[off:off+4])
        off += 4
        if w == 0 or h == 0:
            # An end-marker / sanity bail. Production PAKs don't contain
            # zero-sized textures.
            break
        pixels = w * h
        end = off + pixels * 2
        if end > n:
            break  # truncated
        rgba = bytearray(pixels * 4)
        for i in range(pixels):
            pix = (data[off + i*2] << 8) | data[off + i*2 + 1]
            R, G, B, A = _argb1555_to_rgba(pix)
            rgba[i*4 + 0] = R
            rgba[i*4 + 1] = G
            rgba[i*4 + 2] = B
            rgba[i*4 + 3] = A
        textures.append(PakTexture(width=w, height=h, rgba=bytes(rgba)))
        off = end
    return textures


# ---- PNG encoding (no PIL dependency) -------------------------------------
#
# Pure-stdlib PNG writer. Lets the Flask app return decoded textures as
# PNGs without requiring Pillow on the host. Algorithm: zlib-compressed
# IDAT chunk with one filter byte (0x00 = none) per row.

import zlib


def encode_png(rgba: bytes, width: int, height: int) -> bytes:
    """Encode raw RGBA8 pixel data as a PNG. Returns the .png bytes."""
    if len(rgba) != width * height * 4:
        raise ValueError(
            f"rgba length {len(rgba)} != {width}*{height}*4 = {width*height*4}")

    sig = b"\x89PNG\r\n\x1a\n"

    def chunk(tag: bytes, payload: bytes) -> bytes:
        return (struct.pack(">I", len(payload))
                + tag + payload
                + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF))

    # IHDR
    ihdr = struct.pack(">IIBBBBB",
        width, height,
        8,    # bit depth per channel
        6,    # color type: RGBA
        0,    # compression
        0,    # filter
        0)    # interlace

    # IDAT — filter byte 0 (no filter) per row, then deflate
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        raw.extend(rgba[y * width * 4 : (y + 1) * width * 4])
    idat = zlib.compress(bytes(raw), 9)

    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


# ---- CLI: dump a .PAK to a directory of PNGs ------------------------------

def main():
    import argparse
    import os
    p = argparse.ArgumentParser(
        description="Extract textures from a Utenyaa .PAK to PNG files.")
    p.add_argument("pak", help="Input .PAK file")
    p.add_argument("outdir", help="Output directory (created if missing)")
    p.add_argument("--prefix", default="tex_",
        help="Filename prefix (default 'tex_')")
    args = p.parse_args()

    with open(args.pak, "rb") as f:
        data = f.read()
    textures = parse(data)
    os.makedirs(args.outdir, exist_ok=True)
    for i, t in enumerate(textures):
        path = os.path.join(args.outdir, f"{args.prefix}{i:03d}.png")
        with open(path, "wb") as f:
            f.write(encode_png(t.rgba, t.width, t.height))
        print(f"  {path}: {t.width}x{t.height}")
    print(f"Total: {len(textures)} texture(s) from {args.pak}")


if __name__ == "__main__":
    main()
