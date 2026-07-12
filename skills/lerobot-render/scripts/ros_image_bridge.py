#!/usr/bin/env python3
"""Bridge ROS TF poses to the Kit renderer and publish captured images."""

from __future__ import annotations

import argparse
import json
import re
import socket
import struct
import time


LENGTH = struct.Struct("!I")


def recv_exact(sock: socket.socket, size: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < size:
        chunk = sock.recv(size - len(chunks))
        if not chunk:
            raise ConnectionError("Renderer closed the connection")
        chunks.extend(chunk)
    return bytes(chunks)


def send_packet(sock: socket.socket, header: dict) -> None:
    encoded = json.dumps(header, separators=(",", ":")).encode("utf-8")
    sock.sendall(LENGTH.pack(len(encoded)) + encoded + LENGTH.pack(0))


def recv_packet(sock: socket.socket) -> tuple[dict, bytes]:
    header_size = LENGTH.unpack(recv_exact(sock, LENGTH.size))[0]
    header = json.loads(recv_exact(sock, header_size).decode("utf-8"))
    payload_size = LENGTH.unpack(recv_exact(sock, LENGTH.size))[0]
    return header, recv_exact(sock, payload_size) if payload_size else b""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=39080)
    parser.add_argument("--fps", type=float, default=20.0)
    parser.add_argument("--tf-topic", default="/tf")
    parser.add_argument("--image-topic-prefix", default="/lerobot/render")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    import rclpy
    from rclpy.node import Node
    from sensor_msgs.msg import Image
    from tf2_msgs.msg import TFMessage

    rclpy.init()
    node = Node("lerobot_render_bridge")
    publishers = {}
    poses = {}

    def on_tf(message: TFMessage) -> None:
        for item in message.transforms:
            poses[item.child_frame_id] = {
                "child": item.child_frame_id,
                "translation": [
                    item.transform.translation.x,
                    item.transform.translation.y,
                    item.transform.translation.z,
                ],
                "rotation": [
                    item.transform.rotation.x,
                    item.transform.rotation.y,
                    item.transform.rotation.z,
                    item.transform.rotation.w,
                ],
            }

    node.create_subscription(TFMessage, args.tf_topic, on_tf, 20)
    sock = None
    period = 1.0 / args.fps
    try:
        while rclpy.ok():
            rclpy.spin_once(node, timeout_sec=period)
            if not poses:
                continue
            if sock is None:
                try:
                    sock = socket.create_connection((args.host, args.port), timeout=2.0)
                    sock.settimeout(10.0)
                    node.get_logger().info(f"Connected to RTX renderer at {args.host}:{args.port}")
                except OSError:
                    time.sleep(0.5)
                    continue
            stamp = node.get_clock().now().to_msg()
            request = {
                "stamp": {"sec": stamp.sec, "nanosec": stamp.nanosec},
                "poses": list(poses.values()),
            }
            try:
                send_packet(sock, request)
                header, pixels = recv_packet(sock)
                if "error" in header:
                    raise RuntimeError(header["error"])
                for frame in header.get("frames", []):
                    sensor = re.sub(r"[^A-Za-z0-9_]", "_", frame["sensor"]).strip("_")
                    if not sensor:
                        raise RuntimeError("Renderer returned an empty sensor name")
                    start = int(frame["offset"])
                    end = start + int(frame["length"])
                    data = pixels[start:end]
                    if len(data) != frame["length"]:
                        raise RuntimeError(f"Truncated pixel payload for sensor {sensor}")
                    if sensor not in publishers:
                        topic = f"{args.image_topic_prefix.rstrip('/')}/{sensor}/image_raw"
                        publishers[sensor] = node.create_publisher(Image, topic, 2)
                        node.get_logger().info(f"Publishing sensor {sensor} on {topic}")
                    message = Image()
                    message.header.stamp = stamp
                    message.header.frame_id = sensor
                    message.height = frame["height"]
                    message.width = frame["width"]
                    message.encoding = frame["encoding"]
                    message.is_bigendian = 0
                    message.step = frame["step"]
                    message.data = data
                    publishers[sensor].publish(message)
            except (ConnectionError, OSError) as exc:
                node.get_logger().warning(f"Renderer connection lost: {exc}")
                sock.close()
                sock = None
    finally:
        if sock is not None:
            sock.close()
        node.destroy_node()
        rclpy.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
