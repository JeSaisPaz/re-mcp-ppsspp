# Decompilation roadmap — VFPU, static PRX/NID resolution, batch export

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

## Phase A — Adopt ghidra-allegrex (VFPU + correct Allegrex decode)

- **User setup** (documented in README, not automated — installing Ghidra
  extensions is a one-time per-install step): download the `ghidra-allegrex`
  release zip matching the user's Ghidra version from the project's
  releases page, install via Ghidra's *File → Install Extensions* (Ghidra
  19+) or manual copy into `Ghidra/Processors/` (Ghidra 18 and earlier).
- **`scripts/ghidra_sidecar.py`**: replace the placeholder
  `MIPS_LANGUAGE_ID = "MIPS:LE:32:default"` with
  `ALLEGREX_LANGUAGE_ID = "Allegrex:LE:32:default"` (confirmed from the
  extension's own `.ldefs`), used in both `import_blob` and any future
  loader calls.
- **`src/decompiler.ts`**: extend `isGhidraAvailable()`'s cheap startup
  probe with a filesystem-only check (no JVM boot) that
  `$GHIDRA_INSTALL_DIR/Extensions` or `Ghidra/Processors/Allegrex` contains
  the installed extension, so a missing-extension case fails at the same
  "tools not registered, clear stderr note" point as a missing Ghidra
  install, rather than as an opaque error on the first real decompile call.
- **Verify live** (can't be done in this project's dev environment, which
  has no Ghidra install): confirm the exact extension zip naming/version
  matching scheme and that `Allegrex:LE:32:default` loads without error via
  `program_loader().language(...)`.

## Phase B — Whole-module import (not just an ad-hoc address window)

- Extend `ppsspp_decompile`/`_refresh` with a `module` mode: instead of a
  caller-supplied `address`/`size`, look up `hle.module.list` (already
  wrapped by `ppsspp_module_list`, Phase 1) for the named (or currently
  active) module's base address + size, and dump that **entire** range in
  one import instead of a manually-guessed window.
- Reuse the scanner's chunked-and-pipelined read pattern
  (`src/scanner.ts`'s `mapConcurrent` + `CHUNK_SIZE` convention) for the
  bulk dump, since a full module can be several hundred KiB–low MiB —
  the same "many round trips, bounded concurrency" shape as a full-RAM
  scan.
- New tool: `ppsspp_decompile_module(moduleName?)` — `moduleName` optional,
  defaults to the module containing the current PC (useful right after a
  `ppsspp_wait_for_break`).
- **Document the caveat**: this only captures modules PPSSPP currently has
  resident. An overlay/plugin PRX not yet loaded needs the game driven to
  the state that loads it first — no static ISO extraction needed for
  anything that's actually run at least once in the session.

## Phase C — Auto-naming from PPSSPP's live HLE knowledge

- New sidecar command `apply_symbols(entries: [{address, name, type,
  size?}])` — batch-labels functions/data in the currently-open Ghidra
  program (loop over entries, `createLabel`/`createFunction` +
  `setName` per Ghidra's `SymbolTable`/`FlatProgramAPI`, inside one
  transaction for speed).
- After `ppsspp_decompile_module` imports a module, the Node side
  automatically calls `ppsspp_func_list` + `ppsspp_data_list` (session-live
  HLE names) **and** the persistent `ppsspp_symbol_list` (Phase 5, your own
  saved names) for the current disc ID, merges them, and pushes the result
  into the sidecar via `apply_symbols` — so decompiled output shows
  `sceKernelCreateThread`/`CalcTireGrip`/whatever's known immediately,
  without a separate manual sync step.
- **Fallback for what PPSSPP doesn't already know**: wire the NID XML
  database (`ppsspp_niddb.xml`, PSP PRX Libraries Documentation Project)
  into the sidecar as an optional, separately-downloaded data file
  (`GHIDRA_PSP_NIDDB_PATH` env var, unset = skip this step) — parse
  `sceModuleInfo`'s export/import NID tables from the imported blob
  (mirroring `SonyPSPResolveNIDs.py`'s approach) and apply anything the
  live-HLE pass above missed. Lower priority than the live-HLE pass, since
  that already covers the bulk of "SDK noise" naming for a typical game.
- **Nice-to-have, lower priority**: support the existing PPSSPP `.sym`
  format (`PpssppExportSymFile`/`PpssppImportSymFile` scripts bundled with
  ghidra-allegrex) as an alternate import/export path, for interop with
  anyone using vanilla Ghidra UI + PPSSPP outside this MCP server.

## Phase D — Batch decompile + export

- New sidecar command `decompile_all()`: iterate every function Ghidra's
  auto-analysis found in the current program (`program.getFunctionManager
  ().getFunctions(true)`), decompile each (reusing the existing
  `DecompInterface` setup from `decompile()`), return a list of
  `{address, name, pseudoC, signature}`.
- New tool `ppsspp_decompile_module_export(moduleName?, outDir?)`: runs
  `ppsspp_decompile_module` (Phase B) if not already imported, then
  `decompile_all`, then writes one `.c` file per function (named by its
  resolved symbol if Phase C named it, else its address) under
  `~/.mcp-ppsspp/decompiled/<discId>/<moduleName>/` — building a real,
  browsable, offline codebase instead of only interactive one-shot results.
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
