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


# ---- PNG decoding (stdlib only) ------------------------------------------
#
# Minimal RGBA decoder for the template-import path. Supports 8-bit
# RGBA non-interlaced PNGs with all five PNG filter types — covers
# our own encode_png output AND anything Photoshop / GIMP / Aseprite
# saves out. Other formats raise ValueError.

def decode_png_rgba(data: bytes) -> tuple[int, int, bytes]:
    """Decode an 8-bit RGBA non-interlaced PNG. Returns (W, H, rgba)."""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG (missing signature)")
    off = 8
    width = height = 0
    bit_depth = 0
    color_type = 0
    interlace = 0
    idat_chunks: list[bytes] = []
    while off + 8 <= len(data):
        clen = struct.unpack(">I", data[off:off+4])[0]
        ctype = data[off+4:off+8]
        cdata = data[off+8:off+8+clen]
        if ctype == b"IHDR":
            width, height = struct.unpack(">II", cdata[:8])
            bit_depth, color_type = cdata[8], cdata[9]
            interlace = cdata[12]
            if bit_depth != 8:
                raise ValueError(f"only 8-bit PNGs supported (got {bit_depth}-bit)")
            if color_type != 6:
                raise ValueError(
                    f"only RGBA PNGs supported (color type 6); got {color_type}")
            if interlace != 0:
                raise ValueError("interlaced PNGs unsupported")
        elif ctype == b"IDAT":
            idat_chunks.append(cdata)
        elif ctype == b"IEND":
            break
        off += 12 + clen   # length(4) + type(4) + data + crc(4)
    if not idat_chunks:
        raise ValueError("no IDAT chunks")
    raw = zlib.decompress(b"".join(idat_chunks))

    bpp = 4   # RGBA
    stride = width * bpp
    out = bytearray(width * height * bpp)
    rin = 0
    rout = 0
    prev_row = bytes(stride)
    for _y in range(height):
        if rin + 1 + stride > len(raw):
            raise ValueError("PNG IDAT truncated")
        ftype = raw[rin]; rin += 1
        row = bytearray(raw[rin:rin+stride]); rin += stride
        if ftype == 0:
            pass
        elif ftype == 1:   # Sub
            for x in range(bpp, stride):
                row[x] = (row[x] + row[x - bpp]) & 0xFF
        elif ftype == 2:   # Up
            for x in range(stride):
                row[x] = (row[x] + prev_row[x]) & 0xFF
        elif ftype == 3:   # Average
            for x in range(stride):
                left = row[x - bpp] if x >= bpp else 0
                row[x] = (row[x] + ((left + prev_row[x]) >> 1)) & 0xFF
        elif ftype == 4:   # Paeth
            for x in range(stride):
                left = row[x - bpp] if x >= bpp else 0
                up = prev_row[x]
                ul = prev_row[x - bpp] if x >= bpp else 0
                p = left + up - ul
                pa, pb, pc = abs(p - left), abs(p - up), abs(p - ul)
                if pa <= pb and pa <= pc:
                    pred = left
                elif pb <= pc:
                    pred = up
                else:
                    pred = ul
                row[x] = (row[x] + pred) & 0xFF
        else:
            raise ValueError(f"unknown PNG filter type {ftype}")
        out[rout:rout+stride] = row
        rout += stride
        prev_row = bytes(row)
    return width, height, bytes(out)


def rgba8_to_argb1555(rgba: bytes, w: int, h: int) -> list[int]:
    """Quantize RGBA8 pixels to Saturn ARGB-1555 u16 ints.
    Pixels with alpha < 128 become 0x0000 (fully transparent).
    Pixels with alpha >= 128 become opaque (alpha bit set)."""
    if len(rgba) != w * h * 4:
        raise ValueError(f"rgba length {len(rgba)} != w*h*4 = {w*h*4}")
    out = [0] * (w * h)
    for i in range(w * h):
        R = rgba[i*4]
        G = rgba[i*4 + 1]
        B = rgba[i*4 + 2]
        A = rgba[i*4 + 3]
        if A < 128:
            out[i] = 0x0000   # fully transparent
            continue
        r5 = (R >> 3) & 0x1F
        g5 = (G >> 3) & 0x1F
        b5 = (B >> 3) & 0x1F
        out[i] = 0x8000 | (b5 << 10) | (g5 << 5) | r5
    return out


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
