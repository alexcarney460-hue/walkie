#!/usr/bin/env python3
# Runs argv[2:] on a pseudo-terminal (it is the controlling terminal: /dev/tty) and plays argv[1], a JSON list of
# [prompt, text] steps: once the prompt shows in the output (after the previous step's), waits PTY_TYPE_DELAY_S
# (default 0.5: a person reading) and types the text ("\r" included where Enter is meant). Prints everything the
# terminal showed; exits with the command's status, or 124 when it stays silent for PTY_IDLE_S (default 15) seconds.
import json, os, pty, select, signal, sys, time

steps, argv = json.loads(sys.argv[1]), sys.argv[2:]
delay = float(os.environ.get("PTY_TYPE_DELAY_S") or 0.5)
idle = float(os.environ.get("PTY_IDLE_S") or 15)
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
out, seen, hung = b"", 0, False
while True:
    try:
        r, _, _ = select.select([fd], [], [], idle)
    except InterruptedError:
        continue
    if not r:
        hung = True
        break
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    out += chunk
    while steps and steps[0][0].encode() in out[seen:]:
        seen = out.index(steps[0][0].encode(), seen) + len(steps[0][0].encode())
        time.sleep(delay)
        os.write(fd, steps.pop(0)[1].encode())
if hung:
    os.kill(pid, signal.SIGKILL)
_, status = os.waitpid(pid, 0)
sys.stdout.write(out.decode("utf-8", "replace"))
sys.stdout.flush()
sys.exit(124 if hung else (os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else (status >> 8)))
