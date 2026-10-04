"""Launch the production CLI in a terminal; cancel before any application work."""

import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

node, *arguments = sys.argv[1:]
pid, terminal = pty.fork()
if pid == 0:
    environment = {
        key: value for key, value in os.environ.items()
        if key in ("PATH", "HOME", "TMPDIR", "LANG", "FORGE_COMPARISON_ENV_FILE")
    }
    environment["TERM"] = "xterm-256color"
    os.execve(node, [node, *arguments], environment)

output = b""
cancelled = False
status = None
try:
    fcntl.ioctl(terminal, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        readable, _, _ = select.select([terminal], [], [], 0.1)
        if readable:
            try:
                chunk = os.read(terminal, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                chunk = b""
            output += chunk
        if not cancelled and b"What do you want to do?" in output and b"Enter Confirm" in output:
            os.write(terminal, b"\x03")
            cancelled = True
        ended, child_status = os.waitpid(pid, os.WNOHANG)
        if ended:
            status = child_status
            break
    assert status is not None, "Compiled CLI did not exit after cancellation"
    assert b"ReferenceError" not in output, output.decode(errors="replace")
    assert cancelled, output.decode(errors="replace")
    assert os.waitstatus_to_exitcode(status) == 130, output.decode(errors="replace")
    print("Compiled Forge CLI initial render and pre-run cancellation passed")
finally:
    os.close(terminal)
    if status is None:
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)
