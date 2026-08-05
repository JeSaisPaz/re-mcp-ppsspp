#!/usr/bin/env python3
"""mcp-ppsspp Ghidra decompilation sidecar.

Verified end-to-end 2026-08-05 against Ghidra 12.1.2 + ghidra-allegrex v21.3
(PSP game UCES01245 running live in PPSSPP v1.20.4). The import -> disassemble
-> analyze -> decompile path produces pseudo-C, and the resulting disassembly
was diffed instruction-by-instruction against PPSSPP's own disassembler over
the same address range: 120/120 identical.

Getting there required fixing five bugs that all traced back to Ghidra Java
API details this script had originally guessed at (each is documented inline
at the call site):
  1. ProgramLoader.Builder.loaderArgs() needs a typed java.util.List of
     generic.stl.Pair — use addLoaderArg(str, str) instead (jpype).
  2. The base-address loader arg key is the COMMAND-LINE arg
     "-loader-baseAddr", not the display name "Base Address". A wrong key is
     only warned about, so the blob silently loaded at address 0.
  3. getPrimaryDomainObject() must be given a consumer to keep the program
     alive past the `with` block, and released to match.
  4. analyzeAll() must run inside an explicit transaction — without one it
     SILENTLY MIS-DECODES instructions and finds 0 functions.
  5. A raw binary import has no entry point, so nothing is ever
     disassembled unless we do it explicitly (see ensure_disassembled).

add_blob's createInitializedBlock path is still the least-exercised part of
this file — it is not covered by the verification above.

REQUIRES the kotcrab/ghidra-allegrex extension installed in your Ghidra
(https://github.com/kotcrab/ghidra-allegrex, Apache-2.0) — it's what adds
real Allegrex/VFPU (PSP vector unit) disassembly and decompilation; stock
Ghidra's MIPS module cannot decode VFPU instructions at all, which matters
a great deal for physics/graphics-heavy game code. Install it via Ghidra's
File -> Install Extensions (19+) or by copying its Processors/Allegrex
folder into $GHIDRA_INSTALL_DIR/Ghidra/Processors (18 and earlier), then
restart. If it's missing, import_blob's builder.language() call below will
fail with a clear "invalid language ID" error — see README for setup.

Protocol: this process binds a TCP server on 127.0.0.1 (OS-assigned port),
prints exactly one line "READY <port>" to its own stdout as a handshake,
then only ever writes free-form log text to stdout after that (never
parsed as protocol by the Node side — see src/decompiler.ts). The actual
request/response protocol is newline-delimited JSON over the TCP socket:

    -> {"id": "d1", "cmd": "import_blob", "params": {"baseAddress": 142606336, "bytes": "<base64>"}}
    <- {"id": "d1", "ok": true, "result": {...}}
    <- {"id": "d1", "ok": false, "error": "message"}

Commands: ping, reset, import_blob, add_blob, analyze, apply_symbols,
decompile, decompile_all, disassemble, shutdown. See handle_command()
below for params/results.

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

# Confirmed from kotcrab/ghidra-allegrex's own language definition
# (data/languages/allegrex.ldefs) — requires that extension to be
# installed in the target Ghidra (see module docstring above). This gets
# you real VFPU disassembly/decompilation and PSP-aware calling
# conventions that stock Ghidra's generic MIPS module lacks entirely.
ALLEGREX_LANGUAGE_ID = "Allegrex:LE:32:default"


class GhidraState:
    """Holds the currently-open Ghidra project/program for ONE game at a
    time. `reset` tears this down and starts fresh (called by the Node side
    whenever the loaded PSP game's disc ID changes)."""

    def __init__(self):
        self.project = None
        self.program = None
        self.flat_api = None
        self.imported_ranges = []  # list of (start, end) already-imported blobs
        # A real java.lang.Object identity token used as the DomainObject
        # "consumer" in getPrimaryDomainObject(consumer)/program.release(consumer)
        # — must be a genuine Java object (jpype has no overload rule that
        # coerces an arbitrary Python instance into java.lang.Object; a raw
        # Python object throws "No matching overloads found", confirmed
        # live 2026-08-05). Created lazily in import_blob() once the JVM is
        # up (java.lang can't be imported before pyghidra.start()).
        self.consumer = None

    def is_open(self):
        return self.program is not None

    def close(self):
        # Confirmed live 2026-08-05: DefaultProject has no per-object
        # save(DomainObject) overload (it only has a no-arg, whole-project
        # save()) — the old `self.project.save(self.program)` call threw
        # "No matching overloads found" every time. A single DomainObject
        # is saved through its own DomainFile instead.
        if self.program is not None:
            from ghidra.util.task import ConsoleTaskMonitor
            try:
                self.program.getDomainFile().save(ConsoleTaskMonitor())
            except Exception:
                traceback.print_exc(file=sys.stderr)
            # Release the consumer reference import_blob() took out via
            # getPrimaryDomainObject(self.consumer) — must be paired 1:1
            # or the DomainObject leaks (stays "in use" forever).
            if self.consumer is not None:
                try:
                    self.program.release(self.consumer)
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

    Confirmed working 2026-08-05 against a real Ghidra 12.1.2 + ghidra-allegrex
    install. Two separate bugs were fixed here:

    1. ProgramLoader.Builder.loaderArgs(List<Pair<String,String>>) needs a real
       java.util.List of Ghidra's internal generic.stl.Pair — passing a raw
       Python list (even of tuples) throws "No matching overloads found" from
       jpype, since jpype does not auto-convert a Python list into a typed
       java.util.List<Pair<...>> for an overload match. Builder has a
       single-arg alternative for exactly this case — addLoaderArg(String,
       String), two plain strings, which jpype converts automatically.

    2. The argument key must be the option's COMMAND-LINE ARG
       ("-loader-baseAddr"), NOT its display name ("Base Address").
       ProgramLoader.getLoaderOptions() matches loaderArgs against
       Option.getArg(), and BinaryLoader builds that arg as
       Loader.COMMAND_LINE_ARG_PREFIX ("-loader") + "-baseAddr". A key that
       matches nothing is only a Msg.warn ("Skipping unsupported ...
       argument") — the load still SUCCEEDS, silently, with the default base
       address of 0. That made the failure especially confusing: import_blob
       reported success, but the block landed at 0x00000000 instead of the
       PSP address, so every later address lookup missed and decompile()
       failed with a misleading "could not find or create a function".
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
        .language(ALLEGREX_LANGUAGE_ID)
        .addLoaderArg("-loader-baseAddr", hex(base_address))
    )
    with builder.load() as load_results:
        load_results.save(ConsoleTaskMonitor())
        # Confirmed live 2026-08-05: the no-arg getPrimaryDomainObject()
        # does NOT retain a consumer reference past this `with` block —
        # LoadResults.close() (end of this block) releases its own
        # default consumer, and with no other consumer registered the
        # DomainObject becomes invalid, throwing a NullPointerException
        # the next time it's touched (AutoAnalysisManager.getProgram()
        # returned null when FlatProgramAPI() was constructed below).
        # getPrimaryDomainObject(consumer) registers an explicit extra
        # consumer that survives past the `with` block's close() — must
        # be a real java.lang.Object (see GhidraState.consumer's comment)
        # and must be paired with a matching program.release(consumer)
        # call, done in GhidraState.close() above.
        from java.lang import Object as JavaObject  # type: ignore
        state.consumer = JavaObject()
        program = load_results.getPrimaryDomainObject(state.consumer)

    state.program = program
    from ghidra.program.flatapi import FlatProgramAPI
    state.flat_api = FlatProgramAPI(program)
    state.imported_ranges = [(base_address, base_address + len(raw_bytes))]

    # Guard against a silently-ignored base-address loader arg (see the
    # docstring's bug #2): if the arg key ever stops matching — e.g. Ghidra
    # renames it in a future release — the load still "succeeds" with the
    # block at 0, and every symptom shows up much later and much less
    # obviously. Fail loudly, here, where the cause is still visible.
    check_addr = program.getAddressFactory().getDefaultAddressSpace().getAddress(base_address)
    if not program.getMemory().contains(check_addr):
        blocks = ", ".join(
            f"{b.getName()}@{b.getStart()}-{b.getEnd()}" for b in program.getMemory().getBlocks()
        ) or "(none)"
        raise RuntimeError(
            f"Imported blob did not land at its requested base address 0x{base_address:08x} — "
            f"Ghidra placed it at [{blocks}] instead. This means the '-loader-baseAddr' loader "
            f"argument was not applied (Ghidra only logs 'Skipping unsupported ... argument' and "
            f"loads at 0). Check BinaryLoader's command-line arg name for your Ghidra version "
            f"(Loader.COMMAND_LINE_ARG_PREFIX + '-baseAddr' as of 12.1.2)."
        )

    analysis = analyze_program()
    return {"range": {"start": base_address, "end": base_address + len(raw_bytes)}, **analysis}


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
    analysis = analyze_program()
    return {"range": {"start": base_address, "end": end}, **analysis}


def analyze_program(start=None, end=None):
    """Runs Ghidra's auto-analysis. `start`/`end` are accepted for a future
    scoped-analysis optimization but current implementation just re-runs
    full-program analysis, which is correct (if not maximally fast).
    Returns the resulting function count so callers (Node-side
    ppsspp_decompile_module) can report something meaningful after a
    whole-module import."""
    if state.program is None:
        raise RuntimeError("No program open — call import_blob first.")
    from ghidra.program.util import GhidraProgramUtilities

    # analyzeAll() MUST run inside an explicit transaction. Without one it
    # does not merely fail loudly — it silently corrupts the program:
    # confirmed live 2026-08-05 that an untransacted analyzeAll left
    # 0x0894ACC0 (word 0x26310001, opcode 9 = addiu) decoding as
    # "sw s1,0x1(s1)", disagreeing with both PPSSPP's disassembler and a
    # hand-decode, AND reported functionCount 0. Wrapping the same call in
    # a transaction fixes both: the instruction decodes correctly as
    # "addiu s1,s1,0x1" and analysis actually finds functions.
    tx = state.program.startTransaction("mcp-ppsspp analyze")
    try:
        if GhidraProgramUtilities.shouldAskToAnalyze(state.program):
            state.flat_api.analyzeAll(state.program)
            GhidraProgramUtilities.markProgramAnalyzed(state.program)
        state.program.endTransaction(tx, True)
    except Exception:
        state.program.endTransaction(tx, False)
        raise
    return {"functionCount": state.program.getFunctionManager().getFunctionCount()}


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
        # Confirmed live 2026-08-05: a RAW BINARY import has no entry point,
        # so Ghidra's auto-analysis disassembles nothing at all and
        # import_blob reports functionCount 0. createFunction() wraps
        # CreateFunctionCmd, which needs an already-disassembled instruction
        # at the entry point — on undisassembled bytes it just returns null,
        # which surfaced as the misleading "Could not find or create a
        # function". Disassemble at the requested address first (the
        # disassembler follows code flow from there), THEN create the
        # function. Both are mutating commands, so they need an open
        # transaction — FlatProgramAPI.start()/end() manage one internally.
        ensure_disassembled(addr)
        state.flat_api.start()
        try:
            func = state.flat_api.createFunction(addr, None)
        finally:
            state.flat_api.end(True)
    if func is None:
        raise RuntimeError(
            f"Could not find or create a function at 0x{address:08x} — "
            f"disassembly at that address produced no instruction. Check the address is real "
            f"code (not data/padding), that it's inside an imported range, and that the bytes "
            f"were dumped with replacements:false (PPSSPP's JIT 'emuhack' marker corrupts the "
            f"first word of every compiled block otherwise)."
        )

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


def apply_symbols(entries):
    """Batch-labels functions/data in the currently-open program from
    externally-known names — PPSSPP's own live HLE knowledge (it must
    resolve every imported SDK call's NID to know which HLE stub to run,
    so it already has names for anything it recognizes) plus the MCP
    server's persistent per-game symbol store. `entries` is a list of
    {address, name, type: "function"|"data", size?}.

    UNVERIFIED: exact Symbol/Function renaming API (setName + SourceType)
    is standard Ghidra FlatProgramAPI usage but has not been exercised
    end-to-end here.
    """
    if state.program is None:
        raise RuntimeError("No program open — call import_blob first.")
    from ghidra.program.model.symbol import SourceType

    applied = 0
    tx = state.program.startTransaction("mcp-ppsspp apply_symbols")
    try:
        for entry in entries:
            try:
                addr = _address_at(entry["address"])
                name = entry["name"]
                if entry.get("type") == "data":
                    state.flat_api.createLabel(addr, name, True, SourceType.USER_DEFINED)
                else:
                    func = state.flat_api.getFunctionAt(addr)
                    if func is None:
                        func = state.flat_api.getFunctionContaining(addr)
                    if func is None:
                        func = state.flat_api.createFunction(addr, name)
                    if func is not None:
                        func.setName(name, SourceType.USER_DEFINED)
                applied += 1
            except Exception:
                # Best-effort: one bad entry (e.g. address outside any
                # imported range) shouldn't sink the whole batch.
                traceback.print_exc(file=sys.stderr)
                continue
        state.program.endTransaction(tx, True)
    except Exception:
        state.program.endTransaction(tx, False)
        raise
    return {"applied": applied, "total": len(entries)}


def decompile_all():
    """Decompiles every function Ghidra's auto-analysis found in the
    current program — the batch counterpart to decompile(address), used
    by ppsspp_decompile_module_export to build an on-disk codebase instead
    of one function at a time."""
    if state.program is None:
        raise RuntimeError("No program open — call import_blob first.")
    from ghidra.app.decompiler import DecompInterface
    from ghidra.util.task import ConsoleTaskMonitor

    ifc = DecompInterface()
    ifc.openProgram(state.program)
    results = []
    try:
        for func in state.program.getFunctionManager().getFunctions(True):
            try:
                r = ifc.decompileFunction(func, 60, ConsoleTaskMonitor())
                if not r.decompileCompleted():
                    continue
                results.append({
                    "address": func.getEntryPoint().getOffset(),
                    "name": func.getName(),
                    "signature": str(func.getSignature()),
                    "pseudoC": r.getDecompiledFunction().getC(),
                })
            except Exception:
                traceback.print_exc(file=sys.stderr)
                continue
    finally:
        ifc.dispose()
    return {"functions": results}


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


def ensure_disassembled(start_addr, end_addr=None):
    """Make sure the listing actually holds INSTRUCTIONS over this range
    before anything reads it.

    A raw-binary import has no entry point, so Ghidra's auto-analysis
    disassembles nothing at all — every byte stays an undefined data byte.
    Reading the listing in that state yields "?? d0h"-style junk rather
    than code (confirmed live 2026-08-05: a 480-byte range came back as
    481 one-byte 'instructions', 0 of which matched PPSSPP's own
    disassembly of the same bytes). Disassembling first makes Ghidra's
    output match PPSSPP's exactly.

    Mutating commands need an open transaction — FlatProgramAPI.start()/
    end() manage one internally.
    """
    state.flat_api.start()
    try:
        if state.flat_api.getInstructionAt(start_addr) is None:
            state.flat_api.disassemble(start_addr)
        # disassemble() follows code flow from `start_addr`, but a plain
        # address range can hold several disjoint functions with no flow
        # between them (e.g. after a whole-module import). Sweep forward
        # for any still-undefined gaps and kick the disassembler there too.
        #
        # Step STRICTLY by 4 (MIPS/Allegrex is fixed-width, always 4-byte
        # aligned). An earlier version walked code-unit to code-unit
        # instead, which lands on 1-byte undefined-data boundaries and so
        # asks the disassembler to start mid-instruction — that produced
        # real, silently-wrong output (0x0894ACC0's `addiu s1,s1,0x1`
        # came back as `sw s1,0x1(s1)`, confirmed live 2026-08-05).
        # Anything not 4-aligned is by definition not an instruction start.
        if end_addr is not None:
            listing = state.program.getListing()
            addr = start_addr
            guard = 0
            while addr.compareTo(end_addr) < 0 and guard < 8192:
                guard += 1
                if listing.getInstructionAt(addr) is None and addr.getOffset() % 4 == 0:
                    state.flat_api.disassemble(addr)
                nxt = addr.add(4)
                if nxt is None or nxt.compareTo(addr) <= 0:
                    break
                addr = nxt
    finally:
        state.flat_api.end(True)


def disassemble(address, size):
    if state.program is None:
        raise RuntimeError("No program open — call import_blob first.")
    start_addr = _address_at(address)
    end_addr = _address_at(address + size)
    ensure_disassembled(start_addr, end_addr)
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
    if cmd == "apply_symbols":
        return apply_symbols(params.get("entries", []))
    if cmd == "decompile":
        return decompile(params["address"])
    if cmd == "decompile_all":
        return decompile_all()
    if cmd == "disassemble":
        return disassemble(params["address"], params["size"])
    if cmd == "shutdown":
        state.close()
        raise SystemExit(0)

    raise ValueError(f"Unknown command: {cmd}")


def handle_client(conn):
    """Returns True if the client asked us to shut the whole process down,
    False if it merely disconnected (in which case main() waits for the
    next connection)."""
    buf = b""
    with conn:
        while True:
            chunk = conn.recv(65536)
            if not chunk:
                return False
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
                    # Ack the shutdown, then tell main() to actually stop.
                    # Previously this just `return`ed, which dropped straight
                    # back into main()'s `while True: server.accept()` — so
                    # `shutdown` never terminated the process. Every MCP
                    # server restart then leaked an orphaned JVM (hundreds of
                    # MB) still holding the Ghidra project lock, which made
                    # the NEXT session fail with "Unable to lock project!".
                    conn.sendall((json.dumps({"id": msg.get("id"), "ok": True, "result": {}}) + "\n").encode("utf8"))
                    return True
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
            if handle_client(conn):
                break  # `shutdown` command — stop accepting and exit.
    except KeyboardInterrupt:
        pass
    finally:
        state.close()
        try:
            server.close()
        except Exception:
            pass


if __name__ == "__main__":
    main()
