"""Launch the production CLI in a terminal; cancel before model planning."""

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
ready_at = None
status = None
continue_to_task = os.environ.get("FORGE_TEST_TUI_CONTINUE_TO_TASK") == "1"
root_selected = False
try:
    fcntl.ioctl(terminal, termios.TIOCSWINSZ, struct.pack("HHHH", int(os.environ.get("FORGE_TEST_TUI_ROWS", "40")), int(os.environ.get("FORGE_TEST_TUI_COLUMNS", "120")), 0, 0))
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
        if not cancelled and not root_selected and b"What do you want to do?" in output and b"Enter Confirm" in output and all(option in output for option in (b"Start a coding task", b"Resume a run", b"View runs", b"Configure model", b"Check environment")):
            if ready_at is None:
                ready_at = time.monotonic()
            # Let terminal capability negotiation finish before sending a key.
            if time.monotonic() - ready_at >= 1:
                if continue_to_task:
                    os.write(terminal, b"\r")
                    root_selected = True
                else:
                    os.write(terminal, b"\x03")
                    cancelled = True
        if continue_to_task and root_selected and not cancelled and all(option in output for option in (b"Describe task", b"Use Markdown specification")):
            assert b"Enter Continue" not in output, "Unexpected Repository prompt"
            assert b"canonical-repository" in output, "Validated canonical repository was not displayed"
            os.write(terminal, b"\x03")
            cancelled = True
        ended, child_status = os.waitpid(pid, os.WNOHANG)
        if ended:
            status = child_status
            break
    assert status is not None, "Compiled CLI did not exit after cancellation: " + output.decode(errors="replace")
    assert b"ReferenceError" not in output, output.decode(errors="replace")
    assert cancelled, output.decode(errors="replace")
    assert os.waitstatus_to_exitcode(status) == 130, output.decode(errors="replace")
    print("Compiled Forge CLI initial render and pre-run cancellation passed")
    if continue_to_task:
        print("Deployment-bound repository reached task input without a Repository prompt")
finally:
    os.close(terminal)
    if status is None:
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)
