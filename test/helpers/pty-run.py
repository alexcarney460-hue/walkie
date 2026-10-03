#!/usr/bin/env python3
# Runs argv[3:] on a pseudo-terminal (stdin and stdout are a TTY, as in a person's terminal). Once argv[1] (a prompt)
# shows in its output, types argv[2] and Enter ("" types nothing). Prints everything the terminal showed; exits with
# the command's status. Used by test/helpers/person-cli.ts. PTY_TYPE_DELAY_S waits that long after the prompt shows
# before typing (a person reading the question; typing at once can land before the command starts waiting to read).
import os, pty, select, sys, time

after, text, argv = sys.argv[1], sys.argv[2], sys.argv[3:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
out = b""
typed = not after
status = None

def reaped():
    global status
    if status is not None:
        return True
    wpid, st = os.waitpid(pid, os.WNOHANG)
    if wpid == 0:
        return False
    status = st
    return True

while not reaped():
    try:
        r, _, _ = select.select([fd], [], [], 30)
    except InterruptedError:
        continue
    if not r:
        # A silent stretch is not the end. Offboard --apply can sit on a hung daemon and then print.
        continue
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    out += chunk
    if not typed and after.encode() in out:
        time.sleep(float(os.environ.get("PTY_TYPE_DELAY_S") or 0))
        os.write(fd, text.encode() + b"\n")
        typed = True

while True:
    try:
        r, _, _ = select.select([fd], [], [], 0)
    except InterruptedError:
        continue
    if not r:
        break
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    out += chunk

if status is None:
    _, status = os.waitpid(pid, 0)
sys.stdout.write(out.decode("utf-8", "replace"))
sys.stdout.flush()
sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else (status >> 8))
