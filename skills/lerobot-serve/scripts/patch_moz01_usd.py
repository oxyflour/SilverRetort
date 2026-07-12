#!/usr/bin/env python3
"""Create a USD-only MOZ01 fingertip collision overlay."""

from __future__ import annotations

import argparse
import os
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="source USD or USDA scene")
    parser.add_argument("output", type=Path, help="new USDA overlay to create")
    return parser.parse_args()


def asset_path(source: Path, output: Path) -> str:
    relative = os.path.relpath(source.resolve(), output.resolve().parent)
    value = relative.replace("\\", "/")
    if "@" in value:
        raise SystemExit("USD asset paths containing '@' are unsupported")
    return value


def overlay_text(source_asset: str) -> str:
    return f'''#usda 1.0
(
    defaultPrim = "World"
    metersPerUnit = 1
    subLayers = [@{source_asset}@]
    upAxis = "Z"
)

over "World"
{{
    def Material "GripPhysicsMaterial" (
        prepend apiSchemas = ["PhysicsMaterialAPI"]
    )
    {{
        float physics:staticFriction = 4.0
        float physics:dynamicFriction = 3.0
        float physics:restitution = 0
    }}

    over "MOZ1"
    {{
        over "right_hand_wide3_Link"
        {{
            over "collisions" (active = false) {{}}
            over "codex_side_grip_pad" (active = false) {{}}
            over "right_hand_wide4_Link"
            {{
                over "codex_fingertip_collision" (active = false) {{}}
            }}

            def Mesh "fingertip_convex_hull" (
                prepend apiSchemas = ["PhysicsCollisionAPI", "PhysicsMeshCollisionAPI", "MaterialBindingAPI"]
            )
            {{
                uniform token purpose = "guide"
                token visibility = "invisible"
                bool physics:collisionEnabled = 1
                uniform token physics:approximation = "convexHull"
                float3[] extent = [(0.0400, 0.0164, -0.0207), (0.0478, 0.0223, 0.0207)]
                point3f[] points = [
                    (0.0400, 0.0164, -0.0207), (0.0400, 0.0222, -0.0207),
                    (0.0400, 0.0222,  0.0207), (0.0400, 0.0164,  0.0207),
                    (0.0478, 0.0199, -0.0048), (0.0478, 0.0223, -0.0048),
                    (0.0478, 0.0223,  0.0048), (0.0478, 0.0199,  0.0048)
                ]
                int[] faceVertexCounts = [4, 4, 4, 4, 4, 4]
                int[] faceVertexIndices = [0, 3, 2, 1, 4, 5, 6, 7, 0, 1, 5, 4, 1, 2, 6, 5, 2, 3, 7, 6, 3, 0, 4, 7]
                uniform token subdivisionScheme = "none"
                rel material:binding:physics = </World/GripPhysicsMaterial>
            }}
        }}

        over "right_hand_narrow3_Link"
        {{
            over "collisions" (active = false) {{}}
            over "codex_side_grip_pad" (active = false) {{}}
            over "right_hand_narrow4_Link"
            {{
                over "codex_fingertip_collision" (active = false) {{}}
            }}

            def Mesh "fingertip_convex_hull" (
                prepend apiSchemas = ["PhysicsCollisionAPI", "PhysicsMeshCollisionAPI", "MaterialBindingAPI"]
            )
            {{
                uniform token purpose = "guide"
                token visibility = "invisible"
                bool physics:collisionEnabled = 1
                uniform token physics:approximation = "convexHull"
                float3[] extent = [(0.0400, -0.0223, -0.0105), (0.0479, -0.0165, 0.0105)]
                point3f[] points = [
                    (0.0400, -0.0223, -0.0105), (0.0400, -0.0165, -0.0105),
                    (0.0400, -0.0165,  0.0105), (0.0400, -0.0223,  0.0105),
                    (0.0479, -0.0223, -0.0076), (0.0479, -0.0198, -0.0076),
                    (0.0479, -0.0198,  0.0076), (0.0479, -0.0223,  0.0076)
                ]
                int[] faceVertexCounts = [4, 4, 4, 4, 4, 4]
                int[] faceVertexIndices = [0, 3, 2, 1, 4, 5, 6, 7, 0, 1, 5, 4, 1, 2, 6, 5, 2, 3, 7, 6, 3, 0, 4, 7]
                uniform token subdivisionScheme = "none"
                rel material:binding:physics = </World/GripPhysicsMaterial>
            }}
        }}

        over "left_hand_wide3_Link"
        {{
            over "left_hand_wide4_Link"
            {{
                over "codex_fingertip_collision" (active = false) {{}}
            }}
        }}

        over "left_hand_narrow3_Link"
        {{
            over "left_hand_narrow4_Link"
            {{
                over "codex_fingertip_collision" (active = false) {{}}
            }}
        }}
    }}
}}
'''


def main() -> int:
    args = parse_args()
    source = args.source.resolve()
    output = args.output.resolve()
    if not source.is_file():
        raise SystemExit(f"Source USD does not exist: {source}")
    if source == output:
        raise SystemExit("Output must differ from source; author a derived overlay")
    if output.exists():
        raise SystemExit(f"Refusing to overwrite existing output: {output}")
    if output.suffix.lower() != ".usda":
        raise SystemExit("Output must use the .usda extension")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(overlay_text(asset_path(source, output)), encoding="utf-8", newline="\n")
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
