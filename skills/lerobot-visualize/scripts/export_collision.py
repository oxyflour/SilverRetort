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
        from pxr import Gf, Sdf, Usd, UsdGeom, UsdPhysics
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
        # Bodies may be siblings of the articulation root, not descendants.
        # Walk up the ancestor chain: at each level, check if there is a sibling
        # (or ancestor itself) with ArticulationRootAPI.
        check_path = body.GetPath()
        for _ in range(20):
            if not check_path or check_path == Sdf.Path.emptyPath:
                break
            # Check if this path is an articulation root
            for root in articulations:
                if root.GetPath() == check_path:
                    return root
            # Check siblings at this level
            parent = check_path.GetParentPath()
            if parent and parent != Sdf.Path.emptyPath:
                for root in articulations:
                    if root.GetPath().GetParentPath() == parent:
                        return root
            check_path = check_path.GetParentPath()
        return None

    def _find_geom_prims(prim):
        """Recursively find geometry prims under a collision prim (handles Xform wrappers)."""
        if prim.IsA(UsdGeom.Cube) or prim.IsA(UsdGeom.Sphere) or prim.IsA(UsdGeom.Capsule) or prim.IsA(UsdGeom.Cylinder) or prim.IsA(UsdGeom.Mesh):
            return [prim]
        results = []
        for child in prim.GetChildren():
            results.extend(_find_geom_prims(child))
        return results

    def _export_shape(prim, world_matrix):
        """Export a single geometry prim relative to body."""
        shape: dict = {"path": str(prim.GetPath()), "matrix": matrix_values(world_matrix, meters_per_unit), "frame": None}
        body = body_for(prim)
        if body is not None:
            root = articulation_for(body)
            if root is not None:
                shape["frame"] = f"{frame_name(str(root.GetPath()))}/{frame_name(body.GetName())}"
            else:
                shape["frame"] = f"rigid/{frame_name(str(body.GetPath()))}"
        if prim.IsA(UsdGeom.Cube):
            cube = UsdGeom.Cube(prim)
            size = float(cube.GetSizeAttr().Get() or 2.0)
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
        return shape

    shapes = []
    for prim in stage.Traverse():
        if not prim.HasAPI(UsdPhysics.CollisionAPI) or not prim.IsActive():
            continue
        body = body_for(prim)
        articulation = articulation_for(body) if body is not None else None
        body_matrix = cache.GetLocalToWorldTransform(body) if body is not None else Gf.Matrix4d(1.0)
        body_inv = body_matrix.GetInverse()
        # Recurse into Xform collision prims to find actual geometry children
        geom_prims = _find_geom_prims(prim)
        for geom_prim in geom_prims:
            world = cache.GetLocalToWorldTransform(geom_prim)
            matrix = world if body is None else world * body_inv
            shape = _export_shape(geom_prim, matrix)
            shapes.append(shape)
    payload = {"source": str(args.usd.resolve()), "metersPerUnit": meters_per_unit, "shapes": shapes}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print(f"Exported {len(shapes)} collision shapes to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
