# A stand-in rpc-server that accepts connections and never reads them (a stalled consumer), so the kernel's socket
# buffers fill and the sender sees real backpressure. (A Bun stand-in with socket.pause() still drains the socket.)
# WALKIE-POOL-3 tests.
import signal, socket, sys
a = sys.argv[1:]
port = int(a[a.index("-p") + 1])
host = a[a.index("-H") + 1] if "-H" in a else "127.0.0.1"
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind((host, port))
s.listen(8)
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
held = []
while True:
    c, _ = s.accept()
    held.append(c)
