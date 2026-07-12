from __future__ import annotations

import asyncio
import ctypes
import json
import re
import socket
import struct
import traceback

import carb
import omni.ext
import omni.kit.app
import omni.kit.viewport.utility as viewport_utility
import omni.usd
from omni.kit.widget.viewport.capture import ByteCapture
from pxr import Gf, Usd, UsdGeom, UsdLux


LENGTH = struct.Struct("!I")


async def read_packet(reader: asyncio.StreamReader) -> tuple[dict, bytes]:
    header_size = LENGTH.unpack(await reader.readexactly(LENGTH.size))[0]
    header = json.loads((await reader.readexactly(header_size)).decode("utf-8"))
    payload_size = LENGTH.unpack(await reader.readexactly(LENGTH.size))[0]
    payload = await reader.readexactly(payload_size) if payload_size else b""
    return header, payload


async def write_packet(writer: asyncio.StreamWriter, header: dict, payload: bytes = b"") -> None:
    encoded = json.dumps(header, separators=(",", ":")).encode("utf-8")
    writer.write(LENGTH.pack(len(encoded)) + encoded + LENGTH.pack(len(payload)) + payload)
    await writer.drain()


class Extension(omni.ext.IExt):
    def on_startup(self, _ext_id: str) -> None:
        self._server = None
        self._task = asyncio.ensure_future(self._start())
        self._task.add_done_callback(self._on_task_done)
        self._xform_ops = {}
        self._xform_scales = {}

    @staticmethod
    def _on_task_done(task: asyncio.Task) -> None:
        if task.cancelled():
            return
        error = task.exception()
        if error is not None:
            carb.log_error(f"LeRobot renderer startup failed: {type(error).__name__}: {error}")

    def on_shutdown(self) -> None:
        if self._server is not None:
            self._server.close()
        if self._task is not None:
            self._task.cancel()

    async def _start(self) -> None:
        settings = carb.settings.get_settings()
        prefix = "/exts/lerobot/render"
        self._usd = settings.get_as_string(f"{prefix}/usd")
        self._camera = settings.get_as_string(f"{prefix}/camera")
        self._sensors_file = settings.get_as_string(f"{prefix}/sensorsFile")
        self._host = settings.get_as_string(f"{prefix}/host") or "127.0.0.1"
        self._port = settings.get_as_int(f"{prefix}/port") or 39080
        self._width = settings.get_as_int(f"{prefix}/width") or 640
        self._height = settings.get_as_int(f"{prefix}/height") or 480
        if not self._usd:
            raise RuntimeError("/exts/lerobot/render/usd is required")

        carb.log_info(f"LeRobot renderer opening USD: {self._usd}")
        success, error = await omni.usd.get_context().open_stage_async(self._usd)
        if not success:
            raise RuntimeError(f"Could not open USD {self._usd}: {error}")
        carb.log_info("LeRobot renderer USD open completed")
        await omni.kit.app.get_app().next_update_async()
        self._stage = omni.usd.get_context().get_stage()
        self._stage.SetEditTarget(self._stage.GetSessionLayer())
        self._meters_per_unit = UsdGeom.GetStageMetersPerUnit(self._stage)
        if self._meters_per_unit <= 0:
            raise RuntimeError(f"Invalid USD metersPerUnit: {self._meters_per_unit}")
        carb.log_info(f"LeRobot renderer USD metersPerUnit={self._meters_per_unit}")
        self._ensure_lighting()
        self._index_prims()
        carb.log_info("LeRobot renderer configuring viewport")
        await self._configure_viewport()
        carb.log_info("LeRobot renderer viewport configured")
        listen_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listen_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listen_socket.bind((self._host, self._port))
        listen_socket.listen()
        listen_socket.setblocking(False)
        self._server = await asyncio.start_server(self._handle_client, sock=listen_socket)
        carb.log_info(f"LeRobot RTX renderer listening on {self._host}:{self._port}")

    def _index_prims(self) -> None:
        by_name = {}
        for prim in self._stage.Traverse():
            by_name.setdefault(prim.GetName(), []).append(prim)
        self._prim_by_name = {name: prims[0] for name, prims in by_name.items() if len(prims) == 1}
        self._ambiguous_names = {name for name, prims in by_name.items() if len(prims) > 1}

    def _ensure_lighting(self) -> None:
        lights = [prim for prim in self._stage.Traverse() if str(prim.GetTypeName()).endswith("Light")]
        if lights:
            carb.log_info(f"LeRobot renderer using {len(lights)} authored light(s)")
            return
        dome = UsdLux.DomeLight.Define(self._stage, "/World/LerobotRenderDomeLight")
        dome.CreateColorAttr(Gf.Vec3f(0.8, 0.85, 1.0))
        dome.CreateIntensityAttr(1000.0)
        key = UsdLux.DistantLight.Define(self._stage, "/World/LerobotRenderKeyLight")
        key.CreateColorAttr(Gf.Vec3f(1.0, 0.9, 0.8))
        key.CreateIntensityAttr(3000.0)
        key.CreateAngleAttr(1.0)
        UsdGeom.Xformable(key.GetPrim()).AddRotateXYZOp().Set(Gf.Vec3f(-45.0, 25.0, 35.0))
        carb.log_info("LeRobot renderer added session-layer fallback lighting")

    async def _configure_viewport(self) -> None:
        self._viewport_window = None
        for _ in range(30):
            self._viewport = viewport_utility.get_active_viewport()
            if self._viewport is not None:
                break
            await omni.kit.app.get_app().next_update_async()
        if self._viewport is None:
            self._viewport_window = viewport_utility.create_viewport_window(
                name="LeRobot Render Viewport", width=self._width, height=self._height
            )
            if self._viewport_window is not None:
                self._viewport = self._viewport_window.viewport_api
        if self._viewport is None:
            raise RuntimeError("No active Kit viewport is available")

        self._sensors = self._load_sensors()
        self._viewport.camera_path = next(iter(self._sensors.values()))
        self._viewport.resolution = (self._width, self._height)
        carb.log_info(f"LeRobot renderer sensors: {self._sensors}")

    @staticmethod
    def _sensor_name(value: str) -> str:
        return re.sub(r"[^A-Za-z0-9_]", "_", value).strip("_") or "camera"

    def _load_sensors(self) -> dict[str, str]:
        configured = None
        if self._sensors_file:
            with open(self._sensors_file, encoding="utf-8") as stream:
                configured = json.load(stream)
            if not isinstance(configured, dict) or not configured:
                raise RuntimeError("sensors file must contain a non-empty JSON object")
        elif self._camera:
            configured = {"camera": self._camera}

        if configured is None:
            cameras = [
                p for p in self._stage.Traverse()
                if p.IsA(UsdGeom.Camera) and not str(p.GetPath()).startswith("/OmniverseKit_")
            ]
            if not cameras:
                cameras = [self._create_fallback_camera()]
            configured = {}
            for camera in cameras:
                base = self._sensor_name(camera.GetName())
                name = base
                suffix = 2
                while name in configured:
                    name = f"{base}_{suffix}"
                    suffix += 1
                configured[name] = str(camera.GetPath())

        sensors = {}
        for raw_name, camera_path in configured.items():
            name = self._sensor_name(str(raw_name))
            if name in sensors:
                raise RuntimeError(f"Duplicate sensor name after sanitizing: {name}")
            if not isinstance(camera_path, str):
                raise RuntimeError(f"Camera path for sensor {name} must be a string")
            prim = self._stage.GetPrimAtPath(camera_path)
            if not prim or not prim.IsA(UsdGeom.Camera):
                raise RuntimeError(f"Camera prim for sensor {name} is invalid: {camera_path}")
            sensors[name] = camera_path
        return sensors

    def _create_fallback_camera(self):
        cache = UsdGeom.BBoxCache(
            Usd.TimeCode.Default(), [UsdGeom.Tokens.default_, UsdGeom.Tokens.render]
        )
        bounds = cache.ComputeWorldBound(self._stage.GetPseudoRoot()).ComputeAlignedRange()
        if bounds.IsEmpty():
            center = Gf.Vec3d(0.0)
            radius = 1.0
        else:
            minimum = Gf.Vec3d(bounds.GetMin())
            maximum = Gf.Vec3d(bounds.GetMax())
            center = (minimum + maximum) * 0.5
            extent = maximum - minimum
            radius = max(float(extent[0]), float(extent[1]), float(extent[2])) * 0.5
            radius = max(radius, 0.1)
        distance = radius * 3.5
        direction = Gf.Vec3d(1.0, 1.0, 0.65).GetNormalized()
        eye = center + direction * distance
        camera = UsdGeom.Camera.Define(self._stage, "/World/LerobotRenderCamera")
        camera.CreateFocalLengthAttr(35.0)
        camera.CreateClippingRangeAttr(Gf.Vec2f(max(0.01, distance - radius * 2.0), distance + radius * 3.0))
        view = Gf.Matrix4d(1.0)
        view.SetLookAt(eye, center, Gf.Vec3d(0.0, 0.0, 1.0))
        UsdGeom.Xformable(camera.GetPrim()).AddTransformOp().Set(view.GetInverse())
        carb.log_info(
            f"LeRobot fallback camera framed center={tuple(center)}, radius={radius:.3f}, eye={tuple(eye)}"
        )
        return camera.GetPrim()

    async def _handle_client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            while True:
                request, _ = await read_packet(reader)
                self._apply_poses(request.get("poses", []))
                frames = []
                payloads = []
                offset = 0
                for sensor, camera_path in self._sensors.items():
                    metadata, pixels = await self._capture(camera_path)
                    frames.append(metadata | {
                        "sensor": sensor,
                        "camera": camera_path,
                        "offset": offset,
                        "length": len(pixels),
                    })
                    payloads.append(pixels)
                    offset += len(pixels)
                await write_packet(
                    writer,
                    {"frames": frames, "stamp": request.get("stamp", {})},
                    b"".join(payloads),
                )
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        except Exception as exc:
            carb.log_error(f"LeRobot render request failed: {exc}\n{traceback.format_exc()}")
            try:
                await write_packet(writer, {"error": str(exc)})
            except Exception:
                pass
        finally:
            writer.close()
            await writer.wait_closed()

    def _apply_poses(self, poses: list[dict]) -> None:
        cache = UsdGeom.XformCache(Usd.TimeCode.Default())
        resolved = []
        for pose in poses:
            name = pose["child"].rstrip("/").split("/")[-1]
            if name in self._ambiguous_names:
                raise RuntimeError(f"Ambiguous USD prim name from TF: {name}")
            prim = self._prim_by_name.get(name)
            if prim is not None and UsdGeom.Xformable(prim):
                resolved.append((prim, pose))
        resolved.sort(key=lambda item: len(str(item[0].GetPath()).split("/")))
        for prim, pose in resolved:
            translation = pose["translation"]
            rotation = pose["rotation"]
            world = Gf.Matrix4d(1.0)
            world.SetRotate(Gf.Quatd(rotation[3], Gf.Vec3d(*rotation[:3])))
            world.SetTranslateOnly(Gf.Vec3d(*translation) / self._meters_per_unit)
            parent_world = cache.GetLocalToWorldTransform(prim.GetParent())
            local = world * parent_world.GetInverse()
            path = str(prim.GetPath())
            op = self._xform_ops.get(path)
            if op is None:
                xformable = UsdGeom.Xformable(prim)
                scale = Gf.Vec3d(1.0)
                for authored_op in xformable.GetOrderedXformOps():
                    if authored_op.GetOpType() == UsdGeom.XformOp.TypeScale:
                        value = authored_op.Get()
                        if value is not None:
                            scale = Gf.Vec3d(
                                scale[0] * value[0],
                                scale[1] * value[1],
                                scale[2] * value[2],
                            )
                self._xform_scales[path] = scale
                xformable.ClearXformOpOrder()
                op = xformable.AddTransformOp(UsdGeom.XformOp.PrecisionDouble, "rosPose")
                self._xform_ops[path] = op
            scale_matrix = Gf.Matrix4d(1.0)
            scale_matrix.SetScale(self._xform_scales[path])
            op.Set(scale_matrix * local)
            cache.Clear()

    async def _capture(self, camera_path: str) -> tuple[dict, bytes]:
        self._viewport.camera_path = camera_path
        for attempt in range(30):
            await viewport_utility.next_viewport_frame_async(self._viewport)
            metadata, data = await self._capture_once()
            channels = metadata["step"] // metadata["width"]
            if any(data[offset] for offset in range(0, len(data), channels)) or any(
                data[offset] for offset in range(1, len(data), channels)
            ) or any(data[offset] for offset in range(2, len(data), channels)):
                if attempt:
                    carb.log_info(
                        f"LeRobot RTX camera {camera_path} warmed up after {attempt + 1} captures"
                    )
                return metadata, data
        raise RuntimeError(
            f"RTX viewport returned 30 consecutive all-black color frames for camera {camera_path}"
        )

    async def _capture_once(self) -> tuple[dict, bytes]:
        loop = asyncio.get_running_loop()
        result = loop.create_future()

        def completed(buffer, buffer_size, width, height, _format) -> None:
            try:
                try:
                    data = bytes(memoryview(buffer)[:buffer_size])
                except TypeError:
                    get_name = ctypes.pythonapi.PyCapsule_GetName
                    get_name.argtypes = [ctypes.py_object]
                    get_name.restype = ctypes.c_char_p
                    get_pointer = ctypes.pythonapi.PyCapsule_GetPointer
                    get_pointer.argtypes = [ctypes.py_object, ctypes.c_char_p]
                    get_pointer.restype = ctypes.c_void_p
                    capsule_name = get_name(buffer)
                    pointer = get_pointer(buffer, capsule_name)
                    if not pointer:
                        raise RuntimeError("ByteCapture returned a null PyCapsule pointer")
                    data = ctypes.string_at(pointer, buffer_size)
                channels = buffer_size // (width * height)
                encoding = {3: "rgb8", 4: "rgba8"}.get(channels)
                if encoding is None:
                    raise RuntimeError(f"Unsupported capture channel count: {channels}")
                result.set_result(({
                    "width": width,
                    "height": height,
                    "encoding": encoding,
                    "step": width * channels,
                }, data))
            except Exception as exc:
                result.set_exception(exc)

        capture = self._viewport.schedule_capture(ByteCapture(completed))
        aovs = await capture.wait_for_result()
        if not aovs:
            raise RuntimeError("RTX viewport returned no color AOV")
        return await result
