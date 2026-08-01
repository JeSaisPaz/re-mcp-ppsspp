#!/usr/bin/env python3
"""mcp-ppsspp Ghidra decompilation sidecar.

*** EXPERIMENTAL — NOT VERIFIED AGAINST A LIVE GHIDRA INSTALL ***

This script was written to the best of documented pyghidra/Ghidra public
API knowledge, but the environment it was authored in has no GHIDRA_INSTALL_DIR
available (no Ghidra distribution, only the `pyghidra` pip package was
installable) — so the JVM/Ghidra-facing calls below (especially the
ProgramLoader.Builder chain used to set an explicit base address for a raw
MIPS binary import, and the memory-block-creation calls used by add_blob)
have NOT been exercised end-to-end. Treat this as a strong starting point,
not a proven implementation: run it against your real Ghidra install, watch
stderr for exceptions, and expect to adjust method names/signatures for your
installed Ghidra version (Ghidra's Java API has real drift across releases).

Protocol: this process binds a TCP server on 127.0.0.1 (OS-assigned port),
prints exactly one line "READY <port>" to its own stdout as a handshake,
then only ever writes free-form log text to stdout after that (never
parsed as protocol by the Node side — see src/decompiler.ts). The actual
request/response protocol is newline-delimited JSON over the TCP socket:

    -> {"id": "d1", "cmd": "import_blob", "params": {"baseAddress": 142606336, "bytes": "<base64>"}}
    <- {"id": "d1", "ok": true, "result": {...}}
    <- {"id": "d1", "ok": false, "error": "message"}

Commands: ping, reset, import_blob, add_blob, analyze, decompile,
disassemble, shutdown. See handle_command() below for params/results.

Only ONE client connection is expected (the Node sidecar client) — this is
a private 1:1 process pair, not a general server.
"""

import base64
import json
import socket
import sys
import tempfile
import traceback
from pathlib import Path

SCRATCH_DIR = Path(tempfile.gettempdir()) / "mcp-ppsspp-ghidra-cache"

# MIPS Allegrex (PSP CPU) is a little-endian MIPS32r2-ish core. This is the
# closest stock Ghidra language ID; if your Ghidra build ships a dedicated
# Allegrex variant, prefer that for more accurate instruction decoding.
MIPS_LANGUAGE_ID = "MIPS:LE:32:default"


class GhidraState:
    """Holds the currently-open Ghidra project/program for ONE game at a
    time. `reset` tears this down and starts fresh (called by the Node side
    whenever the loaded PSP game's disc ID changes)."""

    def __init__(self):
        self.project = None
        self.program = None
        self.flat_api = None
        self.imported_ranges = []  # list of (start, end) already-imported blobs

    def is_open(self):
        return self.program is not None

    def close(self):
        if self.program is not None and self.project is not None:
            try:
                self.project.save(self.program)
            except Exception:
                traceback.print_exc(file=sys.stderr)
        if self.project is not None:
            try:
                self.project.close()
            except Exception:
                traceback.print_exc(file=sys.stderr)
        self.project = None
        self.program = None
        self.flat_api = None
        self.imported_ranges = []


state = GhidraState()


def log(msg):
    print(f"[ghidra_sidecar] {msg}", file=sys.stderr, flush=True)


def start_ghidra():
    """Boots the JVM via pyghidra. Call once, lazily, on first real command
    (not at process start) — this is the expensive step (JVM + Ghidra
    class loading), often tens of seconds."""
    import pyghidra
    if not pyghidra.started():
        log("starting Ghidra JVM (pyghidra.start()) — this can take a while on first use")
        pyghidra.start()
        log("Ghidra JVM ready")


def ensure_project():
    if state.project is not None:
        return state.project
    from pyghidra import open_project
    SCRATCH_DIR.mkdir(parents=True, exist_ok=True)
    state.project = open_project(SCRATCH_DIR, "mcp-ppsspp-decompile", create=True)
    return state.project


def write_blob_file(base_address, raw_bytes):
    SCRATCH_DIR.mkdir(parents=True, exist_ok=True)
    path = SCRATCH_DIR / f"blob_{base_address:08x}.bin"
    path.write_bytes(raw_bytes)
    return path


def import_blob(base_address, raw_bytes, program_name="psp_code"):
    """First import for the current game: raw-binary-import `raw_bytes` at
    `base_address` in PSP's real address space, so absolute jumps/calls/
    data references resolve correctly against addresses reported elsewhere
    (ppsspp_get_registers, ppsspp_backtrace, etc).

    UNVERIFIED: the loaderArgs option name "Base Address" matches Ghidra's
    BinaryLoader as documented, but the exact ProgramLoader.Builder method
    chain (loaders/language/loaderArgs/project/name/load) has not been
    exercised against a real Ghidra build in this environment.
    """
    from pyghidra import program_loader
    from ghidra.app.util.opinion import BinaryLoader
    from ghidra.util.task import ConsoleTaskMonitor

    project = ensure_project()
    blob_path = write_blob_file(base_address, raw_bytes)

    builder = (
        program_loader()
        .source(str(blob_path))
        .project(project)
        .name(program_name)
        .loaders(BinaryLoader)
        .language(MIPS_LANGUAGE_ID)
        .loaderArgs([("Base Address", hex(base_address))])
    )
    with builder.load() as load_results:
        load_results.save(ConsoleTaskMonitor())
        program = load_results.getPrimaryDomainObject()

    state.program = program
    from ghidra.program.flatapi import FlatProgramAPI
    state.flat_api = FlatProgramAPI(program)
    state.imported_ranges = [(base_address, base_address + len(raw_bytes))]

    analyze_program()
    return {"range": {"start": base_address, "end": base_address + len(raw_bytes)}}


def add_blob(base_address, raw_bytes, mode="skip"):
    """Incrementally grow the SAME open program with more dumped memory,
    instead of re-importing from scratch (which would throw away any
    manual analysis/naming done on the existing program).

    UNVERIFIED: createInitializedBlock's exact signature varies across
    Ghidra versions (argument order/overloads for name/start/input
    stream/length/monitor/overlay). Check against your installed version.
    """
    if state.program is None:
        return import_blob(base_address, raw_bytes)

    end = base_address + len(raw_bytes)
    for (start, existing_end) in state.imported_ranges:
        if base_address < existing_end and end > start:
            if mode != "replace":
                return {"skipped": True, "reason": "overlaps an already-imported range; pass mode='replace' to force"}
            # "replace" path intentionally left as a future improvement —
            # removing + recreating a memory block safely requires care
            # around existing analysis/references. For now, callers should
            # use ppsspp_decompile_refresh sparingly and expect a fresh
            # `reset` to be the reliable way to force a clean re-import.
            break

    from ghidra.program.model.mem import MemoryConflictException
    from java.io import ByteArrayInputStream  # type: ignore
    from ghidra.util.task import ConsoleTaskMonitor
    from ghidra.program.model.address import Address

    addr_factory = state.program.getAddressFactory()
    start_addr = addr_factory.getDefaultAddressSpace().getAddress(base_address)

    tx = state.program.startTransaction("mcp-ppsspp add_blob")
    try:
        mem = state.program.getMemory()
        stream = ByteArrayInputStream(raw_bytes)
        mem.createInitializedBlock(
            f"blob_{base_address:08x}", start_addr, stream, len(raw_bytes),
            ConsoleTaskMonitor(), False,
        )
        state.program.endTransaction(tx, True)
    except MemoryConflictException as e:
        state.program.endTransaction(tx, False)
        return {"skipped": True, "reason": str(e)}
    except Exception:
        state.program.endTransaction(tx, False)
        raise

    state.imported_ranges.append((base_address, end))
    analyze_program()
    return {"range": {"start": base_address, "end": end}}


def analyze_program(start=None, end=None):
    """Runs Ghidra's auto-analysis. `start`/`end` are accepted for a future
    scoped-analysis optimization but current implementation just re-runs
    full-program analysis, which is correct (if not maximally fast)."""
    if state.program is None:
        raise RuntimeError("No program open — call import_blob first.")
    from ghidra.program.util import GhidraProgramUtilities
    if GhidraProgramUtilities.shouldAskToAnalyze(state.program):
        state.flat_api.analyzeAll(state.program)
        GhidraProgramUtilities.markProgramAnalyzed(state.program)
    return {}


def _address_at(addr_int):
    return state.program.getAddressFactory().getDefaultAddressSpace().getAddress(addr_int)


def decompile(address):
    if state.program is None:
        raise RuntimeError("No program open — call import_blob first.")
    from ghidra.app.decompiler import DecompInterface
    from ghidra.util.task import ConsoleTaskMonitor

    addr = _address_at(address)
    func = state.flat_api.getFunctionContaining(addr)
    if func is None:
        func = state.flat_api.createFunction(addr, None)
    if func is None:
        raise RuntimeError(f"Could not find or create a function at 0x{address:08x}")

    ifc = DecompInterface()
    ifc.openProgram(state.program)
    try:
        results = ifc.decompileFunction(func, 60, ConsoleTaskMonitor())
        if not results.decompileCompleted():
            raise RuntimeError(f"Decompilation failed: {results.getErrorMessage()}")
        pseudo_c = results.getDecompiledFunction().getC()
        signature = str(func.getSignature())
    finally:
        ifc.dispose()

    return {
        "pseudoC": pseudo_c,
        "functionName": func.getName(),
        "signature": signature,
        "disasm": disassemble_text(func.getEntryPoint(), func.getBody().getMaxAddress()),
    }


def disassemble_text(start_addr, end_addr):
    listing = state.program.getListing()
    lines = []
    unit = listing.getCodeUnitAt(start_addr)
    while unit is not None and unit.getMinAddress().compareTo(end_addr) <= 0:
        lines.append(f"{unit.getAddress()}: {unit}")
        unit = listing.getCodeUnitAfter(unit.getMaxAddress())
        if len(lines) > 2000:  # sanity cap
            break
    return "\n".join(lines)


def disassemble(address, size):
    if state.program is None:
        raise RuntimeError("No program open — call import_blob first.")
    start_addr = _address_at(address)
    end_addr = _address_at(address + size)
    return {"disasm": disassemble_text(start_addr, end_addr)}


def reset():
    state.close()
    return {}


def handle_command(cmd, params):
    if cmd == "ping":
        return {"pong": True}
    if cmd == "reset":
        return reset()

    # Every other command needs the JVM up.
    start_ghidra()

    if cmd == "import_blob":
        raw = base64.b64decode(params["bytes"])
        return import_blob(params["baseAddress"], raw, params.get("programName", "psp_code"))
    if cmd == "add_blob":
        raw = base64.b64decode(params["bytes"])
        return add_blob(params["baseAddress"], raw, params.get("mode", "skip"))
    if cmd == "analyze":
        return analyze_program(params.get("start"), params.get("end"))
    if cmd == "decompile":
        return decompile(params["address"])
    if cmd == "disassemble":
        return disassemble(params["address"], params["size"])
    if cmd == "shutdown":
        state.close()
        raise SystemExit(0)

    raise ValueError(f"Unknown command: {cmd}")


def handle_client(conn):
    buf = b""
    with conn:
        while True:
            chunk = conn.recv(65536)
            if not chunk:
                return
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if not line.strip():
                    continue
                try:
                    msg = json.loads(line)
                    result = handle_command(msg["cmd"], msg.get("params", {}))
                    reply = {"id": msg["id"], "ok": True, "result": result}
                except SystemExit:
                    conn.sendall((json.dumps({"id": msg.get("id"), "ok": True, "result": {}}) + "\n").encode("utf8"))
                    return
                except Exception as e:  # noqa: BLE001 — surface any Ghidra/Java exception as a tool error
                    traceback.print_exc(file=sys.stderr)
                    reply = {"id": msg.get("id"), "ok": False, "error": str(e)}
                conn.sendall((json.dumps(reply) + "\n").encode("utf8"))


def main():
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    port = server.getsockname()[1]
    # Handshake: exactly one line, then stdout is free-form log noise only.
    print(f"READY {port}", flush=True)

    try:
        while True:
            conn, _ = server.accept()
            # One client at a time is expected; handle inline rather than
            # threading, so state (the open Ghidra program) can't race.
            handle_client(conn)
    except KeyboardInterrupt:
        pass
    finally:
        state.close()


if __name__ == "__main__":
    main()
