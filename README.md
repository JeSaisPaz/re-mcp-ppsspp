# mcp-ppsspp

[![npm version](https://img.shields.io/npm/v/mcp-ppsspp.svg)](https://www.npmjs.com/package/mcp-ppsspp)
[![npm downloads](https://img.shields.io/npm/dm/mcp-ppsspp.svg)](https://www.npmjs.com/package/mcp-ppsspp)
[![CI](https://github.com/dmang-dev/mcp-ppsspp/actions/workflows/ci.yml/badge.svg)](https://github.com/dmang-dev/mcp-ppsspp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/npm/l/mcp-ppsspp.svg)](LICENSE)
[![Snyk](https://snyk.io/test/npm/mcp-ppsspp/badge.svg)](https://snyk.io/test/npm/mcp-ppsspp)
[![Socket](https://img.shields.io/badge/Socket-security-2F7BFF?logo=socket)](https://socket.dev/npm/package/mcp-ppsspp)
[![Bundlephobia](https://img.shields.io/badge/bundlephobia-size-FF6B81)](https://bundlephobia.com/package/mcp-ppsspp)
[![npmgraph](https://img.shields.io/badge/npmgraph-dependencies-2496ED)](https://npmgraph.js.org/?q=mcp-ppsspp)

An [MCP](https://modelcontextprotocol.io) server that exposes [PPSSPP](https://www.ppsspp.org) — the PlayStation Portable emulator — to any MCP-compatible client (Claude Desktop, Claude Code, etc.) via PPSSPP's built-in WebSocket debugger interface.

Read and write PSP memory, drive games with button input, capture screenshots, set CPU breakpoints, inspect MIPS Allegrex registers — all through a clean tool interface. No bridge plugin needed; PPSSPP's debugger is built into the emulator.

## How it works

```
+------------------+    stdio     +------------------+   WebSocket    +------------------+
|   MCP client     |   JSON-RPC   |    mcp-ppsspp    |   JSON-RPC     |     PPSSPP       |
| (Claude / etc.)  | ===========> |     (Node.js)    | =============> |    (debugger)    |
+------------------+              +------------------+                +------------------+
```

Unlike the [mcp-bizhawk](https://github.com/dmang-dev/mcp-bizhawk) / [mcp-mgba](https://github.com/dmang-dev/mcp-mgba) bridges (which need a Lua plugin loaded into the emulator), PPSSPP ships with its own debugger WebSocket interface — we just speak JSON to it. **No plugin to install.**

The connection uses subprotocol `debugger.ppsspp.org` on PPSSPP's debugger port.

## Requirements

- [PPSSPP](https://www.ppsspp.org/download) (recent version with WebSocket debugger — 1.7+)
- **Node.js 22+**
- "Allow remote debugger" enabled in PPSSPP

## Install

```bash
npm install -g mcp-ppsspp
```

Or `npx -y mcp-ppsspp`.

## Set up PPSSPP's debugger

1. Launch PPSSPP, load any PSP ISO/EBOOT
2. **Settings → Tools → Developer Tools → Allow remote debugger** (check the box)
3. PPSSPP will show the active host:port (e.g. `ws://192.168.1.10:12345/debugger`)
4. Note the port number — you'll set it as an environment variable for the MCP server

## Register with your MCP client

### Claude Code (CLI)

```bash
claude mcp add ppsspp --scope user --env PPSSPP_PORT=12345 mcp-ppsspp
```

Replace `12345` with your actual port. Verify:

```bash
claude mcp list
# ppsspp: mcp-ppsspp - ✓ Connected
```

### Claude Desktop

Edit `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ppsspp": {
      "command": "mcp-ppsspp",
      "env": { "PPSSPP_PORT": "12345" }
    }
  }
}
```

Restart Claude Desktop after editing.

## Configuration

| Env var        | Default       | Purpose                                          |
|----------------|---------------|--------------------------------------------------|
| `PPSSPP_HOST`  | `127.0.0.1`   | WebSocket host to dial                           |
| `PPSSPP_PORT`  | (required)    | WebSocket port — see PPSSPP's debugger settings  |
| `MCP_PPSSPP_SYMBOLS_DIR` | `~/.mcp-ppsspp/symbols/` | Where persistent per-game symbol files (`ppsspp_symbol_*`) are stored |
| `GHIDRA_INSTALL_DIR` | (unset) | Enables `ppsspp_decompile`/`ppsspp_decompile_refresh` — see below. Unset by default; the rest of the server needs zero Python/Ghidra dependency |
| `MCP_PPSSPP_PYTHON` | `python3` | Python interpreter used to run the Ghidra decompiler sidecar, if enabled |

## Optional: pseudo-C decompilation (Ghidra)

`ppsspp_decompile` / `ppsspp_decompile_refresh` decompile live PSP MIPS code
into pseudo-C using a local [Ghidra](https://ghidra-sre.org/) instance (via
[pyghidra](https://github.com/NationalSecurityAgency/ghidra/tree/master/Ghidra/Features/PyGhidra)),
fed with memory dumped straight from the running PPSSPP session — no static
EBOOT/ISO extraction needed. This is **fully opt-in**: without the setup
below, these two tools are simply never registered, and the rest of the
server has no Python or Ghidra dependency at all.

**Setup:**
1. Install [Ghidra](https://github.com/NationalSecurityAgency/ghidra/releases) and note its install directory.
2. `pip install pyghidra`
3. Set `GHIDRA_INSTALL_DIR` to your Ghidra install path when launching `mcp-ppsspp`.

On startup, the server checks `GHIDRA_INSTALL_DIR` is set and that
`python3 -c "import pyghidra"` succeeds; if either fails, the decompile
tools are skipped (with a note on stderr) rather than being advertised and
then failing on every call.

**Architecture:** a long-lived Python child process
(`scripts/ghidra_sidecar.py`) hosts a persistent Ghidra program and talks to
the Node server over a private TCP loopback socket (newline-delimited JSON)
— not stdio, since Ghidra/JVM logging writes to the child's stdout, which
would otherwise corrupt a stdio-framed protocol. It starts lazily on the
first `ppsspp_decompile*` call in a session (JVM + Ghidra startup can take
tens of seconds) and is kept warm afterward. Code is always dumped with
`replacements:false` (bypassing PPSSPP's JIT "emuhack" markers — see the
memory tools section — this is hardcoded, not a parameter, since decompiling
the patched view would corrupt every JIT block's first instruction) and
imported at its real PSP address so absolute jumps/calls resolve correctly.
The Ghidra program is keyed by the currently-loaded game's disc ID and
persists across calls within a session — memory already imported is kept
(not re-dumped) so accumulated analysis isn't thrown away as you explore
adjacent functions.

**⚠️ Experimental:** the raw-binary-import-with-explicit-base-address path
in `scripts/ghidra_sidecar.py` was written against documented pyghidra/Ghidra
APIs but has not been exercised against a real Ghidra installation (this
project's development environment had no Ghidra distribution available to
test against — only the sidecar's IPC protocol layer itself was verified).
If you hit errors, check `scripts/ghidra_sidecar.py`'s comments for the
specific calls most likely to need adjusting for your Ghidra version, and
please report back what you find.

## Tools

| Tool | Description |
|------|-------------|
| `ppsspp_ping` | Verify connectivity (returns version) |
| `ppsspp_get_info` | Title, disc ID, version, run state |
| `ppsspp_read8` / `ppsspp_read16` / `ppsspp_read32` | Read u8 / u16-LE / u32-LE from PSP memory |
| `ppsspp_write8` / `ppsspp_write16` / `ppsspp_write32` | Write to PSP memory |
| `ppsspp_read_range` | Read up to 64 KiB as a byte array |
| `ppsspp_write_range` | Write byte array to memory |
| `ppsspp_read_string` | Read null-terminated UTF-8 string |
| `ppsspp_press_buttons` | Set persistent PSP button state |
| `ppsspp_press_button` | Press a button for N frames + auto-release |
| `ppsspp_send_analog` | Set analog stick position |
| `ppsspp_pause` / `ppsspp_resume` | Pause / resume emulation |
| `ppsspp_step` | Step one MIPS instruction |
| `ppsspp_reset` | Soft-reset the loaded game |
| `ppsspp_screenshot` | Capture framebuffer as inline PNG |
| `ppsspp_get_registers` / `ppsspp_set_register` | Read/write MIPS Allegrex registers |
| `ppsspp_breakpoint_add` / `_update` / `_remove` / `_list` | CPU execution breakpoints, with `condition`/`log`/`logFormat` |
| `ppsspp_watchpoint_add` / `_update` / `_remove` / `_list` | Memory watchpoints (read/write/change) — "break when this value changes" |
| `ppsspp_disasm` | MIPS disassembly at an address (PPSSPP's own disassembler) |
| `ppsspp_search_disasm` | Find the next disassembly line matching a substring |
| `ppsspp_evaluate` | Evaluate a register/label/operator expression |
| `ppsspp_backtrace` | Current call stack |
| `ppsspp_thread_list` | List PSP-OS (HLE) threads |
| `ppsspp_module_list` | List loaded PSP modules |
| `ppsspp_func_list` / `_add` / `_rename` / `_remove` / `_scan` | Session-only function symbol table |
| `ppsspp_data_list` / `_add` / `_rename` / `_remove` | Session-only data symbol table |
| `ppsspp_wait_for_break` | Resume and block until the next breakpoint/watchpoint hit, returning PC + disasm + registers + call stack in one call |
| `ppsspp_texture_dump` | Capture the currently-bound GPU texture, PPSSPP-decoded (visual PNG or raw pixel bytes + format) |
| `ppsspp_texture_clut_dump` | Capture the active palette (CLUT) for a paletted texture format |
| `ppsspp_scan_new` / `_filter` / `_list` / `_reset` | Cheat-Engine-style memory value scanner for finding unknown variables |
| `ppsspp_symbol_add` / `_list` / `_remove` / `_annotate` / `_sync` | Persistent, per-game named-address knowledge base (survives PPSSPP restarts) |
| `ppsspp_decompile` / `_refresh` | Pseudo-C decompilation via a local Ghidra sidecar (opt-in — see "Optional: pseudo-C decompilation" below) |

### PSP memory map (cheat sheet)

| Range                    | Region                          |
|--------------------------|---------------------------------|
| `0x00010000` - `0x00013FFF` | Scratchpad (fast 16 KiB SRAM)   |
| `0x04000000` - `0x041FFFFF` | VRAM (2 MiB GE video memory)    |
| `0x08000000` - `0x087FFFFF` | Kernel RAM (8 MiB, low half)    |
| `0x08800000` - `0x09FFFFFF` | User RAM (24 MiB, where most game state lives) |
| `0xBC000000+`              | Hardware registers              |

PSP is **little-endian** (MIPS Allegrex). Kernel-mode mirrors at `0x88xxxxxx` map to the same physical RAM as `0x08xxxxxx`.

### PSP buttons

`cross`, `circle`, `triangle`, `square`, `up`, `down`, `left`, `right`, `start`, `select`, `ltrigger`, `rtrigger`, `home`.

### Diagnosing a texture decoder against PPSSPP's reference

PPSSPP only exposes "the currently bound texture" (no API to list every
cached texture at once), so cataloging several means pausing/stepping to
each relevant draw call. Workflow for tracking down a texture-decoding bug
in a separate tool (wrong swizzle/unswizzle, wrong CLUT indexing, wrong
pixel format):

1. `ppsspp_breakpoint_add` at (or near) the draw call using the texture,
   then `ppsspp_wait_for_break` to land on it.
2. `ppsspp_texture_dump` with `mode: "raw"` — PPSSPP's format descriptor
   (e.g. `A1B5G5R5_UNORM_PACK16`) plus the already-decoded native pixel
   bytes are ground truth for what that VRAM data actually means.
3. For paletted (4-bit/8-bit indexed) formats, `ppsspp_texture_clut_dump`
   for the active palette PPSSPP is using.
4. `ppsspp_read_range` over the texture's VRAM address (`0x04000000` -
   `0x041FFFFF`) for the raw, undecoded bytes — diff your own decoder's
   output for those same bytes against PPSSPP's decode from step 2 to
   isolate exactly where the two diverge.
5. `ppsspp_texture_dump` with the default `mode: "visual"` for a quick
   eyeball PNG once you just want to confirm what a texture looks like.

### Finding an unknown variable's address

The end-to-end loop for locating something like a physics variable whose
address you don't know yet:

1. `ppsspp_scan_new` — seed with a value or range if you can (e.g. "speed
   ≈ 0 while parked") to avoid an expensive unfiltered full-RAM scan.
2. Change the value in-game (accelerate, brake, ...), then
   `ppsspp_scan_filter` with `increased`/`decreased`/`changed` to narrow.
   Repeat until only a handful of candidates remain (`ppsspp_scan_list`).
3. `ppsspp_watchpoint_add` (`write` or `change`) on the surviving
   candidate, then `ppsspp_wait_for_break` — execution halts at the exact
   instruction that touches it, with registers and a call stack already
   bundled in the response.
4. `ppsspp_scan_reset` once you're done with that session.

## Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| `PPSSPP_PORT must be set` on startup | Set the env var to the port shown in PPSSPP's Developer Tools dialog |
| `WebSocket connection failed` | PPSSPP isn't running, "Allow remote debugger" isn't checked, or you have the wrong port |
| Tool calls hang / time out | Check the PPSSPP UI is responding; the WebSocket request requires PPSSPP's main loop to dispatch |
| `Invalid address` on memory ops | Address is outside the PSP's mapped regions (user RAM is `0x08800000+`, not `0x00000000+`) |
| Screenshot returns no data | No game loaded — boot an ISO/EBOOT first |
| Buttons don't seem to do anything | PPSSPP's input has the buttons but they may not "feel" right via remote input if the game polls fast; try `ppsspp_press_button` with a longer `duration` |

## Limitations

- **No savestate API** — PPSSPP's WebSocket debugger doesn't expose `savestate.save` / `load`. Use PPSSPP's keybinds (F1-F8 for slots) via the UI for now. Could be hacked by using `input.buttons.press` to trigger the keybind, but not native.
- **Frame-advance is instruction-level only** (`cpu.stepInto`). To advance a whole frame, set a breakpoint at the vblank handler and `resume`.
- **Analog stick is shared state** — `ppsspp_send_analog` updates the persistent stick position; not auto-released.

## Development

```bash
npm install
npm run dev       # tsc --watch — autobuilds on src/ changes
npm test          # Vitest — mocks the WebSocket, no PPSSPP instance needed
```

## Debugging with the MCP Inspector

Browse and call this server's tools interactively with the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
PPSSPP_PORT=<port> npm run inspector
```

Build first if you've edited `src/` since your last `npm install` (`npm run build`, or keep `npm run dev` running). `mcp-ppsspp` has no default port — read the active one off PPSSPP's **Developer Tools → Allow remote debugger** dialog and pass it as `PPSSPP_PORT`. `tools/list` works even without PPSSPP connected; *calling* a tool needs PPSSPP running with the remote debugger enabled.

## License

[MIT](LICENSE)
