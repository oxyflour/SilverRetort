"""
Heightfield functions for Mitsuba custom BSDF.
The evaluate() and height_gradient() functions are imported by server.py.
heightfield_preview() generates a PNG preview thumbnail.

Edit this file and server.py will hot-reload it on change.
"""

import math
import struct
import zlib
import sys
import time
from pathlib import Path


def _triangle(x: float, period: float, hmax: float) -> float:
    """Symmetric triangle wave peaking at 0.5."""
    p = x / period
    p = p - math.floor(p)
    if p < 0.5:
        return 2.0 * p * hmax
    else:
        return 2.0 * (1.0 - p) * hmax


def evaluate(x: float, y: float, period: float, hmax: float, rotation_speed: float = 0.0) -> float:
    """Height at world-space (x, y) in meters. Period in meters, hmax in meters."""
    if period <= 0 or hmax <= 0:
        return 0.0

    cell_x = math.floor(x / period)
    cell_y = math.floor(y / period)
    cell_ox = cell_x * period
    cell_oy = cell_y * period
    lx = (x - cell_ox) / period
    ly = (y - cell_oy) / period

    # Rotate local coords based on distance from center
    cx = cell_x + 0.5
    cy = cell_y + 0.5
    dist = math.sqrt(cx * cx + cy * cy) * period
    angle = rotation_speed * dist
    if abs(angle) > 1e-9:
        lx_mid = lx - 0.5
        ly_mid = ly - 0.5
        cos_a = math.cos(angle)
        sin_a = math.sin(angle)
        rx = lx_mid * cos_a - ly_mid * sin_a
        ry = lx_mid * sin_a + ly_mid * cos_a
        lx = rx + 0.5
        ly = ry + 0.5

    hx = _triangle(lx * period, period, hmax)
    hy = _triangle(ly * period, period, hmax)
    hxy = hx * hy / hmax if hmax > 0 else 0.0
    return hxy


# Finite-difference step (same as BSDF uses)
FD_STEP = 1e-5


def height_gradient(x: float, y: float, period: float, hmax: float, rotation_speed: float = 0.0) -> tuple[float, float, float]:
    """Returns (height, dh/dx, dh/dy) using central finite differences."""
    h = evaluate(x, y, period, hmax, rotation_speed)
    h_xp = evaluate(x + FD_STEP, y, period, hmax, rotation_speed)
    h_xn = evaluate(x - FD_STEP, y, period, hmax, rotation_speed)
    h_yp = evaluate(x, y + FD_STEP, period, hmax, rotation_speed)
    h_yn = evaluate(x, y - FD_STEP, period, hmax, rotation_speed)
    dhdx = (h_xp - h_xn) / (2.0 * FD_STEP)
    dhdy = (h_yp - h_yn) / (2.0 * FD_STEP)
    return h, dhdx, dhdy


def heightfield_preview(
    width_px: int,
    height_px: int,
    period: float,
    hmax: float,
    rotation_speed: float,
    center_x: float,
    center_y: float,
    size_mm: float,
) -> bytes:
    """Generate a grayscale PNG preview. Returns PNG bytes."""
    size_m = size_mm / 1000.0
    half = size_m / 2.0
    x0 = center_x - half
    y0 = center_y - half
    dx = size_m / width_px
    dy = size_m / height_px

    # Gather all height values to compute min/max for normalization
    heights = []
    for py in range(height_px):
        row = []
        y = y0 + (py + 0.5) * dy
        for px in range(width_px):
            x = x0 + (px + 0.5) * dx
            h = evaluate(x, y, period, hmax, rotation_speed)
            row.append(h)
        heights.extend(row)

    if not heights:
        return _empty_png(width_px, height_px)

    h_min = min(heights)
    h_max = max(heights)
    h_range = h_max - h_min

    # Build pixel data
    pixels = bytearray()
    idx = 0
    for py in range(height_px):
        # Filter byte: 0
        pixels.append(0)
        for px in range(width_px):
            if h_range > 0:
                v = int((heights[idx] - h_min) / h_range * 255)
            else:
                v = 128
            v = max(0, min(255, v))
            pixels.extend([v, v, v])
            idx += 1

    return _encode_png(width_px, height_px, bytes(pixels))


def _encode_png(width: int, height: int, raw_data: bytes) -> bytes:
    """Encode raw RGBA or RGB data as PNG."""

    def chunk(chunk_type: bytes, data: bytes) -> bytes:
        c = chunk_type + data
        crc = struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)
        return struct.pack(">I", len(data)) + c + crc

    signature = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)  # 8-bit RGB
    result = signature + chunk(b"IHDR", ihdr)

    # Build IDAT
    raw = bytearray()
    row_bytes = 1 + width * 3  # filter byte + RGB
    for row_idx in range(height):
        offset = row_idx * row_bytes
        raw.append(0)  # filter: none
        raw.extend(raw_data[offset + 1 : offset + row_bytes])

    result += chunk(b"IDAT", zlib.compress(bytes(raw)))
    result += chunk(b"IEND", b"")
    return bytes(result)


def _empty_png(width: int, height: int) -> bytes:
    """All-gray placeholder PNG."""
    row = bytes([0]) + bytes([128, 128, 128]) * width
    raw = row * height
    return _encode_png(width, height, raw)


# ---- Hot-reload support ----
_mtime: float = 0.0
_path: str = ""


def _get_path() -> str:
    global _path
    if not _path:
        _path = str(Path(__file__).resolve())
    return _path


def needs_reload() -> bool:
    """Check if this file has been modified since last import."""
    global _mtime
    try:
        mt = Path(_get_path()).stat().st_mtime
        if _mtime == 0:
            _mtime = mt
            return False
        if mt > _mtime:
            _mtime = mt
            return True
    except OSError:
        pass
    return False
