#!/usr/bin/env python3
"""Render an ovphysx cube-pick trajectory as a compact two-view GIF."""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("trajectory", type=Path)
    parser.add_argument("output", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    data = np.load(args.trajectory)
    links = data["link_positions"]
    cube = data["cube_positions"]
    names = [str(value) for value in data["body_names"]]
    phases = [str(value) for value in data["phases"]]
    fps = float(data["fps"])
    index = {name: column for column, name in enumerate(names)}

    arm = [name for name in ["waist03", *[f"right0{i}" for i in range(1, 8)],
                              "right_gripper_base_link"] if name in index]
    narrow = [name for name in ["right_gripper_base_link", "right_hand_narrow1_Link",
                                 "right_hand_narrow2_Link", "right_hand_narrow3_Link"] if name in index]
    wide = [name for name in ["right_gripper_base_link", "right_hand_wide1_Link",
                               "right_hand_wide2_Link", "right_hand_wide3_Link"] if name in index]
    used = sorted({index[name] for name in arm + narrow + wide})
    points = links[:, used, :]
    mins = np.minimum(points.min(axis=(0, 1)), cube.min(axis=0)) - 0.04
    maxs = np.maximum(points.max(axis=(0, 1)), cube.max(axis=0)) + 0.04
    initial_z = float(cube[0, 2])

    width, height = 1000, 500
    panel_w = width // 2
    plot = (55, 75, panel_w - 25, height - 55)
    colors = {"arm": "#30343b", "narrow": "#1677a6", "wide": "#b74b3e"}
    font = ImageFont.load_default()

    def project(value: np.ndarray, axes: tuple[int, int], panel: int) -> tuple[int, int]:
        x0, y0, x1, y1 = plot
        px = x0 + (value[axes[0]] - mins[axes[0]]) / (maxs[axes[0]] - mins[axes[0]]) * (x1 - x0)
        py = y1 - (value[axes[1]] - mins[axes[1]]) / (maxs[axes[1]] - mins[axes[1]]) * (y1 - y0)
        return int(px + panel * panel_w), int(py)

    def draw_grid(draw: ImageDraw.ImageDraw, panel: int, title: str) -> None:
        x0, y0, x1, y1 = plot
        x0 += panel * panel_w
        x1 += panel * panel_w
        draw.rectangle((x0, y0, x1, y1), fill="#fbfaf6", outline="#8b867d", width=2)
        for step in range(1, 5):
            x = x0 + (x1 - x0) * step // 5
            y = y0 + (y1 - y0) * step // 5
            draw.line((x, y0, x, y1), fill="#ded9cf", width=1)
            draw.line((x0, y, x1, y), fill="#ded9cf", width=1)
        draw.text((x0 + 8, y0 + 8), title, fill="#282522", font=font)

    def draw_chain(draw: ImageDraw.ImageDraw, frame: int, chain: list[str],
                   axes: tuple[int, int], panel: int, color: str) -> None:
        pts = [project(links[frame, index[name]], axes, panel) for name in chain]
        if len(pts) > 1:
            draw.line(pts, fill=color, width=5, joint="curve")
        for x, y in pts:
            draw.ellipse((x - 4, y - 4, x + 4, y + 4), fill=color, outline="white")

    stride = 2
    frames: list[Image.Image] = []
    for frame in range(0, len(links), stride):
        image = Image.new("RGB", (width, height), "#f4f1e8")
        draw = ImageDraw.Draw(image)
        lift = float(cube[frame, 2] - initial_z)
        title = f"MOZ1 cube pickup  |  {phases[frame]}  |  cube lift {lift:+.3f} m"
        draw.text((width // 2, 25), title, fill="#202020", font=font, anchor="mm")
        draw_grid(draw, 0, "Side view (X-Z)")
        draw_grid(draw, 1, "Top view (X-Y)")

        for panel, axes in ((0, (0, 2)), (1, (0, 1))):
            draw_chain(draw, frame, arm, axes, panel, colors["arm"])
            draw_chain(draw, frame, narrow, axes, panel, colors["narrow"])
            draw_chain(draw, frame, wide, axes, panel, colors["wide"])
            cx, cy = project(cube[frame], axes, panel)
            draw.rectangle((cx - 9, cy - 9, cx + 9, cy + 9),
                           fill="#f06b28", outline="#9d3511", width=2)
        table_left = project(np.array([mins[0], mins[1], 0.68]), (0, 2), 0)
        table_right = project(np.array([maxs[0], mins[1], 0.68]), (0, 2), 0)
        draw.line((table_left, table_right), fill="#705b42", width=5)
        draw.text((65, height - 34), "orange: cube   blue/red: gripper branches", fill="#44403a", font=font)
        frames.append(image)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    duration = int(round(1000 / (fps / stride)))
    frames[0].save(args.output, save_all=True, append_images=frames[1:], duration=duration,
                   loop=0, optimize=True)
    print(args.output.resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


