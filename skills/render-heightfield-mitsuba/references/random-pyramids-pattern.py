"""
Reference: skeleton of a heightfield.py with random pyramids.

Key concepts:
  - _cell_hash() uses sine-based hashing for per-cell pseudo-randomness
  - Each cell gets: random height, jittered center position
  - PARAMS exposes jitter, hmin_scale, seed as UI sliders
  - The same evaluate() code runs on GPU (CUDA arrays) and CPU (scalar arrays)

To add a new per-cell random attribute:
  1. Add a 4th hash value to _cell_hash()
  2. Add a corresponding PARAMS entry
  3. Use the hash in evaluate() to modulate the new attribute
  4. Wire through gradient(), heightfield_preview(), and server.py BSDF
"""

import drjit as dr

PARAMS = [
    {"name": "period",     "label": "Period",     "min": 50, "max": 2000, "step": 1, "default": 300, "unit": "um", "internal_name": "period",         "internal_scale": 1e-6},
    {"name": "hmax",       "label": "Max Height",  "min": 1,  "max": 200,  "step": 1, "default": 20,  "unit": "um", "internal_name": "hmax",           "internal_scale": 1e-6},
    {"name": "rotation",   "label": "Rotation",    "min": 0,  "max": 200,  "step": 1, "default": 0,   "unit": "rad/m", "internal_name": "rotation_speed", "internal_scale": 1.0},
    {"name": "jitter",     "label": "Jitter",      "min": 0,  "max": 100,  "step": 1, "default": 50,  "unit": "%", "internal_name": "jitter",          "internal_scale": 0.01},
    {"name": "hmin_scale", "label": "Min Height %", "min": 0,  "max": 100,  "step": 1, "default": 15,  "unit": "%", "internal_name": "hmin_scale",      "internal_scale": 0.01},
    {"name": "seed",       "label": "Seed",        "min": 0,  "max": 999,  "step": 1, "default": 42,  "unit": "", "internal_name": "seed",            "internal_scale": 1.0},
]


def get_default_spec():
    return {p["internal_name"]: p["default"] * p["internal_scale"] for p in PARAMS}


def _cell_hash(seed, cell_u, cell_v):
    """Hash (cell_u, cell_v) + seed -> three pseudo-random values in [0,1).

    Uses sine-based hashing with large multipliers. `abs(v) - floor(abs(v))`
    ensures [0, 1) output regardless of sine sign. Works on any Dr.Jit
    backend (CUDA arrays, scalar arrays, LLVM).
    """
    s1 = dr.sin(cell_u * 127.1 + cell_v * 311.7 + seed * 123.456) * 43758.5453
    s2 = dr.sin(cell_u * 269.5 + cell_v * 183.3 + seed * 789.012) * 43758.5453
    s3 = dr.sin(cell_u * 419.2 + cell_v * 89.7 + seed * 345.678) * 43758.5453

    def _frac(v):
        # dr.fmod does NOT exist in Dr.Jit — use abs - floor instead
        return dr.abs(v) - dr.floor(dr.abs(v))

    return _frac(s1), _frac(s2), _frac(s3)


def evaluate(x, y, period, hmax, rotation_speed=0.0,
             jitter=0.5, hmin_scale=0.15, seed=42.0):
    """Height at (x, y) in metres with per-cell random variation."""
    if period <= 0 or hmax <= 0:
        return x * 0.0

    cell_u = dr.floor(x / period)
    cell_v = dr.floor(y / period)

    # Per-cell pseudo-random: height scale, x-jitter, y-jitter
    r_height, r_jx, r_jy = _cell_hash(seed, cell_u, cell_v)
    cell_hmax = hmax * (hmin_scale + (1.0 - hmin_scale) * r_height)
    peak_u = 0.5 + (r_jx - 0.5) * jitter
    peak_v = 0.5 + (r_jy - 0.5) * jitter

    u_local = x / period - cell_u
    v_local = y / period - cell_v

    # Rotation (optional)
    if rotation_speed != 0.0:
        cx = (cell_u + 0.5) * period
        cy = (cell_v + 0.5) * period
        dist = dr.sqrt(cx * cx + cy * cy)
        angle = rotation_speed * dist
        uc, vc = u_local - 0.5, v_local - 0.5
        cos_a, sin_a = dr.cos(angle), dr.sin(angle)
        u_local = uc * cos_a - vc * sin_a + 0.5
        v_local = uc * sin_a + vc * cos_a + 0.5

    du = dr.abs(u_local - peak_u)
    dv = dr.abs(v_local - peak_v)
    d = dr.maximum(du, dv)
    return cell_hmax * dr.maximum(1.0 - 2.0 * d, 0.0)


def gradient(x, y, period, hmax, rotation_speed=0.0, fd_step=1e-5,
             jitter=0.5, hmin_scale=0.15, seed=42.0):
    """Central-difference gradient. All extra params forwarded to evaluate()."""
    h = fd_step
    args = (period, hmax, rotation_speed, jitter, hmin_scale, seed)
    gx = (evaluate(x + h, y, *args) - evaluate(x - h, y, *args)) / (2.0 * h)
    gy = (evaluate(x, y + h, *args) - evaluate(x, y - h, *args)) / (2.0 * h)
    return gx, gy


def heightfield_preview(width_px, height_px, period, hmax, rotation_speed,
                        center_x, center_y, size_mm,
                        jitter=0.5, hmin_scale=0.15, seed=42.0):
    """CPU-side PNG preview using dr.scalar backend."""
    import numpy as np
    from PIL import Image
    import io

    size_m = size_mm / 1000.0
    half = size_m / 2.0
    xs = np.linspace(center_x - half, center_x + half, width_px)
    ys = np.linspace(center_y - half, center_y + half, height_px)
    xv, yv = np.meshgrid(xs, ys)
    x_dr = dr.scalar.ArrayXf(xv.ravel())
    y_dr = dr.scalar.ArrayXf(yv.ravel())
    z_dr = evaluate(x_dr, y_dr, period, hmax, rotation_speed, jitter, hmin_scale, seed)
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
