# Decompilation roadmap — VFPU, static PRX/NID resolution, batch export

## Status

**Phases A–D are implemented** (`scripts/ghidra_sidecar.py`,
`src/tools/decompiler.ts`) as of this writing. **Phase E remains
deliberately out of scope.** Implementation notes and known-unverified
points are called out inline below, in addition to the general
"EXPERIMENTAL" caveat already on the whole decompiler bridge (this
project's development environment has no Ghidra install to test against —
see the README and `scripts/ghidra_sidecar.py`'s own docstring).

## Context

The Phase 6 PyGhidra bridge (`src/decompiler.ts`, `scripts/ghidra_sidecar.py`)
gives one-function-at-a-time pseudo-C from a raw memory dump imported at an
explicit base address. That's useful for interactive RE, but three gaps stop
it from being a serious decompilation workflow for a game like Gran Turismo,
whose physics code is vector/matrix-math-heavy:

1. **No VFPU support.** The Allegrex CPU's vector unit (VFPU) has its own
   instruction set (`vmul`, `vdot`, prefix instructions that modify the
   *next* instruction's operands, matrix/vector register files) that
   physics/graphics code leans on heavily. Ghidra's stock MIPS processor
   module doesn't decode it — those instructions show as raw bytes or
   garbage.
2. **No import/export name resolution.** Every SDK/OS call (`sceKernel*`,
   `sceGe*`, ...) shows as a bare address, drowning the game's own logic in
   unnamed boilerplate.
3. **No batch output.** `ppsspp_decompile` is one function at a time;
   there's no "decompile everything currently imported and export it" step.

Researched during planning (not assumed): **the tooling to solve #1 and #2
already exists and is actively maintained** —
[kotcrab/ghidra-allegrex](https://github.com/kotcrab/ghidra-allegrex)
(Apache 2.0) is a real Ghidra processor module adding full Allegrex+VFPU
disassembly *and decompilation*, PSP-specific ELF relocation handling, and
scripts to import/export PPSSPP's own `.sym` format. Its language ID is
confirmed from source: `Allegrex:LE:32:default`. Separately,
[pspdev/psp-ghidra-scripts](https://github.com/pspdev/psp-ghidra-scripts)'
`SonyPSPResolveNIDs.py` resolves NIDs (PSP's hashed import/export names)
against an XML database from the PSP PRX Libraries Documentation Project.

**Key realization that reshapes the plan**: PPSSPP is an *HLE* emulator — to
run a game at all, it must already resolve each imported SDK call's NID to
know which of its own HLE stubs to invoke. That means `ppsspp_func_list`
(Phase 1, wrapping `hle.func.list`) already contains resolved names for
everything PPSSPP recognizes, live, with zero extra tooling. The external
NID XML database becomes a fallback for the (hopefully rare) exports PPSSPP
doesn't model — not the primary naming mechanism.

Also: since we dump code from PPSSPP's live RAM (already decrypted,
already relocated to its final runtime address by PPSSPP's own loader),
there's no need to solve retail EBOOT.BIN decryption or ELF relocation
processing ourselves — the memory we read is already past both problems.
The gap is purely "hand Ghidra the *whole* resident module instead of an
arbitrary address window, using the right processor."

## Phase A — Adopt ghidra-allegrex (VFPU + correct Allegrex decode) ✅ Implemented

- **User setup** (documented in README, not automated — installing Ghidra
  extensions is a one-time per-install step): download the `ghidra-allegrex`
  release zip matching the user's Ghidra version from the project's
  releases page, install via Ghidra's *File → Install Extensions* (Ghidra
  19+) or manual copy into `Ghidra/Processors/` (Ghidra 18 and earlier).
- **`scripts/ghidra_sidecar.py`**: `ALLEGREX_LANGUAGE_ID =
  "Allegrex:LE:32:default"` (confirmed from the extension's own `.ldefs`),
  used in `import_blob`'s `program_loader().language(...)` call.
- **Deviation from the original plan**: did NOT add a filesystem-based
  "is the extension installed" check to `isGhidraAvailable()`. Ghidra
  extensions can land in more than one plausible location (bundled under
  `$GHIDRA_INSTALL_DIR`, or a user's separate application-settings
  `Extensions` folder depending on how Ghidra was installed/configured),
  and guessing wrong would produce a false "not available" even when the
  extension IS installed correctly. Instead, a missing extension surfaces
  as Ghidra's own clear "invalid language ID" exception on the first real
  decompile call — less proactive, but doesn't risk false negatives.
- **Verify live** (can't be done in this project's dev environment, which
  has no Ghidra install): confirm `Allegrex:LE:32:default` loads without
  error via `program_loader().language(...)` against your installed
  extension version.

## Phase B — Whole-module import (not just an ad-hoc address window) ✅ Implemented

- `src/tools/decompiler.ts`: `ppsspp_decompile_module(moduleName?)` looks
  up `hle.module.list` (via `ppsspp_module_list`, Phase 1) for the named
  module — or the one containing the current PC if `moduleName` is
  omitted — and dumps its **entire** address range in one import.
- The chunked-and-pipelined bulk read is `dumpMemoryRangeChunked()` in
  `src/tools/decompiler.ts`, built on a `mapConcurrent()` helper extracted
  to `src/concurrency.ts` (also now used by `src/scanner.ts`, which
  previously had its own private copy) — same "many round trips, bounded
  concurrency" shape as a full-RAM scan.
- Caveat (documented in the tool description and README): only captures
  modules PPSSPP currently has resident. An overlay/plugin PRX not yet
  loaded needs the game driven to the state that loads it first.

## Phase C — Auto-naming from PPSSPP's live HLE knowledge ✅ Implemented (live-HLE pass only)

- `scripts/ghidra_sidecar.py`'s `apply_symbols(entries)` batch-labels
  functions/data in the currently-open Ghidra program in one transaction.
- `ppsspp_decompile_module`'s handler (`syncKnownSymbols()` in
  `src/tools/decompiler.ts`) automatically merges `ppsspp_func_list` +
  `ppsspp_data_list` (session-live HLE names) **and** the persistent
  `ppsspp_symbol_list` (Phase 5) for the current disc ID, then pushes the
  union into the sidecar via `apply_symbols` — no separate manual sync
  step needed.
- **Not implemented in this pass** (still valid lower-priority follow-ups,
  deliberately deferred since the live-HLE pass already covers the bulk of
  "SDK noise" naming for a typical game):
  - The NID XML database fallback (`ppsspp_niddb.xml`, PSP PRX Libraries
    Documentation Project) for exports PPSSPP's HLE doesn't already know.
  - Interop with ghidra-allegrex's bundled PPSSPP `.sym`
    (`PpssppExportSymFile`/`PpssppImportSymFile`) format.

## Phase D — Batch decompile + export ✅ Implemented

- `scripts/ghidra_sidecar.py`'s `decompile_all()` iterates every function
  Ghidra's auto-analysis found in the current program and decompiles each
  (reusing the same `DecompInterface` setup as single-address `decompile`).
- `ppsspp_decompile_module_export(moduleName?, outDir?)` imports the module
  (Phase B) if needed, applies known symbols (Phase C), runs
  `decompile_all`, then writes one `ADDR_name.c` file per function under
  `~/.mcp-ppsspp/decompiled/<discId>/<moduleName>/` (or `outDir`) —
  building a real, browsable, offline codebase.
- Pairs with Phase 5: as more functions get named via
  `ppsspp_symbol_add`/`_annotate`, re-running the export produces
  progressively more readable output — a natural "checkpoint your RE
  progress as a codebase" action to run periodically.

## Phase E — Static ISO/EBOOT extraction (stretch, lower priority)

- For code that's *never* resident during any play session (a
  theoretically-unreached overlay), only a fully static path — extracting
  `EBOOT.BIN`/PRX files from the UMD image and importing them through
  Ghidra's normal ELF loader (auto-detected as `PSP Executable (ELF) /
  Allegrex` once Phase A's extension is installed) — would be more
  complete than the live-memory approach.
- Explicitly deprioritized: retail `EBOOT.BIN` is typically encrypted, and
  decrypting it requires per-game/per-firmware keys this project has no
  business distributing or automating — that stays the user's own
  responsibility with their own legally-obtained tools, entirely outside
  this MCP server's scope. Only worth revisiting if Phases B–D leave a
  real, specific gap (e.g. a known-unreachable overlay you need decompiled).

## Suggested build order

A → B → C (live-HLE naming first, NID DB fallback after) → D. Phase E only
if a concrete need shows up after using A–D for a while.

## Verification

- Phase A: import a small known PSP homebrew ELF with obvious VFPU usage
  (e.g. anything using `vfpu-docs`' sample code) and confirm Ghidra shows
  real VFPU mnemonics instead of raw bytes, and that decompiled output
  contains recognizable vector-math C rather than garbage.
- Phase B: dump a whole game module, confirm the byte count matches
  `hle.module.list`'s reported size and that Ghidra's auto-analysis finds a
  plausible number of functions (sanity check against `ppsspp_disasm`
  around a few known addresses).
- Phase C: after import, spot-check that common syscalls
  (`sceKernelCreateThread`, `sceGuDrawArray`, etc.) show by name in
  `ppsspp_decompile` output without manual intervention.
- Phase D: export a small module, confirm the file count matches the
  function count Ghidra found, and that named functions produce
  correspondingly-named files.
