"""Custom specular heightfield BSDF for Mitsuba 3.

Computes surface normals analytically at shading time using centered
finite differences on a user-supplied height function z = height(x, y).

Usage:
    import mitsuba as mi
    import drjit as dr
    mi.set_variant("cuda_ad_rgb")

    from custom_bsdf_heightfield import register_heightfield_mirror

    def my_height(x, y):
        # x, y in metres; return height in metres
        return 0.0001 * dr.sin(x * 1000.0) * dr.cos(y * 1000.0)

    register_heightfield_mirror(my_height)
    # Now {"type": "heightfield_mirror", "uv_scale_x": 0.16, ...} works
"""

from __future__ import annotations

from typing import Callable

import drjit as dr
import mitsuba as mi


HeightFunction = Callable[[mi.Float, mi.Float], mi.Float]


def register_heightfield_mirror(
    evaluate: HeightFunction,
    plugin_name: str = "heightfield_mirror",
):
    """Register a procedural-heightfield ideal specular BSDF.

    evaluate(x, y):
        Inputs and outputs must be Dr.Jit / Mitsuba types.
        Do not use numpy or math.sin — use dr.sin, dr.floor, etc.

    Coordinate mapping (configurable per-instance via scene dict):
        x = uv.x * uv_scale_x + uv_offset_x
        y = uv.y * uv_scale_y + uv_offset_y

    World-space height:
        h_world = height_scale * evaluate(x, y)
    """

    class HeightFieldMirror(mi.BSDF):
        def __init__(self, props: mi.Properties):
            super().__init__(props)

            def get_float(name: str, default: float) -> float:
                if props.has_property(name):
                    return float(props[name])
                return default

            self.fd_step = get_float("fd_step", 1e-3)
            self.height_scale = get_float("height_scale", 1.0)

            self.uv_scale_x = get_float("uv_scale_x", 1.0)
            self.uv_scale_y = get_float("uv_scale_y", 1.0)

            self.uv_offset_x = get_float("uv_offset_x", 0.0)
            self.uv_offset_y = get_float("uv_offset_y", 0.0)

            if props.has_property("reflectance"):
                self.reflectance = mi.Color3f(props["reflectance"])
            else:
                self.reflectance = mi.Color3f(1.0)

            reflection_flags = (
                mi.BSDFFlags.DeltaReflection
                | mi.BSDFFlags.FrontSide
            )

            self.m_components = [reflection_flags]
            self.m_flags = reflection_flags

        def height_gradient(self, si: mi.SurfaceInteraction3f):
            """Central-difference gradient dh/du, dh/dv w.r.t. UV.

            fd_step is defined in the evaluate() x-y coordinate space.
            """

            x = si.uv.x * self.uv_scale_x + self.uv_offset_x
            y = si.uv.y * self.uv_scale_y + self.uv_offset_y

            eps = self.fd_step

            h_x_plus = evaluate(x + eps, y)
            h_x_minus = evaluate(x - eps, y)

            h_y_plus = evaluate(x, y + eps)
            h_y_minus = evaluate(x, y - eps)

            dh_dx = (h_x_plus - h_x_minus) / (2.0 * eps)
            dh_dy = (h_y_plus - h_y_minus) / (2.0 * eps)

            # Chain rule:
            #   x = scale_x * u + offset_x
            #   y = scale_y * v + offset_y
            #   h_world = height_scale * evaluate(x, y)
            # => dh/du = height_scale * scale_x * dh/dx
            dh_du = self.height_scale * self.uv_scale_x * dh_dx
            dh_dv = self.height_scale * self.uv_scale_y * dh_dy

            return dh_du, dh_dv

        def perturbed_normal(
            self,
            si: mi.SurfaceInteraction3f,
        ) -> mi.Vector3f:
            """Perturbed normal in the LOCAL SHADING FRAME.

            Does NOT use the naive normalize([-dh/du, -dh/dv, 1]) —
            instead uses si.dp_du / si.dp_dv so UV-to-physical
            coordinate mapping is correctly accounted for.
            """

            dh_du, dh_dv = self.height_gradient(si)

            # dp_du, dp_dv are world-space; convert to local shading frame.
            dp_du = si.to_local(si.dp_du)
            dp_dv = si.to_local(si.dp_dv)

            # Bump mapping: replace z-component with height derivatives.
            # In the local shading frame, the base normal is (0, 0, 1).
            displaced_dp_du = mi.Vector3f(dp_du.x, dp_du.y, dh_du)
            displaced_dp_dv = mi.Vector3f(dp_dv.x, dp_dv.y, dh_dv)

            normal = dr.normalize(
                dr.cross(displaced_dp_du, displaced_dp_dv)
            )

            # Face same hemisphere as geometric normal.
            normal = dr.select(normal.z < 0.0, -normal, normal)

            # Guard: ensure wi does not pierce the perturbed surface.
            invalid = si.wi.z * dr.dot(si.wi, normal) <= 0.0
            flipped_normal = mi.Vector3f(-normal.x, -normal.y, normal.z)
            normal = dr.select(invalid, flipped_normal, normal)

            return normal

        def sample(
            self,
            ctx: mi.BSDFContext,
            si: mi.SurfaceInteraction3f,
            sample1: mi.Float,
            sample2: mi.Point2f,
            active: mi.Bool,
        ):
            del sample1, sample2

            enabled = ctx.is_enabled(mi.BSDFFlags.DeltaReflection, 0)
            active &= enabled
            active &= si.wi.z > 0.0

            normal = self.perturbed_normal(si)

            cos_theta_m = dr.dot(si.wi, normal)
            active &= cos_theta_m > 0.0

            # wi and wo both point away from the surface.
            # When normal = (0,0,1): wo = (-wi.x, -wi.y, wi.z)
            wo = 2.0 * cos_theta_m * normal - si.wi

            # Drop samples that go below the macro surface.
            active &= wo.z > 0.0

            bs = mi.BSDFSample3f()
            bs.wo = dr.select(active, wo, mi.Vector3f(0.0))
            bs.pdf = dr.select(active, 1.0, 0.0)
            bs.eta = 1.0

            bs.sampled_component = mi.UInt32(0)
            bs.sampled_type = mi.UInt32(+mi.BSDFFlags.DeltaReflection)

            weight = dr.select(active, self.reflectance, mi.Color3f(0.0))

            return bs, weight

        def eval(
            self,
            ctx: mi.BSDFContext,
            si: mi.SurfaceInteraction3f,
            wo: mi.Vector3f,
            active: mi.Bool,
        ):
            # Ideal specular: Dirac delta, zero everywhere else.
            return mi.Color3f(0.0)

        def pdf(
            self,
            ctx: mi.BSDFContext,
            si: mi.SurfaceInteraction3f,
            wo: mi.Vector3f,
            active: mi.Bool,
        ):
            return mi.Float(0.0)

        def eval_pdf(
            self,
            ctx: mi.BSDFContext,
            si: mi.SurfaceInteraction3f,
            wo: mi.Vector3f,
            active: mi.Bool,
        ):
            return mi.Color3f(0.0), mi.Float(0.0)

        def traverse(self, callback):
            callback.put(
                "reflectance",
                self.reflectance,
                mi.ParamFlags.Differentiable,
            )

        def to_string(self):
            return (
                "HeightFieldMirror[\n"
                f"  fd_step = {self.fd_step},\n"
                f"  height_scale = {self.height_scale},\n"
                f"  uv_scale = [{self.uv_scale_x}, "
                f"{self.uv_scale_y}],\n"
                f"  reflectance = {self.reflectance}\n"
                "]"
            )

    mi.register_bsdf(plugin_name, lambda props: HeightFieldMirror(props))

    return HeightFieldMirror
