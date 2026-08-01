# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Pseudo-C decompilation via Ghidra** (`ppsspp_decompile`/`_refresh`,
  new `src/decompiler.ts` + `scripts/ghidra_sidecar.py`) — fully opt-in,
  only registered when `GHIDRA_INSTALL_DIR` is set and `pyghidra` is
  importable; the rest of the server has zero Python/Ghidra dependency.
  A long-lived Python sidecar hosts a persistent Ghidra program per game
  (keyed by disc ID) and talks to the Node server over a private TCP
  loopback socket (newline-delimited JSON) rather than stdio, since
  Ghidra/JVM logging would otherwise corrupt a stdio-framed protocol.
  Code dumps hardcode `replacements:false` (JIT emuhack markers would
  corrupt decompilation otherwise) and import at their real PSP address
  so cross-references resolve correctly. Crash-isolated: a sidecar
  death rejects pending calls and restarts lazily on the next call,
  never taking down the MCP server itself.
  **Experimental**: the raw-binary-import-with-base-address path was
  written against documented pyghidra/Ghidra APIs but could not be
  exercised against a real Ghidra installation in this project's
  development environment (only the sidecar IPC protocol layer itself
  was verified end-to-end) — see the README's setup section.
- **Persistent per-game symbol store** (`ppsspp_symbol_add`/`_list`/`_remove`/
  `_annotate`/`_sync`, new `src/symbols.ts`) — a JSON file per PSP disc ID
  under `~/.mcp-ppsspp/symbols/` (override via `MCP_PPSSPP_SYMBOLS_DIR`),
  so named addresses/structs/notes survive PPSSPP restarts and MCP
  sessions, unlike PPSSPP's own `hle.func.*`/`hle.data.*` live-session
  tables. Atomic writes (temp file + rename) plus an in-process write
  lock. `ppsspp_symbol_add` best-effort mirrors into the live session by
  default so disassembly shows the name immediately; `ppsspp_symbol_sync`
  re-pushes everything in one batch after a game (re)load.
- **Memory value scanner** (`ppsspp_scan_new`/`_filter`/`_list`/`_reset`,
  new `src/scanner.ts`) — a Cheat-Engine-style search for an unknown
  variable's address: snapshot a range (optionally value/bounds-seeded),
  then iteratively narrow with `exact`/`changed`/`unchanged`/`increased`/
  `decreased`/`increasedBy`/`decreasedBy`/`range` predicates against the
  previous snapshot. Float scans use a tolerance (default 0.0001) since
  physics accumulator floats drift slightly frame to frame even at rest.
  Candidates are stored in typed arrays (not a JS `Map`) to keep a
  multi-million-entry full-RAM snapshot's memory footprint reasonable.
  Composes with the new watchpoints + `ppsspp_wait_for_break`: narrow to
  a candidate, arm a watchpoint on it, then catch the exact write site.
- **Texture/VRAM inspection**: `ppsspp_texture_dump` (wrapping
  `gpu.buffer.texture`) and `ppsspp_texture_clut_dump` (`gpu.buffer.clut`)
  — PPSSPP's own reference-correct texture decode, for diagnosing a
  separate texture-decoding implementation (swizzling, CLUT/palette
  handling, pixel format) against ground truth. `mode: "raw"` returns
  undecoded native pixel bytes + PPSSPP's format descriptor for byte-exact
  comparison; the default `"visual"` mode returns a viewable inline PNG.
  Shares the pause/capture/resume dance with `ppsspp_screenshot` (now
  factored into a shared `withStepping()` helper).
- **`ppsspp_wait_for_break`** — the core live-debugging loop: resumes
  execution (if stopped) and blocks until the CPU next stops for any
  reason, then returns PC + a disassembly window + full registers + call
  stack in ONE response, instead of a resume followed by three separate
  follow-up calls. `resume:false` peeks without disturbing current state.
  The reported stop reason is a best-effort reconstruction (breakpoint
  address match, or watchpoint hit-count delta) since PPSSPP's broadcast
  doesn't carry an explicit "why" field.
- **MIPS disassembly and expression evaluation**: `ppsspp_disasm` and
  `ppsspp_search_disasm` (wrapping PPSSPP's own `memory.disasm` /
  `memory.searchDisasm` — no bundled disassembler needed) and
  `ppsspp_evaluate` (`cpu.evaluate`, register/label/operator expressions).
- **Memory watchpoints** (`ppsspp_watchpoint_add/_update/_remove/_list`,
  wrapping `memory.breakpoint.*`) — data breakpoints on read/write/change,
  distinct from the existing execution breakpoints. The core building block
  for "find what code touches this variable."
- **Extended CPU breakpoints**: `ppsspp_breakpoint_add`/`_update` now accept
  `enabled`, `log`, `condition`, `logFormat` (previously only a bare
  address was ever sent to PPSSPP, even though it supports all of these).
- **HLE introspection**: `ppsspp_backtrace` (call stack), `ppsspp_thread_list`,
  `ppsspp_module_list`, and session-scoped symbol tables
  `ppsspp_func_list/_add/_rename/_remove/_scan` and
  `ppsspp_data_list/_add/_rename/_remove` (wrapping `hle.*`). Note:
  `ppsspp_func_scan` matches known PSP SDK/firmware signatures, not custom
  game code — see its tool description for what that means for RE work on
  a game like GT with no debug symbols.
- `PpssppClient` is now an `EventEmitter`: untracked broadcasts are
  re-emitted by their PPSSPP event name (plus a catch-all `"broadcast"`),
  and `"connected"`/`"disconnected"` fire at the existing socket
  open/close points. New `waitForBreak()` resolves on the next
  `cpu.stepping` broadcast — foundation for the upcoming
  `ppsspp_wait_for_break` live-debugging tool.

- **Vitest test suite** for `PpssppClient` (`src/ppsspp.test.ts`), mocking the
  `ws` WebSocket — covers ticket correlation, error responses, timeouts,
  `fireAndForget`/`waitForState`, and the reconnect state machine (regression
  coverage for the v0.1.3 stale-`readyPromise` bug). Wired into CI as a real
  test step (`npm test`), not just `tsc` type-checking.

### Fixed

- **`Dockerfile` was broken** — leftover from templating off `mcp-bizhawk`:
  referenced BizHawk throughout and copied a `lua/` directory that doesn't
  exist in this repo, so `docker build` would fail on that step. Cleaned up
  to describe this server's actual PPSSPP/WebSocket architecture.
- **MCP server version was hardcoded** to `"0.1.0"` in `src/index.ts`
  regardless of the real `package.json` version — clients saw a stale
  version string. Now read from `package.json` at startup.
- **`scripts/smoke.cjs` and `scripts/verify-screenshot.cjs` hardcoded
  Windows-only paths** (`C:/temp/...`) despite CI testing Linux/macOS/Windows
  — now use `os.tmpdir()`.

### Changed

- De-duplicated `ppsspp_read8/16/read32` and `ppsspp_write8/16/write32` in
  `src/tools.ts` behind shared width-parameterized generators — same
  behavior and tool descriptions, less copy-paste to keep in sync.
- **`src/tools.ts` split into `src/tools/`** (`core.ts`, `memory.ts`,
  `breakpoints.ts`, `disasm.ts`, `shared.ts`, `index.ts`) — one growing
  switch statement wasn't going to scale past the tool families landing in
  this release. No behavior change for existing tools.

## [0.2.0] - 2026-07-19

### Added

- **`ppsspp_set_register`** — write a single MIPS Allegrex register (GPR, PC,
  HI/LO, or FPU) via PPSSPP's `cpu.setReg`. The write counterpart to
  `ppsspp_get_registers`: redirect execution (`pc`), patch a return value
  (`v0`) or argument (`a0`-`a3`), etc. `value` accepts a JSON integer or a
  string for hex/float/special (`'0x1F'`, `'1.5'`, `'nan'`) forms. Closes the
  register-write half of the completeness gap flagged on the Glama profile.

### Note

- Savestate save/load (the other half of the flagged gap) remains
  **out of scope**: PPSSPP's WebSocket debugger exposes no savestate API
  (no `savestate.*` event group), so there is nothing to wrap. Use PPSSPP's
  F1-F8 save-slot keybinds.

## [0.1.5] - 2026-06-11

### Changed

- **BREAKING: minimum Node version raised from >=18 to >=22.** Node 18 (EOL
  April 2025) and 20 (EOL April 2026) are no longer supported; only active
  LTS lines are. CI matrix now tests Node 22 + 24, and workflow actions
  bumped to `actions/checkout@v5` / `actions/setup-node@v5` (the v4 actions'
  Node 20 runtime is deprecated by GitHub as of June 2026).
- **Docker base image moved to `node:22-trixie-slim`** (Debian 13) from the
  bookworm-based `node:22-slim`, whose `zlib1g` carries an unpatched
  integer-overflow CVE. Stays on Node 22 LTS.
- **README badges added** for Socket, Snyk, Bundlephobia, and npmgraph. The
  Snyk badge is live; the other three are static deep-link badges because
  their live image endpoints 403 or rate-limit and would render broken.

### Security

- **Transitive dependencies bumped to clear npm audit advisories** —
  lockfile-only bump within existing semver ranges: `hono` to >=4.12.21
  (GHSA-xrhx-7g5j-rcj5, GHSA-3hrh-pfw6-9m5x, GHSA-f577-qrjj-4474,
  GHSA-2gcr-mfcq-wcc3) and `qs` to >=6.15.2 (GHSA-q8mj-m7cp-5q26). Both
  arrive via `@modelcontextprotocol/sdk`'s HTTP-transport deps, which this
  stdio server does not use at runtime. `npm audit` now reports 0
  vulnerabilities.

## [0.1.4] - 2026-05-16

Closes the auto-reconnect gap that v0.1.2 and v0.1.3 missed: the
WebSocket close handler cleared `ws` and `ready` but **not** the
memoized `readyPromise`. After PPSSPP was closed mid-session
(taskkill, crash, user-quit), the next call would short-circuit on
the stale resolved promise and crash on `this.ws!.send(...)` —
the very "Cannot read properties of null (reading 'send')" error
that v0.1.2's `ensureConnected()` was supposed to make impossible.

In practice: v0.1.2/0.1.3 auto-reconnect worked for the *initial*
connection, but if PPSSPP was up at MCP startup and later closed,
the MCP server got wedged until restart. Surfaced live during an
E2E test of v0.1.3.

### Fixed

- **`readyPromise` cleared in WebSocket close handler** — one-line
  fix in `src/ppsspp.ts`. Now `start()` actually attempts a fresh
  connect on the next call instead of returning a cached resolved
  promise that points at a dead socket.

### Added

- **`scripts/verify-reconnect.cjs`** + `npm run verify:reconnect`
  — regression test that exercises the bug specifically:
  connects → pings → calls `ws.close()` to fire the close handler →
  pings again. PASS if the second ping doesn't throw the null-deref
  (i.e., `start()` didn't short-circuit on the stale promise).

[0.1.4]: https://github.com/dmang-dev/mcp-ppsspp/releases/tag/v0.1.4

## [0.1.3] - 2026-05-16

Screenshot default switched to the safer GPU readback path after a
real PPSSPP crash on a homebrew. Root cause is upstream
(`_assert_(buf != nullptr)` in `GPUBufferSubscriber.cpp` that
should be a graceful `req.Fail`); we can't catch a process abort
from outside, but we can stop steering callers into the
crash-prone code path by default.

### Changed

- **`ppsspp_screenshot` now defaults to `gpu.buffer.renderColor`**
  (reads the active GPU render target via
  `GPU_GetCurrentFramebuffer(GPU_DBG_FRAMEBUF_RENDER)`) instead of
  `gpu.buffer.screenshot` (which reads PPSSPP's final composited
  output via the crash-prone `GPU_GetOutputFramebuffer`). The
  render target is the actual rendered scene at PSP-native
  480×272, before PPSSPP's post-processing (scaling, shaders).
  For agent-vision use cases this is identical content; for
  matching what's on your monitor you'd want the post-processed
  output.
- **New `source` parameter on `ppsspp_screenshot`** (enum
  `'render' | 'output'`, default `'render'`) lets callers opt
  into the post-processed `gpu.buffer.screenshot` path when they
  specifically need it. The tool description carries a clear
  warning that `'output'` can crash PPSSPP on certain games.
  If PPSSPP does crash, v0.1.2's auto-reconnect ensures MCP
  recovers cleanly when PPSSPP is relaunched.

### Known limitations

- **`source: 'output'` can still crash PPSSPP** — this is an
  upstream bug. Once the assertion in `GPUBufferSubscriber.cpp`
  is converted to a `req.Fail` upstream, both sources will fail
  gracefully. Tracking upstream.

[0.1.3]: https://github.com/dmang-dev/mcp-ppsspp/releases/tag/v0.1.3

## [0.1.2] - 2026-05-16

Auto-reconnect now covers fire-and-forget commands too. Previously
`call()` would lazy-reconnect if PPSSPP had been closed and reopened,
but `fireAndForget()` (used by pause/resume/screenshot) still threw the
old "PPSSPP not connected — did you start() the client?" error,
leaving those tools broken across PPSSPP restarts until the MCP client
itself restarted.

### Fixed

- **`fireAndForget()` now auto-reconnects** — extracted the lazy
  connection guard from `call()` into a shared `ensureConnected()`
  helper, then routed `fireAndForget()` through it too. `ppsspp_pause`,
  `ppsspp_resume`, and `ppsspp_screenshot` (which internally uses
  fire-and-forget for the pause/capture/resume bracket) now survive a
  PPSSPP close-and-relaunch without needing the MCP server itself to
  restart. Same memoized-`readyPromise` safety as before: concurrent
  callers share a single underlying connect attempt.

### Changed

- **`fireAndForget()` is now `async`** (returns `Promise<void>`
  instead of `void`). All in-tree callers in `src/tools.ts` and
  `scripts/smoke.cjs` updated to `await` it. External callers (if
  any) must add `await` — but this package's `PpssppClient` is not
  documented as a public API, so no real consumers should be affected.

[0.1.2]: https://github.com/dmang-dev/mcp-ppsspp/releases/tag/v0.1.2

## [0.1.1] - 2026-05-16

Three real bugs surfaced by the first live test against PPSSPP v1.20.3 +
a homebrew PSP game. Protocol mapping was right in the abstract but
wrong in the details — fixing.

### Fixed

- **Memory reads were returning `undefined`** — PPSSPP's
  `memory.read_u8` / `_u16` / `_u32` responses use the field name
  `value`, not `uintValue` (which I'd assumed from the singular-register
  `cpu.getReg`/`setReg` responses, which DO use `uintValue`). Smoke
  test now confirms `read32` + write `0xDEADBEEF` + read-back round-trip.
- **`cpu.getAllRegs` response shape was wrong** — I'd assumed
  `{categories: [{name, registers: [{name, uintValue}]}]}`. Actual
  PPSSPP shape is `{categories: [{name, registerNames: [...],
  uintValues: [...], floatValues: [...]}]}` — **parallel arrays**, not
  an array of objects. Rewrote the handler to walk parallel arrays
  with bounds-aware indexing.
- **`cpu.stepping` and `cpu.resume` were hanging** — PPSSPP source
  documents these as "No immediate response. Once CPU is stepping, a
  'cpu.stepping' event will be sent" (async broadcast with no ticket).
  My ticketed `call()` was waiting 10s for a reply that never comes.
  Added `PpssppClient.fireAndForget(event, params)` and
  `PpssppClient.waitForState(predicate, opts)` which polls
  `cpu.status` (which IS synchronous) until the state change is
  detected. `ppsspp_pause` / `ppsspp_resume` / the screenshot
  internal pause/resume now use this pattern.

### Changed

- **`ppsspp_screenshot` now auto-pauses + auto-resumes** — PPSSPP's
  `gpu.buffer.screenshot` requires CPU or GPU to be stepping
  (otherwise "Neither CPU or GPU is stepping" error). The tool now
  transparently `cpu.stepping`s, captures, and `cpu.resume`s. If the
  caller had already paused, it leaves the state alone on exit.
  Also requests `type: "base64"` explicitly (default is `"uri"` which
  returns a `data:image/png;base64,...` prefix); belt-and-suspenders
  URI-prefix stripping kept as a fallback.

### Known limitations

- **`gpu.buffer.screenshot` is backend-dependent** — observed
  "Could not download output" on a homebrew where the GPU readback
  path can't fetch the framebuffer. This is a PPSSPP-side limitation,
  not a bug in our code. Likely works on commercial PSP games with
  normal rendering.

[0.1.1]: https://github.com/dmang-dev/mcp-ppsspp/releases/tag/v0.1.1

## [0.1.0] - 2026-05-16

Initial public release.

### Added

- **Node.js MCP server** that connects to PPSSPP's built-in WebSocket
  debugger interface (no Lua bridge needed — PPSSPP ships its own
  debugger). Subprotocol `debugger.ppsspp.org` on PPSSPP's dynamic
  debugger port.
- **20 MCP tools** spanning memory r/w (u8/u16/u32/range/string),
  input (buttons.send, buttons.press, analog.send), emulator control
  (pause, resume, step, reset, screenshot), CPU debugger
  (get_registers), and CPU execution breakpoints (add/remove/list).
- **Inline screenshot returns** — `ppsspp_screenshot` returns the PSP
  framebuffer as a base64 PNG content block, viewable directly in the
  MCP client (Claude, etc.) without separate read calls.
- **TDQS-templated tool descriptions** — every tool follows the
  PURPOSE / USAGE / BEHAVIOR / RETURNS structure with explicit
  PSP-specific context (memory map, button names, MIPS-LE).
- **Cross-platform install paths**: `npm install -g mcp-ppsspp`,
  `npx -y mcp-ppsspp`, or clone-and-build.
- **GitHub Actions CI** building on Node 18/20/22 across
  Linux/macOS/Windows.
- **Dockerfile + glama.json** for the [Glama MCP registry](https://glama.ai/mcp/servers).

### Known limitations

- **No savestate API exposed by PPSSPP's WebSocket** — savestate
  save/load isn't in the debugger interface. Use PPSSPP's keybinds
  (F1-F8 for slots) via the UI.
- **Frame-advance is instruction-level only** (`cpu.stepInto` steps
  one MIPS instruction, not one rendered frame). For frame stepping,
  set a breakpoint at the vblank handler and resume.

[Unreleased]: https://github.com/dmang-dev/mcp-ppsspp/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/dmang-dev/mcp-ppsspp/releases/tag/v0.2.0
[0.1.5]: https://github.com/dmang-dev/mcp-ppsspp/releases/tag/v0.1.5
[0.1.0]: https://github.com/dmang-dev/mcp-ppsspp/releases/tag/v0.1.0
