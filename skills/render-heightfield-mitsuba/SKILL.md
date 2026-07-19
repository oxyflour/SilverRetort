---
name: render-heightfield-mitsuba
description: Render specular heightfield surfaces in Mitsuba 3 via a custom Python BSDF that computes normals analytically at shading time using finite differences — no PLY mesh, no precomputed textures.
---

# Render Heightfield Specular BRDF in Mitsuba

Real-time specular heightfield rendering using a custom Mitsuba 3 Python BSDF. The height function `z = height(x, y)` is evaluated at every ray intersection; surface normals are computed via centered finite differences (default 1 um step). The BSDF is a delta mirror (specular reflection) with user-configurable reflectance. No mesh generation, no texture precomputation — the surface is a flat `rectangle` and all geometric detail lives in the BSDF.

Prerequisite: understand the WebRTC streaming architecture from the `render-with-mitsuba` skill. This skill focuses only on the custom BSDF and scene setup for heightfields.

## Quick start

Copy `assets/heightfield.py`, `assets/server.py`, and `assets/index.html` into your workspace. Download an HDR envmap to `studio/studio_envmap.exr` or provide your own path in `_build_scene()`. Then:

```bash
python server.py    # loads ./heightfield.py, binds 127.0.0.1:8766
```

Show the artifact via `mcp__silverretort_ui__ui_show_artifact` with `type="iframe"` and `payload={workspacePort: {port: 8766}}`. NEVER use `{path: "index.html"}` — the path artifact has caching issues and the wrong origin for WebRTC. Always use `workspacePort`.

Display via Hermes artifact:

```python
show_artifact(
    type="iframe",
    title="Heightfield Mirror",
    payload={"workspacePort": {"port": 8766}},
)
```

The server serves index.html at root `/`. Do NOT add a `path` that doesn't match an actual HTTP route on the server (e.g. `"path": "mitsuba-stream/index.html"` will 404). The `workspacePort.path` is an HTTP route, not a workspace file path.

## Architecture: heightfield.py — single source of truth

**`heightfield.py`** is the ONLY place the heightfield formula lives. It uses Dr.Jit ops (`dr.floor`, `dr.sqrt`, `dr.abs`, `dr.maximum`, `dr.cos`, `dr.sin`) so the same `evaluate()` and `gradient()` functions work for both GPU rendering (CUDA arrays) and CPU preview (scalar arrays). No duplicate code.

It also exports:
- `PARAMS` — list of dicts defining the UI control schema (name, label, min, max, step, default, unit, internal_scale)
- `get_default_spec()` — builds the default heightfield scene spec from PARAMS defaults
- `heightfield_preview()` — generates a PNG preview using `dr.scalar.ArrayXf`

**`server.py`** imports `evaluate`, `gradient`, `heightfield_preview`, `PARAMS`, and `get_default_spec` from heightfield.py. The custom BSDF calls `heightfield.gradient()` directly — there is no inline `evaluate_drjit()` anymore.

The server validates the heightfield at import time: it calls `evaluate()` and `gradient()` via `dr.scalar.ArrayXf` with `**heightfield.get_default_spec()`. If either crashes or returns NaN/Inf, the server logs the error and calls `sys.exit(1)` BEFORE starting the HTTP server. See Pitfall 17 for details.

The `/preview` endpoint reads `jitter`, `hmin_scale`, and `seed` from query params and passes them to `heightfield.heightfield_preview()`, keeping the preview and render output in sync.

**`index.html`** fetches `GET /params` on startup and dynamically builds the slider control panel from the returned schema. Adding a new parameter only requires editing `heightfield.py`'s `PARAMS` list — the UI updates automatically.

All three files live in the workspace (copy from skill assets/):
```
heightfield.py     # PARAMS + evaluate/gradient/preview — edit THIS file to change the formula
server.py          # import heightfield; BSDF; HTTP/WebRTC; preview endpoint
index.html         # frontend — PARAMS-driven sliders, preview overlay, SPP bottom-right
```

## Scene spec and live controls

The scene definition is split: plate transforms and camera live on the server, but the heightfield parameters (`period`, `hmax`, etc.) and envmap path live in the frontend as a JSON "scene spec" object. The frontend is the authoritative source — it POSTs the spec to `POST /scene` on startup (after syncing from `GET /scene`) and on every parameter change.

### Default scene spec (built from heightfield.get_default_spec())

```python
# server.py builds this from heightfield.py's PARAMS + fixed extras:
DEFAULT_SCENE_SPEC = {
    "heightfield": {
        **heightfield.get_default_spec(),  # period, hmax, rotation_speed from PARAMS
        "fd_step": 0.000001,               # 1 um
        "reflectance": [0.95, 0.95, 0.95],
    },
    "envmap": "studio/studio_envmap.exr",
}
```

The frontend fetches `GET /params` to learn the slider ranges and defaults, then builds its own DEFAULT_SCENE_SPEC from these values. Both sides stay in sync because they derive from the same source: `heightfield.PARAMS`.

### HTTP endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/scene` | Return current scene spec (JSON) |
| `POST` | `/scene` | Merge partial or full scene spec; triggers `_build_scene()` immediately |
| `GET` | `/params` | Return the UI control schema (`PARAMS` list from heightfield.py). Used by the frontend to dynamically build sliders. |
| `GET` | `/preview?period=...&hmax=...&rotation_speed=...&center_x=...&center_y=...&size_mm=...` | Return heightfield thumbnail PNG generated by `heightfield.py` |

The `POST` handler does a **deep merge** at leaf keys — sending only `{"heightfield": {"period": 0.0005}}` changes just the period and leaves `hmax`, `fd_step`, `reflectance`, and `envmap` untouched.

### Frontend overlay

The `index.html` page fetches `GET /params` on startup and dynamically builds the control panel from the returned schema. Each slider row is generated from a param definition in `heightfield.PARAMS`. To add a new control, edit `heightfield.py`'s `PARAMS` list — the UI updates automatically with no HTML changes.

Sliders debounce at 150ms before POSTing to `/scene`. Changing parameters resets SPP accumulation (the scene rebuilds, so accumulation starts fresh). A "Reset defaults" button restores the default spec.

### UI layout

Three overlay regions floating over the canvas:

- **Top-left**: slider control panel (dynamic, built from `GET /params`)
- **Top-right**: heightfield preview thumbnail (server-rendered PNG, drag/pannable, zoom with scroll wheel)
- **Bottom-right**: SPP counter (live from WebRTC data channel, shows current accumulated samples)

No bottom info bar — the old "SPP accumulates when idle" text has been removed. The SPP counter is a minimal floating label at bottom-right that updates in real time via data channel messages.

### Heightfield preview thumbnail (top-right overlay, server-side)

The preview thumbnail floats in the top-right corner of the canvas as a standalone overlay (`#preview-overlay`). It fetches `GET /preview?period=...&hmax=...&rotation_speed=...&jitter=...&hmin_scale=...&seed=...&center_x=...&center_y=...&size_mm=...`. The server computes the heightfield using `heightfield.heightfield_preview()` which calls the same `evaluate()` function that the BSDF uses (via `dr.scalar.ArrayXf` for CPU-side computation). The frontend `<img>` tag updates its `src` on parameter changes — no client-side computation.

When you edit `heightfield.py`, the background watchdog task detects the change and calls `importlib.reload(heightfield)`, so the next preview request AND the next BSDF evaluation use the updated formula. No server restart needed.

- **Default view**: 2 mm × 2 mm centered at (0, 0) on the physical plate
- **Pan**: drag on the preview to move around the heightfield surface
- **Zoom**: scroll on the preview to change the visible range (0.2–20 mm)
- **Live update**: moving any slider immediately updates the preview image URL
- **Info label**: shows current range in mm below the preview

Camera controls (drag to orbit, scroll to zoom, shift-drag to pan) send updates through the same WebRTC data channel (type `"camera"` messages). See the data channel section below for details. Resolution changes still use the `/config` endpoint.

The BSDF class `HeightfieldMirror` is defined in `server.py`. It calls `heightfield.gradient()` for the surface normal computation — the heightfield formula itself lives in `heightfield.py`. The BSDF registers as `"heightfield_mirror"` and is usable in scene dicts via `{"type": "heightfield_mirror", ...}`.

### Architecture

```
Ray hits rectangle → si.p, si.uv, si.wi (all in local shading frame)
    → uv-to-physical mapping: x = uv.x * uv_scale_x + uv_offset_x
    → height_gradient(si): centered finite differences dh/dx, dh/dy at step ±fd_step
    → perturbed_normal(si): build local-frame normal from si.to_local(si.dp_du/dv) + dh
    → sample(): mirror reflection wo = 2(N·wi)N - wi
    → return (BSDFSample3f, weight)
```

### UV-to-physical coordinate mapping

Rectangle shapes have UV in [0, 1]. Map to physical metres:

```
x = uv.x * uv_scale_x + uv_offset_x
y = uv.y * uv_scale_y + uv_offset_y
```

For a 160 x 80 mm plate centered at origin: `uv_scale_x=0.16, uv_scale_y=0.08, uv_offset_x=-0.08, uv_offset_y=-0.04`.

Chain rule for height gradients (h has units of metres, uv is dimensionless):

```
dh_du = height_scale * uv_scale_x * dh_dx
dh_dv = height_scale * uv_scale_y * dh_dy
```

### Perturbed normal computation

CRITICAL: `si.wi`, `si.n`, and the BSDF output `wo` are all in the LOCAL SHADING FRAME where the geometric normal is (0, 0, 1). Compute the perturbed normal in this same frame:

```python
def perturbed_normal(self, si):
    dh_du, dh_dv = self.height_gradient(si)

    # Convert world-space tangents to local shading frame
    dp_du = si.to_local(si.dp_du)
    dp_dv = si.to_local(si.dp_dv)

    # Bump mapping: replace z with height derivatives
    displaced_du = Vector3f(dp_du.x, dp_du.y, dh_du)
    displaced_dv = Vector3f(dp_dv.x, dp_dv.y, dh_dv)

    N = normalize(cross(displaced_du, displaced_dv))
    N = select(N.z < 0, -N, N)       # face same hemisphere as geometric normal

    # Guard: prevent wi from piercing perturbed surface
    invalid = si.wi.z * dot(si.wi, N) <= 0
    N = select(invalid, Vector3f(-N.x, -N.y, N.z), N)
    return N
```

### Heightfield formula (Dr.Jit, from heightfield.py)

The `evaluate()` and `gradient()` functions live in `heightfield.py` — the single source of truth. They use Dr.Jit ops (`dr.floor`, `dr.sqrt`, etc.) so they work for both GPU rendering (CUDA arrays) and CPU preview (scalar arrays). Use `dr.floor` (not `%`) for sign-independent periodicity.

The current default formula is **random pyramids**: each cell gets pseudo-random height and jittered center position via sine-based hash of `(seed, cell_u, cell_v)`. See `assets/heightfield.py` for the full implementation. Key points:

- `_cell_hash(seed, cell_u, cell_v)` — deterministic hash returning 3 values in [0, 1) using only Dr.Jit ops
- `cell_hmax = hmax * (hmin_scale + (1 - hmin_scale) * r_height)` — random height per cell
- `peak_u = 0.5 + (r_jx - 0.5) * jitter` — jittered peak position
- Pyramid distance computed from jittered peak: `d = max(|u - peak_u|, |v - peak_v|)`
- Return `cell_hmax * max(1.0 - 2.0 * d, 0.0)`

### Per-cell random variation via hash functions

The current heightfield (random pyramids) uses a deterministic hash function on
the cell index `(cell_u, cell_v)`. This preserves differentiability for the
finite-difference gradient while giving each cell unique parameters. The hash
lives in `heightfield.py` and uses only Dr.Jit ops:

```python
def _cell_hash(seed, cell_u, cell_v):
    """Hash (cell_u, cell_v) + seed -> three pseudo-random values in [0,1)."""
    s1 = dr.sin(cell_u * 127.1 + cell_v * 311.7 + seed * 123.456) * 43758.5453
    s2 = dr.sin(cell_u * 269.5 + cell_v * 183.3 + seed * 789.012) * 43758.5453
    s3 = dr.sin(cell_u * 419.2 + cell_v * 89.7 + seed * 345.678) * 43758.5453

    def _frac(v):
        return dr.abs(v) - dr.floor(dr.abs(v))

    return _frac(s1), _frac(s2), _frac(s3)
```

`dr.abs` + `frac(v) = abs(v) - floor(abs(v))` ensures [0, 1) output regardless of sine sign.
**Do NOT use `dr.fmod` — it does not exist in Dr.Jit.**
Use the three hash values for:
- `r_height`: scale hmax per cell: `cell_hmax = hmax * (hmin_scale + (1 - hmin_scale) * r_height)`
- `r_jx`, `r_jy`: jitter the pyramid peak within the cell: `peak_u = 0.5 + (r_jx - 0.5) * jitter`

Then compute pyramid distance from the jittered peak instead of (0.5, 0.5):

```python
du = dr.abs(u_local - peak_u)
dv = dr.abs(v_local - peak_v)
d = dr.maximum(du, dv)
return cell_hmax * dr.maximum(1.0 - 2.0 * d, 0.0)
```

Expose `jitter`, `hmin_scale`, and `seed` in PARAMS and wire them through
`evaluate()`, `gradient()`, and `heightfield_preview()`. See `assets/heightfield.py`
for the full working pattern.

### BSDF properties (configurable in scene dict)

| Property | Default | Description |
|---|---|---|
| `period` | 3e-4 (0.3 mm) | Pyramid cell period in metres |
| `hmax` | 1e-5 (0.01 mm) | Pyramid peak height in metres |
| `rotation_speed` | 0.0 | Pyramid rotation rate in rad/m (radians per metre from center) |
| `jitter` | 0.5 | Max center displacement as fraction of cell period [0, 1] |
| `hmin_scale` | 0.15 | Minimum height as fraction of hmax [0, 1]; cells get random heights in [hmin_scale*hmax, hmax] |
| `seed` | 42.0 | Hash seed — different values produce different pseudo-random patterns |
| `fd_step` | 1e-6 (1 um) | Finite difference step in metres |
| `height_scale` | 1.0 | Overall height multiplier |
| `uv_scale_x` | 1.0 | UV-to-physical X scale |
| `uv_scale_y` | 1.0 | UV-to-physical Y scale |
| `uv_offset_x` | 0.0 | UV-to-physical X offset |
| `uv_offset_y` | 0.0 | UV-to-physical Y offset |
| `reflectance` | [0.95, 0.95, 0.95] | Mirror reflectance (Color3f) |

The `period` and `hmax` properties are injected into the scene dict from the frontend's scene spec and passed through to the BSDF. The module-level `evaluate()` function receives them as arguments — no global variables.

### Scene dict example

```python
scene_dict = {
    ...
    "pyramid_plate": {
        "type": "rectangle",
        "bsdf": {
            "type": "heightfield_mirror",
            "uv_scale_x": 0.16,
            "uv_scale_y": 0.08,
            "uv_offset_x": -0.08,
            "uv_offset_y": -0.04,
            "period": 0.0003,   # from scene spec
            "hmax": 0.00001,    # from scene spec
            "reflectance": [0.95, 0.95, 0.95],
        },
        "to_world": (
            mi.ScalarTransform4f.translate([0, 0.001, 0])
            .rotate([1, 0, 0], -90)
            .scale([0.08, 0.04, 1.0])
        ),
    },
}
```

### Rectangle transform chain for horizontal plates

The default `rectangle` is a 2x2 quad in the XY plane (z=0), centered at origin. To create a horizontal (Y-up) rectangle of size WxD at (px, py, pz):

```
to_world = translate([px, py, pz]).rotate([1,0,0], -90).scale([W/2, D/2, 1])
```

The third scale component must be non-zero (use 1) to keep the transform matrix invertible — a zero in the normal-axis scale produces NaN normals (black surface).

### Debugging: verify the BSDF is active

If the heightfield surface renders identically to a smooth reference:

1. **Pink test**: Replace `weight` with `mi.Color3f(0, 0.5, 0)` in `sample()`. A green-tinted reflection proves the BSDF is active.
2. **Hardcoded tilt**: Replace `perturbed_normal()` with a hardcoded 45 deg tilt. If the reflection doesn't shift, the BSDF plumbing is broken.
3. **Sub-pixel features**: If each pyramid cell is < 2 px at the current resolution, the pattern is unresolvable. Compute `pixels_per_feature = (period / plate_width) * render_width`.

### Side-by-side comparison

Place two plates at `z = ±(plate_half_depth + gap/2)` with identical geometries but different BSDFs. Example for 160x80mm plates with 5mm gap:

```python
# Pyramid heightfield — z = -42.5 mm
"pyramid_plate": {
    "bsdf": {"type": "heightfield_mirror", ...},
    "to_world": translate([0, 0.001, -0.0425]).rotate([1,0,0], -90).scale([0.08, 0.04, 1.0]),
},
# Smooth reference — z = +42.5 mm
"smooth_plate": {
    "bsdf": {"type": "conductor", "material": "Ag"},
    "to_world": translate([0, 0.001, 0.0425]).rotate([1,0,0], -90).scale([0.08, 0.04, 1.0]),
},
```

Adjust default camera distance to cover both plates: `distance >= total_span / (2 * tan(fov/2)) * 1.1`.

## Lighting

The scene uses an environment map emitter. Discrete point/area lights produce poor results on specular surfaces — the rendering becomes essentially black and white because the mirror BSDF only reflects the tiny bright light sources against a dark background. The envmap provides structured environment reflections that make the surface readable.

The envmap path is live-configurable via `POST /scene` with `{"envmap": "studio/another_envmap.exr"}` — no server restart needed. Switching between fundamentally different lighting types (envmap → area lights → point lights) still requires editing `_build_scene()` and restarting.

The filename is relative to the server working directory (where `server.py` lives). If the path is wrong, Mitsuba crashes at startup with an I/O error. The skill includes `studio_envmap.exr`; alternatives in the same directory are `studio_01_2k.exr` and `studio_country_hall_2k.exr`.

## WebRTC data channel: SPP push + camera updates (no HTTP polling)

The WebRTC data channel (`"stats"`) is bidirectional — it replaces both HTTP polling for SPP and HTTP POST for camera updates. The channel is a single `"stats"` data channel carrying both SPP (server→client) and camera (client→server) messages.

**CRITICAL: the offerer must create the data channel.** In this architecture the browser (client) is the offerer, so the client creates the channel with `pc.createDataChannel('stats')` BEFORE calling `createOffer()`. The server (answerer) receives it via `@pc.on("datachannel")`. Creating the data channel on the answerer side (`pc.createDataChannel` in server) is unreliable — the channel may establish but `onmessage` handlers may never fire.

### SPP push (server → client)

The server receives the client's data channel in `handle_offer` via `@pc.on("datachannel")`. It saves the channel reference in a mutable container (list) and creates a `MitsubaTrackDC` subclass that overrides `recv()` to send `{"total_spp": N}` after each frame render. The subclass avoids modifying the base `MitsubaTrack` class (which is also used by the `render-with-mitsuba` skill).

### Camera updates (client → server)

When the user drags or scrolls the view, the client's `sendCamera()` sends `{"type": "camera", azimuth, elevation, distance, target}` through its own `dc` (the channel it created). The server's `on_datachannel` handler sets up a `channel.on("message")` listener that parses these messages and calls `renderer.update_camera()`.

### Server-side code

```python
async def handle_offer(request: web.Request):
    ...
    renderer = request.app["renderer"]
    data_channel_ref = []  # mutable container for closure

    @pc.on("datachannel")
    def on_datachannel(channel):
        logger.info("Data channel opened: %s", channel.label)
        data_channel_ref.append(channel)
        @channel.on("message")
        def on_message(msg):
            try:
                data = json.loads(msg)
            except Exception:
                return
            if data.get("type") == "camera":
                renderer.update_camera(
                    azimuth=data.get("azimuth", renderer._azimuth),
                    elevation=data.get("elevation", renderer._elevation),
                    distance=data.get("distance", renderer._distance),
                    target=data.get("target"),
                )

    class MitsubaTrackDC(MitsubaTrack):
        async def recv(self):
            frame = await super().recv()
            if data_channel_ref and data_channel_ref[0].readyState == "open":
                msg = json.dumps({"total_spp": self._renderer.total_spp})
                data_channel_ref[0].send(msg)
            return frame

    track = MitsubaTrackDC(renderer)
    ...
```

### Client-side code

```javascript
let pc = null;
let dc = null;

async function connect() {
    pc = new RTCPeerConnection({...});
    pc.addTransceiver('video', { direction: 'recvonly' });

    // Client is the offerer — create data channel BEFORE createOffer
    dc = pc.createDataChannel('stats');
    dc.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.total_spp !== undefined
            && !cameraDirty && !sceneDirty && !interactiveMode) {
            totalSpp = msg.total_spp;
            updateSppDisplay();
        }
    };

    // ... ontrack, onconnectionstatechange ...
    const offer = await pc.createOffer();
    // ... send offer, get answer, set remote description ...
}

function sendCamera() {
    if (dc && dc.readyState === 'open') {
        dc.send(JSON.stringify({
            type: 'camera', azimuth, elevation, distance, target
        }));
    }
}
```

This eliminates both the `setInterval` polling of `/state` and the `fetch('camera', ...)` HTTP POSTs. The `/state` and `/camera` HTTP endpoints still exist in the codebase for debugging but are not used during normal operation.

## Pitfalls

1. **Coordinate space mismatch**: `si.wi` is in the LOCAL SHADING FRAME (geometric normal = (0,0,1)). Computing a world-space normal from `si.p` and dotting it with local `si.wi` produces garbage. Always use `si.to_local(si.dp_du/dv)` to build the normal in the local frame.

2. **UV-to-physical mapping is mandatory**: Without `uv_scale_x/y` and `uv_offset_x/y`, the height function is evaluated over UV range [0,1] instead of the physical plate dimensions. The spatial frequency will be wrong.

3. **`sample()` returns `(BSDFSample3f, Spectrum)`, NOT `(BSDFSample3f, active)`**: The second return value is the BSDF weight, not the active mask. Do NOT set `bs.value`.

4. **`bs.sampled_type` must be `mi.UInt32(+mi.BSDFFlags.DeltaReflection)`**: The unary `+` cast may not compile alone — wrap in `mi.UInt32()`.

5. **`eval()` and `pdf()` return single values for `cuda_ad_rgb`**: Return `Color3f(0)` and `Float(0)`, NOT tuples. The multi-return form compiles on `scalar_rgb` but fails on `cuda_ad_rgb`.

6. **Height field must use Dr.Jit functions only**: No `numpy`, no `math.sin`. Use `dr.floor`, `dr.abs`, `dr.maximum`, etc.

7. **Triangle winding in PLY meshes** (if you ever fall back to meshes): Counterclockwise from +Y = upward normals. Clockwise = black surface.

8. **Sub-pixel features are invisible**: At 640px render width and 0.3mm period on 160mm plate, each pyramid is ~1.2 px — unresolvable. Increase render resolution or enlarge the period to see the pattern.

9. **Point/area lights wash out specular surfaces**: On a pure mirror BSDF, discrete lights reflect only the tiny bright emitter geometry against the dark void. The result looks black-and-white and loses all environment context. Use the envmap for structured background reflections.

10. **Server must be restarted after lighting-type changes**: Switching between fundamentally different emitters (envmap → area lights → point lights) requires editing `_build_scene()` and restarting. However, heightfield parameters (`period`, `hmax`, `fd_step`, `reflectance`) and the **envmap path** are live-configurable via `POST /scene` — no restart needed.

11. **workspacePort iframe path rules**: (a) `workspacePort.path` is an HTTP route on the server, NOT a workspace file path — verify with `curl` before using. If the server serves at `/`, pass only `{"port": 8766}`. (b) Server API calls in the HTML MUST use relative paths (`fetch('offer')`), NOT root-relative (`fetch('/offer')`), because the page is served through a proxy prefix and root-relative goes to SilverRetort origin, not the server. (c) The exception is `/artifact-bridge-v1.js` — this MUST stay root-relative because it's served by SilverRetort, not the server.

12. **SPP and camera go through WebRTC data channel, NOT HTTP**: The `"stats"` data channel handles both SPP push (server→client) and camera updates (client→server via `{"type":"camera",...}` messages). Do NOT add `setInterval` polling of `/state` for SPP or `fetch('camera', ...)` for camera — both waste bandwidth. The `/state` and `/camera` endpoints still exist for debugging but are not used by the client during normal operation. Only `/config` (resolution) and `/scene` (heightfield params) remain as HTTP endpoints.

13. **Black screen is NOT a data channel problem — it's a BSDF crash**: When the heightfield surface renders completely black with no visible error message, the cause is almost always a Dr.Jit bug in `evaluate()` or `gradient()` (e.g. `dr.fmod`, missing kwarg, shape mismatch) that produces NaN normals for all ray hits. The data channel, WebRTC, and SPP counter still work fine — you're just accumulating crisp images of NaN reflections. The diagnostic: (a) check server logs for `Heightfield OK` validation message — if absent, fix the startup crash first; (b) if validation passed but surface is black, the bug is in `gradient()` specifically (not `evaluate()`) — verify gradient returns non-NaN values for sample inputs; (c) if validation IS present and gradient works standalone, the BSDF is receiving different parameters than expected — check that `DEFAULT_SCENE_SPEC` keys match `evaluate()`/`gradient()` kwargs.

14. **DO NOT patch server.py to add PARAMS-driven parameters**: The `heightfield.py` `PARAMS` list is the single source of truth for every slider-driven parameter. To add a new parameter: (a) add an entry to `PARAMS` in heightfield.py, (b) add a kwarg (matching `internal_name`, with sensible default) to `evaluate()`, `gradient()`, and `heightfield_preview()`. Restart the server. That's it. `get_default_spec()` auto-includes the new entry, `DEFAULT_SCENE_SPEC` picks it up via `**heightfield.get_default_spec()`, the BSDF's `__init__` uses `get_float()` falling back to `hf_defaults`, and the frontend slider is built automatically from `GET /params`. Zero changes to server.py or index.html. Patching server.py directly is actively harmful — it creates a second source of truth that desyncs from PARAMS.

15. **`dr.fmod` does not exist in Dr.Jit**: Use `abs(v) - floor(abs(v))` to extract the fractional part of a floating-point value. Attempting `dr.fmod(abs(v), 1.0)` will raise `AttributeError` at render time, causing all normals to be NaN and the entire heightfield surface to render black. Test hash/modulo code with a standalone Python script before feeding it to Mitsuba.

17. **server.py must validate heightfield on load using get_default_spec() and exit on error**: A broken heightfield formula (typo, missing Dr.Jit op like `dr.fmod`, bad array shape) produces NaN normals at render time — the surface renders black with no visible error message. Always run test `evaluate()` and `gradient()` calls immediately after importing heightfield, before the HTTP server starts. Use `dr.scalar.ArrayXf` so validation works BEFORE `mi.set_variant()` is called. Pass ALL params via `**heightfield.get_default_spec()`. On failure, log the full traceback and `sys.exit(1)`. The validation pattern:

    ```python
    import drjit as _dr
    _hf_d = heightfield.get_default_spec()
    _x = _dr.scalar.ArrayXf([0.0, 0.0001, 0.0002, 0.0003])
    _y = _dr.scalar.ArrayXf([0.0, 0.0001, 0.0002, 0.0003])
    _z = heightfield.evaluate(_x, _y, **_hf_d)
    _g = heightfield.gradient(_x, _y, **_hf_d)
    _z_np = np.array(_z)
    if np.any(np.isnan(_z_np)) or np.any(np.isinf(_z_np)):
        raise ValueError("evaluate returned NaN/Inf")
    ```

18. **Data channel troubleshooting: check server logs first**: When the WebRTC data channel appears broken (SPP counter not updating from initial "SPP: ...", camera drag not working), the FIRST diagnostic is the server log. Look for `INFO:mitsuba-stream:Data channel opened: stats` — if present, the channel IS established and SPP updates are being pushed. The issue is likely: (a) stale cached HTML (hard-reload the page after server restart), (b) a JavaScript error in the client (check browser console), or (c) the SPP messages are being suppressed by `cameraDirty`/`sceneDirty` guards (expected during interaction). If the log line is absent, the client is not creating the data channel or there's an aiortc negotiation issue. Also verify the correct server process is running: use `process(action='list')` to check which server is bound to port 8766. A server from a previous session can linger and handle requests while the new server fails to bind.

19. **Server port conflicts across sessions**: When restarting the server, always kill any existing process on the target port first. Use `netstat -ano | grep :8766` to find the PID, then `taskkill /PID N /F`. Better: use `process(action='list')` to find all running servers, kill by session_id, then start the new one. Sessions can leave orphaned servers that prevent the new one from binding, or worse, both bind in sequence and the old one still serves stale requests through cached ICE connections. Do NOT assume `python server.py` will fail with an address-in-use error — if the previous server was killed mid-gracefully, the port may be silently inherited.

See `references/custom-bsdf-heightfield.py` for the complete, self-contained BSDF registration code (no WebRTC dependency — just the BSDF class and registration).

See `render-with-mitsuba` skill for the WebRTC streaming architecture, orbit camera controls, progressive accumulation, and common pitfalls.
