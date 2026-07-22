#!/usr/bin/env python3
"""Serve the Three.js viewer and forward ROS 2 TF transforms over WebSocket."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import signal
import struct
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

CLIENTS: set = set()
CLIENTS_LOCK = threading.Lock()


def frame_name(value: str) -> str:
    return value.strip("/")


def websocket_frame(payload: bytes) -> bytes:
    length = len(payload)
    header = b"\x81" + (bytes([length]) if length < 126 else b"\x7e" + struct.pack("!H", length) if length < 65536 else b"\x7f" + struct.pack("!Q", length))
    return header + payload


def broadcast(payload: dict) -> None:
    frame = websocket_frame(json.dumps(payload, separators=(",", ":")).encode())
    with CLIENTS_LOCK:
        clients = list(CLIENTS)
    for client in clients:
        try:
            client.sendall(frame)
        except OSError:
            with CLIENTS_LOCK:
                CLIENTS.discard(client)


def make_handler(assets: Path, collision: Path):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/ws" and self.headers.get("Upgrade", "").lower() == "websocket":
                key = self.headers.get("Sec-WebSocket-Key")
                if not key:
                    self.send_error(400)
                    return
                accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
                self.send_response(101); self.send_header("Upgrade", "websocket"); self.send_header("Connection", "Upgrade"); self.send_header("Sec-WebSocket-Accept", accept); self.end_headers()
                with CLIENTS_LOCK: CLIENTS.add(self.connection)
                try:
                    while self.connection.recv(1024):
                        pass
                except OSError:
                    pass
                finally:
                    with CLIENTS_LOCK: CLIENTS.discard(self.connection)
                return
            files = {"/": (assets / "index.html", "text/html; charset=utf-8"), "/app.js": (assets / "dist/app.js", "text/javascript; charset=utf-8"), "/collision.json": (collision, "application/json")}
            item = files.get(self.path.split("?", 1)[0])
            if item is None or not item[0].is_file(): self.send_error(404); return
            data = item[0].read_bytes(); self.send_response(200); self.send_header("Content-Type", item[1]); self.send_header("Content-Length", str(len(data))); self.send_header("Cache-Control", "no-store"); self.end_headers(); self.wfile.write(data)
        def log_message(self, fmt, *args):
            print(f"[http] {fmt % args}")
    return Handler


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("collision", type=Path)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--tf-topic", default="/tf")
    args = parser.parse_args()
    assets = Path(__file__).parents[1] / "assets"
    if not args.collision.is_file(): raise SystemExit(f"Collision JSON does not exist: {args.collision}")
    if not (assets / "dist/app.js").is_file(): raise SystemExit("Viewer is not built; run `pnpm install && pnpm build`")
    try:
        import rclpy
        from rclpy.node import Node
        from tf2_msgs.msg import TFMessage
    except ImportError as exc:
        raise SystemExit(f"ROS 2 Python packages are unavailable in this interpreter: {exc}") from exc
    rclpy.init(); node = Node("lerobot_visualize")
    def on_tf(msg: TFMessage):
        transforms=[]
        for value in msg.transforms:
            p, q = value.transform.translation, value.transform.rotation
            transforms.append({"frame": frame_name(value.child_frame_id), "translation":[p.x,p.y,p.z], "rotation":[q.x,q.y,q.z,q.w]})
        stamp = msg.transforms[0].header.stamp if msg.transforms else None
        broadcast({"stamp": None if stamp is None else f"{stamp.sec}.{stamp.nanosec:09d}", "transforms":transforms})
    tf_subscription = node.create_subscription(TFMessage, args.tf_topic, on_tf, 10)
    server=ThreadingHTTPServer((args.host,args.port),make_handler(assets,args.collision.resolve())); threading.Thread(target=server.serve_forever,daemon=True).start()
    print(f"Viewer: http://{args.host}:{args.port}")
    stopping=False
    def stop(*_):
        nonlocal stopping; stopping=True
    signal.signal(signal.SIGINT,stop); signal.signal(signal.SIGTERM,stop)
    try:
        while rclpy.ok() and not stopping: rclpy.spin_once(node,timeout_sec=.25)
    finally:
        server.shutdown(); node.destroy_node(); rclpy.shutdown()
    return 0

if __name__ == "__main__": raise SystemExit(main())
