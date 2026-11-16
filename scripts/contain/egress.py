"""dsh-contain egress: the only way out of a dsh-contain box.

serve    runs outside the box. It listens on a Unix socket and accepts HTTP
         proxy requests (CONNECT host:port, or an absolute http:// URL). It
         connects only to the host:port pairs given with --allow, answers 403
         to everything else, and logs one line per decision.
forward  runs inside the box, whose network namespace has only loopback. It
         listens on a loopback port, relays every connection to the Unix
         socket, runs the given command, and exits with its status.

Standard library only; run it with python3 -I.
"""
import argparse
import datetime
import os
import signal
import socket
import subprocess
import sys
import threading

HEAD_MAX = 64 * 1024


def stamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def pipe(src, dst):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def splice(a, b):
    t = threading.Thread(target=pipe, args=(b, a), daemon=True)
    t.start()
    pipe(a, b)
    t.join()
    for s in (a, b):
        try:
            s.close()
        except OSError:
            pass


def read_head(conn):
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = conn.recv(4096)
        if not chunk:
            return None, b""
        data += chunk
        if len(data) > HEAD_MAX:
            return None, b""
    head, rest = data.split(b"\r\n\r\n", 1)
    return head.decode("iso-8859-1"), rest


def split_hostport(text, default_port):
    if text.startswith("["):
        return None, None  # IPv6 literals are never allowed
    host, _, port = text.rpartition(":")
    if not host:
        host, port = text, str(default_port)
    if not port.isdigit():
        return None, None
    return host.lower().rstrip("."), int(port)


class Server:
    def __init__(self, allow, log):
        self.allow = {a.strip().lower() for a in allow.split(",") if a.strip()}
        self.log = log
        self.lock = threading.Lock()

    def record(self, verdict, method, host, port, note=""):
        with self.lock:
            with open(self.log, "a", encoding="utf-8") as out:
                out.write(f"{stamp()} {verdict} {method} {host}:{port} {note}".rstrip() + "\n")

    def refuse(self, conn, code, reason):
        body = f"dsh-contain egress: {reason}\n".encode()
        conn.sendall(f"HTTP/1.1 {code}\r\nContent-Type: text/plain\r\nContent-Length: {len(body)}\r\n"
                     f"Connection: close\r\n\r\n".encode() + body)
        conn.close()

    def handle(self, conn):
        try:
            head, rest = read_head(conn)
            if head is None:
                conn.close()
                return
            lines = head.split("\r\n")
            parts = lines[0].split(" ")
            if len(parts) != 3:
                self.record("deny", "?", "?", "?", "malformed request line")
                return self.refuse(conn, "400 Bad Request", "malformed request")
            method, target, version = parts
            if method == "CONNECT":
                host, port = split_hostport(target, 443)
                path = None
            elif target.startswith("http://"):
                hostport, slash, path = target[len("http://"):].partition("/")
                host, port = split_hostport(hostport, 80)
                path = "/" + path
            else:
                self.record("deny", method, "?", "?", "not a proxy request")
                return self.refuse(conn, "400 Bad Request", "only CONNECT and absolute http:// requests")
            if host is None or f"{host}:{port}" not in self.allow:
                self.record("deny", method, host, port)
                return self.refuse(conn, "403 Forbidden", f"{host}:{port} is not in the allowlist")
            try:
                upstream = socket.create_connection((host, port), timeout=30)
                upstream.settimeout(None)
            except OSError as error:
                self.record("fail", method, host, port, type(error).__name__)
                return self.refuse(conn, "502 Bad Gateway", f"cannot reach {host}:{port}")
            self.record("allow", method, host, port)
            if method == "CONNECT":
                conn.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
                if rest:
                    upstream.sendall(rest)
            else:
                headers = [h for h in lines[1:] if h.split(":", 1)[0].strip().lower()
                           not in ("proxy-connection", "proxy-authorization", "connection", "keep-alive")]
                headers.append("Connection: close")
                upstream.sendall((f"{method} {path} {version}\r\n" + "\r\n".join(headers) + "\r\n\r\n")
                                 .encode("iso-8859-1") + rest)
            splice(conn, upstream)
        except OSError:
            try:
                conn.close()
            except OSError:
                pass

    def serve(self, path):
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        old = os.umask(0o077)
        listener.bind(path)
        os.umask(old)
        listener.listen(64)
        while True:
            conn, _ = listener.accept()
            threading.Thread(target=self.handle, args=(conn,), daemon=True).start()


def forward(listen, sock_path, command):
    host, _, port = listen.rpartition(":")
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind((host, int(port)))
    listener.listen(64)

    def relay(conn):
        try:
            out = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            out.connect(sock_path)
        except OSError:
            conn.close()
            return
        splice(conn, out)

    def accept():
        while True:
            conn, _ = listener.accept()
            threading.Thread(target=relay, args=(conn,), daemon=True).start()

    threading.Thread(target=accept, daemon=True).start()
    child = subprocess.Popen(command)
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, lambda s, _f: child.send_signal(s))
    return child.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="verb", required=True)
    s = sub.add_parser("serve")
    s.add_argument("--socket", required=True)
    s.add_argument("--allow", required=True, help="comma-separated host:port pairs")
    s.add_argument("--log", required=True)
    f = sub.add_parser("forward")
    f.add_argument("--listen", required=True)
    f.add_argument("--socket", required=True)
    f.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.verb == "serve":
        Server(args.allow, args.log).serve(args.socket)
    else:
        command = args.command[1:] if args.command[:1] == ["--"] else args.command
        if not command:
            parser.error("forward needs a command after --")
        code = forward(args.listen, args.socket, command)
        sys.exit(code if code >= 0 else 128 - code)


if __name__ == "__main__":
    main()
