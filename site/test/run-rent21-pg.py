"""Run the RENT-21 bind test against an isolated, disposable local Postgres."""
import os
import socket
import subprocess
import sys
import tempfile
from pathlib import Path


def run(*args: str, env: dict[str, str] | None = None) -> None:
    subprocess.run(args, check=True, env=env)


with tempfile.TemporaryDirectory(prefix="rent21-pg-", dir=Path.cwd()) as directory:
    root = Path(directory)
    data = root / "data"
    run("initdb", "-D", str(data), "-U", "postgres", "--auth=trust", "-E", "UTF8")
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    options = f"-p {port} -c unix_socket_directories='' -c listen_addresses='127.0.0.1'"
    run("pg_ctl", "-D", str(data), "-l", str(root / "server.log"), "-w", "-o", options, "start")
    try:
        env = {**os.environ, "RENT21_TEST_DATABASE_URL": f"postgres://postgres@127.0.0.1:{port}/postgres"}
        files = (sorted(str(path) for path in Path("test").glob("*.test.ts"))
                 if "--all" in sys.argv else ["test/compute-rent21-bind.test.ts"])
        run("bun", "test", *files, env=env)
    finally:
        run("pg_ctl", "-D", str(data), "-m", "immediate", "stop")
