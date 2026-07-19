
"""
Heightfield definition using Dr.Jit — single source of truth.
RANDOM PYRAMIDS: each cell gets a pseudo-random height and jittered center position.

Edit this file to change the heightfield formula. The server auto-reloads it.

Used by:
  - server.py BSDF   (calls evaluate/gradient with GPU/CUDA drjit arrays)
  - server.py /preview (calls heightfield_preview with CPU scalar drjit)
  - server.py /params  (PARAMS defines the UI controls)

All computation uses Dr.Jit ops (dr.floor, dr.sqrt, etc.) so the same functions
work for both GPU rendering and CPU preview — no duplicate code.
"""

import drjit as dr
import numpy as np
import io
from PIL import Image

# ============================================================================
# Parameter definitions — this IS the UI schema for the control panel
# ============================================================================

PARAMS = [
    {
        "name": "period",
        "label": "Period",
        "min": 50, "max": 2000, "step": 1,
        "default": 300,
        "unit": "um",
        "internal_name": "period",
        "internal_scale": 1e-6,
    },
    {
        "name": "hmax",
        "label": "Max Height",
        "min": 1, "max": 200, "step": 1,
        "default": 20,
        "unit": "um",
        "internal_name": "hmax",
        "internal_scale": 1e-6,
    },
    {
        "name": "rotation_speed",
        "label": "Rotation",
        "min": 0, "max": 200, "step": 1,
        "default": 0,
        "unit": "rad/m",
        "internal_name": "rotation_speed",
        "internal_scale": 1.0,
    },
    {
        "name": "jitter",
        "label": "Jitter",
        "min": 0, "max": 100, "step": 1,
        "default": 50,
        "unit": "%",
        "internal_name": "jitter",
        "internal_scale": 0.01,
    },
    {
        "name": "hmin_scale",
        "label": "Min Height %",
        "min": 0, "max": 100, "step": 1,
        "default": 15,
        "unit": "%",
        "internal_name": "hmin_scale",
        "internal_scale": 0.01,
    },
    {
        "name": "seed",
        "label": "Seed",
        "min": 0, "max": 999, "step": 1,
        "default": 42,
        "unit": "",
        "internal_name": "seed",
        "internal_scale": 1.0,
    },
]


def get_default_spec():
    """Return default heightfield sub-dict for the scene spec.
    Values are in internal units (meters, dimensionless)."""
    return {
        p["internal_name"]: p["default"] * p["internal_scale"]
        for p in PARAMS
    }


# ============================================================================
# Pseudo-random hash for per-cell variation
# ============================================================================

def _cell_hash(seed, cell_u, cell_v):
    """Hash (cell_u, cell_v) with seed to three pseudo-random values in [0,1).
    Uses sine-based hashing — works on Dr.Jit Float arrays (any backend)."""
    s1 = dr.sin(cell_u * 127.1 + cell_v * 311.7 + seed * 123.456) * 43758.5453
    s2 = dr.sin(cell_u * 269.5 + cell_v * 183.3 + seed * 789.012) * 43758.5453
    s3 = dr.sin(cell_u * 419.2 + cell_v * 89.7 + seed * 345.678) * 43758.5453
    # Fractional part of abs(sin) ensures [0, 1) range
    def _frac(v):
        return dr.abs(v) - dr.floor(dr.abs(v))
    return _frac(s1), _frac(s2), _frac(s3)


# ============================================================================
# Heightfield formula — Dr.Jit (works on any backend: CUDA, LLVM, scalar)
# ============================================================================


def evaluate(x, y, period, hmax, rotation_speed=0.0,
             jitter=0.5, hmin_scale=0.15, seed=42.0):
    """Height at world-space (x, y) in meters.

    Each pyramid cell gets:
      - Random peak height: hmax * (hmin_scale + (1 - hmin_scale) * hash1) in [hmin*hmax, hmax]
      - Random center jitter: peak offset by up to ±jitter/2 of the cell period

    Args:
        x, y: Dr.Jit Float (scalar or array), world-space coordinates in meters
        period: float, pyramid cell period in meters
        hmax: float, maximum pyramid peak height in meters
        rotation_speed: float, rotation rate in radians per meter
        jitter: float [0,1], max center displacement as fraction of cell period
        hmin_scale: float [0,1], minimum height as fraction of hmax
        seed: float, hash seed — different values produce different patterns

    Returns:
        Dr.Jit Float, height in meters
    """
    if period <= 0 or hmax <= 0:
        return x * 0.0

    cell_u = dr.floor(x / period)
    cell_v = dr.floor(y / period)

    # Per-cell pseudo-random values
    r_height, r_jx, r_jy = _cell_hash(seed, cell_u, cell_v)

    # Random height for this cell
    cell_hmax = hmax * (hmin_scale + (1.0 - hmin_scale) * r_height)

    # Jittered peak position in normalized cell coords [0, 1]
    peak_u = 0.5 + (r_jx - 0.5) * jitter
    peak_v = 0.5 + (r_jy - 0.5) * jitter

    # Local coords in cell [0, 1]
    u_local = x / period - cell_u
    v_local = y / period - cell_v

    if rotation_speed != 0.0:
        cell_cx = (cell_u + 0.5) * period
        cell_cy = (cell_v + 0.5) * period
        dist = dr.sqrt(cell_cx * cell_cx + cell_cy * cell_cy)
        angle = rotation_speed * dist
        uc = u_local - 0.5
        vc = v_local - 0.5
        cos_a = dr.cos(angle)
        sin_a = dr.sin(angle)
        u_local = uc * cos_a - vc * sin_a + 0.5
        v_local = uc * sin_a + vc * cos_a + 0.5

    du = dr.abs(u_local - peak_u)
    dv = dr.abs(v_local - peak_v)
    d = dr.maximum(du, dv)
    return cell_hmax * dr.maximum(1.0 - 2.0 * d, 0.0)


def gradient(x, y, period, hmax, rotation_speed=0.0, fd_step=1e-5,
             jitter=0.5, hmin_scale=0.15, seed=42.0):
    """Central-difference gradient at (x, y).

    Returns:
        (gx, gy): tuple of Dr.Jit Float, partial derivatives dh/dx and dh/dy
    """
    h = fd_step
    args = (period, hmax, rotation_speed, jitter, hmin_scale, seed)
    h_xp = evaluate(x + h, y, *args)
    h_xm = evaluate(x - h, y, *args)
    h_yp = evaluate(x, y + h, *args)
    h_ym = evaluate(x, y - h, *args)
    gx = (h_xp - h_xm) / (2.0 * h)
    gy = (h_yp - h_ym) / (2.0 * h)
    return gx, gy


# ============================================================================
# Preview thumbnail — CPU-side using dr.scalar backend
# ============================================================================


def heightfield_preview(width_px, height_px, period, hmax, rotation_speed,
                        center_x, center_y, size_mm,
                        jitter=0.5, hmin_scale=0.15, seed=42.0):
    """Generate a grayscale PNG preview of the heightfield.

    Args:
        width_px, height_px: image dimensions in pixels
        period, hmax, rotation_speed: heightfield parameters (meters, rad/m)
        center_x, center_y: view center in meters
        size_mm: view span in millimeters
        jitter: float [0,1], pyramid center jitter
        hmin_scale: float [0,1], minimum height fraction
        seed: float, random seed

    Returns:
        bytes: PNG image data
    """
    size_m = size_mm / 1000.0
    half = size_m / 2.0
    xs = np.linspace(center_x - half, center_x + half, width_px)
    ys = np.linspace(center_y - half, center_y + half, height_px)
    xv, yv = np.meshgrid(xs, ys)

    x_dr = dr.scalar.ArrayXf(xv.ravel())
    y_dr = dr.scalar.ArrayXf(yv.ravel())
    z_dr = evaluate(x_dr, y_dr, period, hmax, rotation_speed,
                    jitter, hmin_scale, seed)

    z = np.array(z_dr).reshape(height_px, width_px)

    z_min, z_max = z.min(), z.max()
    if z_max > z_min:
        z_norm = ((z - z_min) / (z_max - z_min) * 255).astype(np.uint8)
    else:
        z_norm = np.zeros((height_px, width_px), dtype=np.uint8)

    img = Image.fromarray(z_norm, mode="L")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()
