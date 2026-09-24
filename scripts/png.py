#!/usr/bin/env python3
"""A paletted PNG writer, standard library only.

The forecast field is a handful of small rasters a run — tens of pixels a side — and the viewer
draws them with nearest-neighbour sampling so each block is honestly one model cell. That needs no
image library: a PNG is a zlib stream with five chunks around it, and `zlib`/`struct` are enough.

Colour type 3 (indexed), eight bits. Index 0 is transparent through a tRNS chunk, so "nothing to
show" is a hole in the layer rather than a painted zero; indices 1..N map onto the legend stops the
caller supplies, which is how the key on the map and the pixels are guaranteed to agree — they come
from one table.
"""

from __future__ import annotations

import struct
import zlib
from bisect import bisect_right
from pathlib import Path


def _chunk(kind: bytes, data: bytes) -> bytes:
    return (struct.pack('>I', len(data)) + kind + data
            + struct.pack('>I', zlib.crc32(kind + data) & 0xFFFFFFFF))


def hex_rgb(colour: str) -> tuple[int, int, int]:
    c = colour.lstrip('#')
    return int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)


def classify(value: float | None, stops: list[float]) -> int:
    """0 below the first stop (or missing), else 1-based index of the highest stop reached."""
    if value is None:
        return 0
    return bisect_right(stops, value)


def encode_png(width: int, height: int, rows: list[bytes], palette: list[tuple[int, int, int]],
               transparent_index: int | None = 0) -> bytes:
    """Rows are `height` byte strings of `width` palette indices each."""
    if len(rows) != height or any(len(r) != width for r in rows):
        raise ValueError('rows do not match the declared size')
    if len(palette) > 256:
        raise ValueError('a paletted PNG holds at most 256 colours')
    raw = b''.join(b'\x00' + r for r in rows)  # filter type 0 on every scanline
    out = [b'\x89PNG\r\n\x1a\n',
           _chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 3, 0, 0, 0)),
           _chunk(b'PLTE', b''.join(bytes(c) for c in palette))]
    if transparent_index is not None:
        alpha = bytearray(b'\xff' * len(palette))
        alpha[transparent_index] = 0
        out.append(_chunk(b'tRNS', bytes(alpha)))
    out.append(_chunk(b'IDAT', zlib.compress(raw, 9)))
    out.append(_chunk(b'IEND', b''))
    return b''.join(out)


def write_png(path: Path, width: int, height: int, rows: list[bytes],
              palette: list[tuple[int, int, int]], transparent_index: int | None = 0) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(encode_png(width, height, rows, palette, transparent_index))


def decode_png(data: bytes) -> tuple[int, int, list[bytes], list[tuple[int, int, int]], int | None]:
    """The inverse, for tests: only what this module writes (filter 0, colour type 3, 8-bit)."""
    assert data[:8] == b'\x89PNG\r\n\x1a\n'
    pos = 8
    width = height = 0
    palette: list[tuple[int, int, int]] = []
    transparent = None
    idat = b''
    while pos < len(data):
        length, kind = struct.unpack('>I4s', data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if kind == b'IHDR':
            width, height = struct.unpack('>II', body[:8])
        elif kind == b'PLTE':
            palette = [tuple(body[i:i + 3]) for i in range(0, len(body), 3)]  # type: ignore[misc]
        elif kind == b'tRNS':
            transparent = next((i for i, a in enumerate(body) if a == 0), None)
        elif kind == b'IDAT':
            idat += body
    raw = zlib.decompress(idat)
    stride = width + 1
    rows = [raw[i * stride + 1:(i + 1) * stride] for i in range(height)]
    return width, height, rows, palette, transparent


# ---- Any 8-bit PNG, for reading other people's files ----
#
# `decode_png` above reads back only what this module writes. The 3D scenes also read terrain
# tiles (Terrarium PNGs: RGB, and a server is free to use any scanline filter), so this is the full
# reader for 8-bit files: colour types 0, 2, 3, 4 and 6, all five filters, no interlacing.

_CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}


def _paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    return b if pb <= pc else c


def decode_png_any(data: bytes) -> tuple[int, int, int, list[bytearray]]:
    """(width, height, channels, rows) for an 8-bit, non-interlaced PNG. Rows are raw samples."""
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError('not a PNG')
    pos = 8
    width = height = ctype = 0
    idat = bytearray()
    while pos < len(data):
        length, kind = struct.unpack('>I4s', data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if kind == b'IHDR':
            width, height, depth, ctype, _c, _f, interlace = struct.unpack('>IIBBBBB', body)
            if depth != 8 or interlace:
                raise ValueError('only 8-bit, non-interlaced PNGs are read')
        elif kind == b'IDAT':
            idat += body
        elif kind == b'IEND':
            break
    bpp = _CHANNELS[ctype]
    stride = width * bpp
    raw = zlib.decompress(bytes(idat))
    rows: list[bytearray] = []
    prev = bytearray(stride)
    for y in range(height):
        f = raw[y * (stride + 1)]
        line = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        if f == 1:
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif f == 3:
            for i in range(stride):
                left = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif f == 4:
            for i in range(stride):
                left = line[i - bpp] if i >= bpp else 0
                upleft = prev[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + _paeth(left, prev[i], upleft)) & 0xFF
        rows.append(line)
        prev = line
    return width, height, bpp, rows


def encode_png_rgb(width: int, height: int, rows: list[bytes]) -> bytes:
    """Colour type 2, eight bits a sample: for data carried in the channels, not for looking at."""
    if len(rows) != height or any(len(r) != width * 3 for r in rows):
        raise ValueError('rows do not match the declared size')
    raw = b''.join(b'\x00' + bytes(r) for r in rows)
    return b''.join([
        b'\x89PNG\r\n\x1a\n',
        _chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)),
        _chunk(b'IDAT', zlib.compress(raw, 9)),
        _chunk(b'IEND', b''),
    ])
