from __future__ import annotations

import argparse
import json
import os
import socket
from pathlib import Path

import uvicorn

from .app import create_app
from .recognition import DummyRecognizer, RapidOcrRecognizer


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="DaMuSystem local backend")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--data-dir", type=Path, default=Path(".runtime"))
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    token = os.environ.get("DAMU_AUTH_TOKEN")
    if not token:
        raise SystemExit("DAMU_AUTH_TOKEN is required")
    args.data_dir.mkdir(parents=True, exist_ok=True)

    server_holder: dict[str, uvicorn.Server] = {}

    def request_shutdown() -> None:
        server = server_holder.get("server")
        if server is not None:
            server.should_exit = True

    recognizer_name = os.environ.get("DAMU_RECOGNIZER", "rapidocr").casefold()
    recognizer = DummyRecognizer() if recognizer_name == "dummy" else RapidOcrRecognizer()
    app = create_app(
        token=token,
        shutdown_callback=request_shutdown,
        recognizer=recognizer,
        data_dir=args.data_dir,
    )
    server = uvicorn.Server(
        uvicorn.Config(app, host="127.0.0.1", port=args.port, log_level="info")
    )
    server_holder["server"] = server

    listen_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listen_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listen_socket.bind(("127.0.0.1", args.port))
    listen_socket.listen(2048)
    port = listen_socket.getsockname()[1]
    print(
        "DAMU_BACKEND_READY "
        + json.dumps({"host": "127.0.0.1", "port": port, "api_version": "1"}),
        flush=True,
    )
    server.run(sockets=[listen_socket])


if __name__ == "__main__":
    main()
