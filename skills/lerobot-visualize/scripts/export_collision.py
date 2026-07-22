#!/usr/bin/env python3
"""Export USD collision shapes to the compact JSON consumed by the Three.js viewer."""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


def frame_name(value: str) -> str:
    value = value.strip("/").replace("::", "/")
    return re.sub(r"[^A-Za-z0-9_/]", "_", value) or "robot"


def matrix_values(matrix, meters_per_unit: float) -> list[float]:
    # Gf is row-vector based. Flattening its rows is the column-major representation Three.js expects.
    values = [float(matrix[row][column]) for row in range(4) for column in range(4)]
    values[12:15] = [value * meters_per_unit for value in values[12:15]]
    return values


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("usd", type=Path)
    parser.add_argument("output", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        from pxr import Usd, UsdGeom, UsdPhysics
    except ImportError as exc:
        raise SystemExit(f"USD Python bindings are unavailable: {exc}") from exc
    stage = Usd.Stage.Open(str(args.usd.resolve()))
    if not stage:
        raise SystemExit(f"Unable to open USD stage: {args.usd}")
    cache = UsdGeom.XformCache(Usd.TimeCode.Default())
    meters_per_unit = UsdGeom.GetStageMetersPerUnit(stage)
    articulations = [p for p in stage.Traverse() if p.HasAPI(UsdPhysics.ArticulationRootAPI)]
    rigid_bodies = [p for p in stage.Traverse() if p.HasAPI(UsdPhysics.RigidBodyAPI)]

    def body_for(prim):
        path = prim.GetPath()
        matches = [body for body in rigid_bodies if path.HasPrefix(body.GetPath())]
        return max(matches, key=lambda item: len(str(item.GetPath())), default=None)

    def articulation_for(body):
        matches = [root for root in articulations if body.GetPath().HasPrefix(root.GetPath())]
        return max(matches, key=lambda item: len(str(item.GetPath())), default=None)

    shapes = []
    for prim in stage.Traverse():
        if not prim.HasAPI(UsdPhysics.CollisionAPI) or not prim.IsActive():
            continue
        body = body_for(prim)
        world = cache.GetLocalToWorldTransform(prim)
        matrix = world if body is None else world * cache.GetLocalToWorldTransform(body).GetInverse()
        shape: dict = {"path": str(prim.GetPath()), "matrix": matrix_values(matrix, meters_per_unit), "frame": None}
        if body is not None:
            root = articulation_for(body)
            if root is not None:
                shape["frame"] = f"{frame_name(str(root.GetPath()))}/{frame_name(body.GetName())}"
        if prim.IsA(UsdGeom.Cube):
            cube = UsdGeom.Cube(prim)
            size = float(cube.GetSizeAttr().Get() or 2.0)
            scale = cube.GetExtentAttr().Get()
            shape.update(type="box", size=[size * meters_per_unit] * 3)
        elif prim.IsA(UsdGeom.Sphere):
            shape.update(type="sphere", radius=float(UsdGeom.Sphere(prim).GetRadiusAttr().Get()) * meters_per_unit)
        elif prim.IsA(UsdGeom.Capsule):
            obj = UsdGeom.Capsule(prim)
            shape.update(type="capsule", radius=float(obj.GetRadiusAttr().Get()) * meters_per_unit, height=float(obj.GetHeightAttr().Get()) * meters_per_unit, axis=str(obj.GetAxisAttr().Get() or "Z"))
        elif prim.IsA(UsdGeom.Cylinder):
            obj = UsdGeom.Cylinder(prim)
            shape.update(type="cylinder", radius=float(obj.GetRadiusAttr().Get()) * meters_per_unit, height=float(obj.GetHeightAttr().Get()) * meters_per_unit, axis=str(obj.GetAxisAttr().Get() or "Z"))
        elif prim.IsA(UsdGeom.Mesh):
            mesh = UsdGeom.Mesh(prim)
            points = mesh.GetPointsAttr().Get() or []
            counts = mesh.GetFaceVertexCountsAttr().Get() or []
            source = list(mesh.GetFaceVertexIndicesAttr().Get() or [])
            indices, offset = [], 0
            for count in counts:
                face = source[offset:offset + count]
                indices.extend(v for i in range(1, count - 1) for v in (face[0], face[i], face[i + 1]))
                offset += count
            shape.update(type="mesh", vertices=[float(v) * meters_per_unit for point in points for v in point], indices=indices)
        else:
            continue
        shapes.append(shape)
    payload = {"source": str(args.usd.resolve()), "metersPerUnit": meters_per_unit, "shapes": shapes}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print(f"Exported {len(shapes)} collision shapes to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
