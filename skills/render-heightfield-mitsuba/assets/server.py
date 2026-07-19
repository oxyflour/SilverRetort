
"""Mitsuba 3 real-time path tracing server — WebRTC streaming.
Specular heightfield: custom BSDF computes normals from heightfield
differentials at ray-intersection time.
No PLY mesh, no precomputed textures.

Single source of truth: heightfield.py (drjit).
  - BSDF calls heightfield.evaluate/gradient (GPU/CUDA arrays)
  - /preview calls heightfield.heightfield_preview (CPU scalar drjit)
  - /params returns heightfield.PARAMS (the UI schema)

Usage:
  python server.py [path/to/heightfield.py]
"""

import asyncio
import importlib
import importlib.util
import json
import logging
import math
import sys
import time
from pathlib import Path

import numpy as np
import mitsuba as mi
import drjit as dr

mi.set_variant("cuda_ad_rgb")

from aiohttp import web
from aiortc import RTCPeerConnection, RTCSessionDescription, VideoStreamTrack
from av import VideoFrame

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("mitsuba-stream")

SITE_DIR = Path(__file__).parent.resolve()

# ============================================================================
# Dynamic import of heightfield.py (single source of truth)
# ============================================================================


def _import_heightfield(path):
    """Import a heightfield module from the given filesystem path."""
    spec = importlib.util.spec_from_file_location("heightfield", path)
    hf = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(hf)
    return hf


# Resolve the heightfield path from CLI arg or default
_hf_arg = sys.argv[1] if len(sys.argv) > 1 else str(SITE_DIR / "heightfield.py")
HF_PATH = str(Path(_hf_arg).resolve())
logger.info("Loading heightfield from: %s", HF_PATH)
heightfield = _import_heightfield(HF_PATH)

# Validate heightfield immediately — crash if evaluate/gradient are broken
try:
    import drjit as _dr
    _hf_d = heightfield.get_default_spec()
    _x = _dr.scalar.ArrayXf([0.0, 0.0001, 0.0002, 0.0003])
    _y = _dr.scalar.ArrayXf([0.0, 0.0001, 0.0002, 0.0003])
    _z = heightfield.evaluate(_x, _y, **_hf_d)
    _g = heightfield.gradient(_x, _y, **_hf_d)
    _z_np = np.array(_z)
    if np.any(np.isnan(_z_np)) or np.any(np.isinf(_z_np)):
        raise ValueError("evaluate returned NaN/Inf")
    logger.info("Heightfield OK — sample heights: %s", _z_np[:4].tolist())
except Exception as e:
    logger.critical("heightfield validation FAILED — %s", e)
    logger.critical("Fix heightfield.py and retry.")
    sys.exit(1)

# ============================================================================
# Default scene spec — built from heightfield defaults
# ============================================================================

DEFAULT_SCENE_SPEC = {
    "heightfield": {
        **heightfield.get_default_spec(),
        "fd_step": 0.000001,                     # 1 um FD step
        "reflectance": [0.95, 0.95, 0.95],
        "jitter": 0.5,                           # % of cell width, in internal units
        "hmin_scale": 0.15,                      # % of hmax, in internal units
        "seed": 42.0,                            # hash seed
    },
    "envmap": "studio/studio_envmap.exr",
}

# ============================================================================
# Custom BSDF: specular heightfield mirror
# ============================================================================


class HeightfieldMirror(mi.BSDF):
    def __init__(self, props):
        mi.BSDF.__init__(self, props)

        hf_defaults = DEFAULT_SCENE_SPEC["heightfield"]

        def get_float(name, default):
            if props.has_property(name):
                return float(props[name])
            return default

        self.fd_step = get_float("fd_step", hf_defaults["fd_step"])
        self.height_scale = get_float("height_scale", 1.0)
        self.uv_scale_x = get_float("uv_scale_x", 1.0)
        self.uv_scale_y = get_float("uv_scale_y", 1.0)
        self.uv_offset_x = get_float("uv_offset_x", 0.0)
        self.uv_offset_y = get_float("uv_offset_y", 0.0)

        self.period = get_float("period", hf_defaults["period"])
        self.hmax = get_float("hmax", hf_defaults["hmax"])
        self.rotation_speed = get_float(
            "rotation_speed", hf_defaults.get("rotation_speed", 0.0)
        )
        self.jitter = get_float("jitter", hf_defaults.get("jitter", 0.5))
        self.hmin_scale = get_float("hmin_scale", hf_defaults.get("hmin_scale", 0.15))
        self.seed = get_float("seed", hf_defaults.get("seed", 42.0))

        if props.has_property("reflectance"):
            self.reflectance = mi.Color3f(props["reflectance"])
        else:
            self.reflectance = mi.Color3f(1.0)

        self.m_flags = mi.BSDFFlags.DeltaReflection | mi.BSDFFlags.FrontSide
        self.m_components = [self.m_flags]

    def height_gradient(self, si):
        """Central-difference gradient dh/du, dh/dv in UV space."""
        x = si.uv.x * self.uv_scale_x + self.uv_offset_x
        y = si.uv.y * self.uv_scale_y + self.uv_offset_y

        dh_dx, dh_dy = heightfield.gradient(
            x, y, self.period, self.hmax, self.rotation_speed, self.fd_step,
            self.jitter, self.hmin_scale, self.seed
        )

        dh_du = self.height_scale * self.uv_scale_x * dh_dx
        dh_dv = self.height_scale * self.uv_scale_y * dh_dy

        return dh_du, dh_dv

    def perturbed_normal(self, si):
        dh_du, dh_dv = self.height_gradient(si)
        dp_du = si.to_local(si.dp_du)
        dp_dv = si.to_local(si.dp_dv)
        displaced_du = mi.Vector3f(dp_du.x, dp_du.y, dh_du)
        displaced_dv = mi.Vector3f(dp_dv.x, dp_dv.y, dh_dv)
        N = dr.normalize(dr.cross(displaced_du, displaced_dv))
        N = dr.select(N.z < 0.0, -N, N)
        invalid = si.wi.z * dr.dot(si.wi, N) <= 0.0
        N = dr.select(invalid, mi.Vector3f(-N.x, -N.y, N.z), N)
        return N

    def sample(self, ctx, si, sample1, sample2, active=True):
        del sample1, sample2
        enabled = ctx.is_enabled(mi.BSDFFlags.DeltaReflection, 0)
        active = active & enabled & (si.wi.z > 0.0)
        N = self.perturbed_normal(si)
        cos_theta_m = dr.dot(si.wi, N)
        active = active & (cos_theta_m > 0.0)
        wo = 2.0 * cos_theta_m * N - si.wi
        active = active & (wo.z > 0.0)
        bs = mi.BSDFSample3f()
        bs.wo = dr.select(active, wo, mi.Vector3f(0.0))
        bs.pdf = dr.select(active, 1.0, 0.0)
        bs.eta = 1.0
        bs.sampled_component = mi.UInt32(0)
        bs.sampled_type = mi.UInt32(+mi.BSDFFlags.DeltaReflection)
        weight = dr.select(active, self.reflectance, mi.Color3f(0.0))
        return bs, weight

    def eval(self, ctx, si, wo, active=True):
        return mi.Color3f(0.0)

    def pdf(self, ctx, si, wo, active=True):
        return mi.Float(0.0)

    def eval_pdf(self, ctx, si, wo, active=True):
        return self.eval(ctx, si, wo, active), self.pdf(ctx, si, wo, active)

    def to_string(self):
        return "HeightfieldMirror[]"


mi.register_bsdf("heightfield_mirror", lambda props: HeightfieldMirror(props))
logger.info("Registered custom BSDF: heightfield_mirror")


# ============================================================================
# Video track
# ============================================================================


class MitsubaTrack(VideoStreamTrack):
    kind = "video"

    def __init__(self, renderer):
        super().__init__()
        self._renderer = renderer
        self._counter = 0

    async def recv(self):
        pts, time_base = await self.next_timestamp()
        t0 = time.time()
        frame_rgba = await self._renderer.render_frame()

        video_frame = VideoFrame.from_ndarray(frame_rgba, format="rgba")
        video_frame.pts = pts
        video_frame.time_base = time_base

        dt = (time.time() - t0) * 1000
        self._counter += 1
        if self._counter % 30 == 0:
            logger.info(
                "Frame %d: %dx%d, %.1fms, total_spp=%d",
                self._counter,
                self._renderer.width,
                self._renderer.height,
                dt,
                self._renderer.total_spp,
            )
        return video_frame


# ============================================================================
# Renderer
# ============================================================================


class MitsubaRenderer:
    def __init__(self, width=640, height=480):
        self.width = width
        self.height = height
        self.spp_per_frame = 4
        self._scene_spec = dict(DEFAULT_SCENE_SPEC)

        self._target = np.array([0.0, 0.001, 0.0], dtype=np.float64)
        self._azimuth = math.radians(0)
        self._elevation = math.radians(30)
        self._distance = 0.4

        self._accum = None
        self._total_spp = 0
        self._seed = 0
        self._dirty = True
        self._scene = None
        self._scene_params = None
        self._build_scene()

        logger.info(
            "Renderer: %dx%d, spp_per_frame=%d, variant=%s",
            width,
            height,
            self.spp_per_frame,
            mi.variant(),
        )

    def _camera_to_world(self):
        az, el, dist = self._azimuth, self._elevation, self._distance
        x = dist * math.cos(el) * math.sin(az)
        y = dist * math.sin(el)
        z = dist * math.cos(el) * math.cos(az)
        origin = self._target + np.array([x, y, z])
        return mi.ScalarTransform4f.look_at(
            origin.tolist(),
            self._target.tolist(),
            [0.0, 1.0, 0.0],
        )

    def _reset_accumulation(self):
        self._dirty = True

    def _build_scene(self):
        hf = self._scene_spec["heightfield"]

        scene_dict = {
            "type": "scene",
            "integrator": {"type": "path", "max_depth": 8},
            "sensor": {
                "type": "perspective",
                "near_clip": 0.0001,
                "far_clip": 100.0,
                "to_world": self._camera_to_world(),
                "fov": 45,
                "film": {
                    "type": "hdrfilm",
                    "width": self.width,
                    "height": self.height,
                    "pixel_format": "rgba",
                },
            },
            "envmap": {
                "type": "envmap",
                "filename": self._scene_spec["envmap"],
            },
            "ground": {
                "type": "rectangle",
                "bsdf": {
                    "type": "diffuse",
                    "reflectance": {"type": "rgb", "value": [0.5, 0.5, 0.5]},
                },
                "to_world": (
                    mi.ScalarTransform4f.translate([0, -0.05, 0])
                    .rotate([1, 0, 0], -90)
                    .scale([0.25, 0.25, 1.0])
                ),
            },
            "pyramid_plate": {
                "type": "rectangle",
                "bsdf": {
                    "type": "heightfield_mirror",
                    "uv_scale_x": 0.16,
                    "uv_scale_y": 0.08,
                    "uv_offset_x": -0.08,
                    "uv_offset_y": -0.04,
                    "period": hf["period"],
                    "hmax": hf["hmax"],
                    "fd_step": hf.get(
                        "fd_step", DEFAULT_SCENE_SPEC["heightfield"]["fd_step"]
                    ),
                    "rotation_speed": hf.get("rotation_speed", 0.0),
                    "jitter": hf.get("jitter", 0.5),
                    "hmin_scale": hf.get("hmin_scale", 0.15),
                    "seed": hf.get("seed", 42.0),
                    "reflectance": hf.get(
                        "reflectance",
                        DEFAULT_SCENE_SPEC["heightfield"]["reflectance"],
                    ),
                },
                "to_world": (
                    mi.ScalarTransform4f.translate([0.0, 0.001, -0.0425])
                    .rotate([1, 0, 0], -90)
                    .scale([0.08, 0.04, 1.0])
                ),
            },
            "smooth_plate": {
                "type": "rectangle",
                "bsdf": {
                    "type": "conductor",
                    "material": "Ag",
                },
                "to_world": (
                    mi.ScalarTransform4f.translate([0.0, 0.001, 0.0425])
                    .rotate([1, 0, 0], -90)
                    .scale([0.08, 0.04, 1.0])
                ),
            },
        }

        self._scene = mi.load_dict(scene_dict)
        self._scene_params = mi.traverse(self._scene)
        self._reset_accumulation()

    def update_scene(self, spec):
        """Merge scene spec from the frontend — only supplied keys are updated."""
        changed = False
        for section in ("heightfield",):
            if section in spec:
                incoming = spec[section]
                current = self._scene_spec.setdefault(section, {})
                for k, v in incoming.items():
                    if current.get(k) != v:
                        changed = True
                        current[k] = v
        if "envmap" in spec and spec["envmap"] != self._scene_spec.get("envmap"):
            self._scene_spec["envmap"] = spec["envmap"]
            changed = True
        if changed:
            self._build_scene()

    def get_scene_spec(self):
        return dict(self._scene_spec)

    def update_camera(self, azimuth, elevation, distance, target=None):
        next_target = self._target
        if target is not None:
            next_target = np.array(target, dtype=np.float64)

        next_distance = max(0.05, min(5.0, distance))
        changed = (
            abs(self._azimuth - azimuth) > 1e-6
            or abs(self._elevation - elevation) > 1e-6
            or abs(self._distance - next_distance) > 1e-6
            or np.linalg.norm(self._target - next_target) > 1e-6
        )
        if not changed:
            return

        self._azimuth = azimuth
        self._elevation = elevation
        self._distance = next_distance
        self._target = next_target

        if self._scene_params is None:
            self._build_scene()
            return

        self._scene_params["sensor.to_world"] = self._camera_to_world()
        self._scene_params.update()
        self._reset_accumulation()

    def update_resolution(self, width, height):
        self.width = max(160, min(3840, width))
        self.height = max(120, min(2160, height))
        self._dirty = True
        self._build_scene()

    async def render_frame(self):
        if self._dirty:
            self._accum = None
            self._total_spp = 0
            self._seed = 0
            self._dirty = False

        bmp = mi.render(self._scene, spp=self.spp_per_frame, seed=self._seed)
        self._seed += 1
        arr = np.array(bmp, copy=True)

        if self._accum is None:
            self._accum = np.zeros_like(arr, dtype=np.float64)

        self._accum += arr.astype(np.float64) * self.spp_per_frame
        self._total_spp += self.spp_per_frame
        result = (self._accum / self._total_spp).astype(np.float32)
        result = np.clip(result, 0.0, 1.0)
        result_uint8 = (result * 255).astype(np.uint8)
        return np.ascontiguousarray(result_uint8)

    @property
    def total_spp(self):
        return self._total_spp


# ============================================================================
# Heightfield file watching (auto-reload on edit)
# ============================================================================

_last_hf_mtime = 0.0


def check_hf_reload():
    global _last_hf_mtime
    try:
        mt = Path(HF_PATH).stat().st_mtime
        if _last_hf_mtime == 0:
            _last_hf_mtime = mt
            return False
        if mt > _last_hf_mtime + 0.1:  # 100ms debounce
            _last_hf_mtime = mt
            return True
    except OSError:
        pass
    return False


def reload_heightfield():
    global heightfield, DEFAULT_SCENE_SPEC
    try:
        heightfield = importlib.reload(heightfield)
        # Rebuild default spec from reloaded module
        DEFAULT_SCENE_SPEC = {
            "heightfield": {
                **heightfield.get_default_spec(),
                "fd_step": 0.000001,
                "reflectance": [0.95, 0.95, 0.95],
                "jitter": 0.5,
                "hmin_scale": 0.15,
                "seed": 42.0,
            },
            "envmap": "studio/studio_envmap.exr",
        }
        logger.info("heightfield.py reloaded from %s", HF_PATH)
    except Exception as e:
        logger.warning("Failed to reload heightfield.py: %s", e)


async def hf_watchdog(interval=2.0):
    """Background task: periodically check for heightfield.py edits."""
    while True:
        await asyncio.sleep(interval)
        if check_hf_reload():
            reload_heightfield()


# ============================================================================
# HTTP / WebRTC
# ============================================================================

pcs = set()
CAMERA_UPDATE_INTERVAL = 0.08


async def handle_offer(request: web.Request):
    body = await request.json()
    offer = RTCSessionDescription(sdp=body["sdp"], type=body["type"])
    pc = RTCPeerConnection()
    pcs.add(pc)

    renderer = request.app["renderer"]
    data_channel_ref = []
    pending_camera = {"data": None}
    camera_flush_task = None
    last_camera_update = 0.0

    def apply_camera_update(data):
        renderer.update_camera(
            azimuth=data.get("azimuth", renderer._azimuth),
            elevation=data.get("elevation", renderer._elevation),
            distance=data.get("distance", renderer._distance),
            target=data.get("target", None),
        )

    async def flush_camera_updates():
        nonlocal camera_flush_task, last_camera_update
        try:
            while pending_camera["data"] is not None:
                wait = CAMERA_UPDATE_INTERVAL - (time.monotonic() - last_camera_update)
                if wait > 0.0:
                    await asyncio.sleep(wait)
                data = pending_camera["data"]
                pending_camera["data"] = None
                apply_camera_update(data)
                last_camera_update = time.monotonic()
        finally:
            camera_flush_task = None

    @pc.on("datachannel")
    def on_datachannel(channel):
        logger.info("Data channel opened: %s", channel.label)
        data_channel_ref.append(channel)

        @channel.on("message")
        def on_message(msg):
            nonlocal camera_flush_task, last_camera_update
            try:
                data = json.loads(msg)
            except Exception:
                return
            if data.get("type") == "camera":
                now = time.monotonic()
                if now - last_camera_update >= CAMERA_UPDATE_INTERVAL:
                    apply_camera_update(data)
                    last_camera_update = now
                else:
                    pending_camera["data"] = data
                    if camera_flush_task is None:
                        camera_flush_task = asyncio.ensure_future(flush_camera_updates())

    track = MitsubaTrack(renderer)
    pc.addTrack(track)

    @pc.on("iceconnectionstatechange")
    async def on_ice_state():
        if pc.iceConnectionState in ("failed", "closed"):
            await pc.close()
            pcs.discard(pc)
        elif pc.iceConnectionState in ("completed", "connected"):
            # Start sending SPP updates
            async def send_spp():
                last_spp = -1
                while True:
                    await asyncio.sleep(0.5)
                    if pc.iceConnectionState not in ("completed", "connected", "checking"):
                        break
                    spp = renderer.total_spp
                    if spp != last_spp and data_channel_ref:
                        try:
                            data_channel_ref[0].send(json.dumps({"total_spp": spp}))
                            last_spp = spp
                        except Exception:
                            break
            asyncio.ensure_future(send_spp())

    await pc.setRemoteDescription(offer)
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    return web.json_response({"sdp": pc.localDescription.sdp, "type": pc.localDescription.type})


async def handle_config(request: web.Request):
    body = await request.json()
    renderer = request.app["renderer"]
    if "width" in body and "height" in body:
        renderer.update_resolution(body["width"], body["height"])
    return web.json_response({"ok": True})


async def handle_scene(request: web.Request):
    """GET /scene — return current scene spec."""
    renderer = request.app["renderer"]
    return web.json_response(renderer.get_scene_spec())


async def handle_interactive(request: web.Request):
    """POST /interactive — update scene spec."""
    body = await request.json()
    renderer = request.app["renderer"]
    renderer.update_scene(body)
    return web.json_response({"ok": True})


async def handle_params(request: web.Request):
    """GET /params — return PARAMS from heightfield.py (UI schema)."""
    return web.json_response(heightfield.PARAMS)


async def handle_preview(request: web.Request):
    """GET /preview — grayscale PNG thumbnail of the heightfield."""
    try:
        period = float(request.query.get("period", str(DEFAULT_SCENE_SPEC["heightfield"]["period"])))
        hmax = float(request.query.get("hmax", str(DEFAULT_SCENE_SPEC["heightfield"]["hmax"])))
        rotation_speed = float(request.query.get("rotation_speed", "0"))
        center_x = float(request.query.get("center_x", "0"))
        center_y = float(request.query.get("center_y", "0"))
        size_mm = float(request.query.get("size_mm", "2"))
        jitter = float(request.query.get("jitter", str(DEFAULT_SCENE_SPEC["heightfield"]["jitter"])))
        hmin_scale = float(request.query.get("hmin_scale", str(DEFAULT_SCENE_SPEC["heightfield"]["hmin_scale"])))
        seed = float(request.query.get("seed", str(DEFAULT_SCENE_SPEC["heightfield"]["seed"])))

        png_data = heightfield.heightfield_preview(
            128, 128, period, hmax, rotation_speed,
            center_x, center_y, size_mm,
            jitter=jitter, hmin_scale=hmin_scale, seed=seed,
        )
        return web.Response(body=png_data, content_type="image/png")
    except Exception as e:
        logger.warning("Preview error: %s", e)
        return web.Response(status=500, text=str(e))


# ============================================================================
# App setup
# ============================================================================

def create_app():
    app = web.Application()
    renderer = MitsubaRenderer(width=640, height=480)
    app["renderer"] = renderer

    app.router.add_post("/offer", handle_offer)
    app.router.add_post("/config", handle_config)
    app.router.add_get("/scene", handle_scene)
    app.router.add_post("/interactive", handle_interactive)
    app.router.add_get("/params", handle_params)
    app.router.add_get("/preview", handle_preview)

    # Serve index.html at root
    async def handle_index(request):
        return web.FileResponse(SITE_DIR / "index.html")
    app.router.add_get("/", handle_index)

    # Serve static files from SITE_DIR
    app.router.add_static("/", path=str(SITE_DIR), show_index=False)

    return app


def main():
    app = create_app()
    runner = web.AppRunner(app)

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    loop.run_until_complete(runner.setup())
    site = web.TCPSite(runner, "0.0.0.0", 8766)
    loop.run_until_complete(site.start())

    # Start heightfield file watcher
    loop.create_task(hf_watchdog())

    logger.info("Server running on http://0.0.0.0:8766")
    try:
        loop.run_forever()
    except KeyboardInterrupt:
        pass
    finally:
        loop.run_until_complete(runner.cleanup())
        loop.close()


if __name__ == "__main__":
    main()
