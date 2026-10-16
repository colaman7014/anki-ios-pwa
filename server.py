#!/usr/bin/env python3
"""
Local / LAN HTTP Server for Anki iOS Offline PWA.
Serves the PWA static assets from /Users/colalin/repos/anki-ios-pwa and
mounts /media/<filename> in strict read-only mode from the Anki media directories.
"""
import argparse
import mimetypes
import socket
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

PWA_ROOT = Path(__file__).resolve().parent
MEDIA_DIRS = [
    Path("/Users/colalin/repos/anki/build/media"),
    Path("/Users/colalin/repos/anki/build/anki-smoke/User 1/collection.media"),
    Path.home() / "Library" / "Application Support" / "Anki2" / "使用者 1" / "collection.media",
]


class AnkiPwaRequestHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PWA_ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        clean_path = unquote(self.path.split("?", 1)[0])
        if clean_path.endswith("/media/__probe__"):
            # Lets the PWA know (synchronously at tap time) that real MP3s are served here
            self.send_response(200)
            self.send_header("X-Anki-Media", "1")
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"ok")
            return
        if clean_path.startswith("/media/"):
            rel_name = Path(clean_path[len("/media/") :]).name
            for mdir in MEDIA_DIRS:
                candidate = mdir / rel_name
                try:
                    found = candidate.is_file()
                except OSError:
                    found = False  # e.g. macOS privacy protection on ~/Library
                if found:
                    ctype, _ = mimetypes.guess_type(str(candidate))
                    data = candidate.read_bytes()
                    self.send_response(200)
                    self.send_header("Content-Type", ctype or "application/octet-stream")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return
            self.send_error(404, f"Media file not found: {rel_name}")
            return
        super().do_GET()


def get_lan_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def main():
    parser = argparse.ArgumentParser(description="Serve Anki iOS Offline PWA")
    parser.add_argument("--host", default="0.0.0.0", help="Bind host (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=8766, help="Bind port (default: 8766)")
    args = parser.parse_args()

    lan_ip = get_lan_ip()
    server = ThreadingHTTPServer((args.host, args.port), AnkiPwaRequestHandler)
    print(f"Anki iOS Offline PWA Server running:")
    print(f"  Local:   http://127.0.0.1:{args.port}/")
    print(f"  iOS LAN: http://{lan_ip}:{args.port}/  (Open in iPhone Safari -> Add to Home Screen)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
