import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { PpssppClient } from "../ppsspp.js";
import { ok, addrHex, type ToolModule } from "./shared.js";
import { mapConcurrent } from "../concurrency.js";
import { PyghidraSidecar } from "../decompiler.js";
import { SymbolStore } from "../symbols.js";
import { currentDiscId } from "./symbols.js";

const DEFAULT_DUMP_SIZE = 4096;
// Matches ppsspp_read_range/scanner's "stay reasonable per round trip"
// convention — whole-module dumps can be several hundred KiB, so they're
// chunked and pipelined rather than requested in one giant call.
const CHUNK_SIZE = 0x10000;
const CHUNK_CONCURRENCY = 8;

interface DecompileResult {
  pseudoC: string;
  disasm?: string;
  functionName?: string;
  signature?: string;
}

interface ImportResult {
  functionCount?: number;
}

interface SymbolApplyResult {
  applied: number;
  total: number;
}

interface ModuleInfo {
  name: string;
  address: number;
  size: number;
}

/** Dumps a (possibly large) memory range as one base64 blob, via chunked
 *  concurrent reads — the same shape as the scanner's bulk snapshots, but
 *  producing one contiguous buffer instead of filtering candidates.
 *  Always reads with replacements:false: see the JIT-emuhack note below. */
async function dumpMemoryRangeChunked(pp: PpssppClient, address: number, size: number): Promise<string> {
  const buffer = Buffer.alloc(size);
  const offsets: number[] = [];
  for (let off = 0; off < size; off += CHUNK_SIZE) offsets.push(off);

  await mapConcurrent(offsets, CHUNK_CONCURRENCY, async (off) => {
    const chunkSize = Math.min(CHUNK_SIZE, size - off);
    const r = await pp.call<{ base64?: string }>("memory.read", {
      address: address + off,
      size: chunkSize,
      // Code reads for decompilation MUST bypass PPSSPP's JIT "emuhack"
      // markers — hardcoded here, not a tool parameter, since decompiling
      // the patched view would corrupt every JIT-compiled block's first
      // instruction.
      replacements: false,
    });
    if (!r.base64) throw new Error(`Could not read ${chunkSize} bytes at ${addrHex(address + off)}`);
    Buffer.from(r.base64, "base64").copy(buffer, off);
  });

  return buffer.toString("base64");
}

/** Tracks which game's code is currently loaded into the sidecar's Ghidra
 *  program, so a game switch resets it instead of mixing two games'
 *  address spaces into one program. */
class DecompileSession {
  constructor(private readonly sidecar: PyghidraSidecar) {}
  private discId: string | null = null;
  private hasImported = false;

  private async ensureProgramFor(pp: PpssppClient): Promise<void> {
    const discId = await currentDiscId(pp).catch(() => {
      throw new Error("No game loaded — decompilation needs a loaded game's disc ID to key the Ghidra program.");
    });
    if (this.discId !== discId) {
      await this.sidecar.call("reset", {});
      this.discId = discId;
      this.hasImported = false;
    }
  }

  private async importBytes(baseAddress: number, base64: string, forceReplace: boolean): Promise<ImportResult> {
    if (!this.hasImported) {
      const r = await this.sidecar.call<ImportResult>("import_blob", { baseAddress, bytes: base64 });
      this.hasImported = true;
      return r;
    }
    return this.sidecar.call<ImportResult>("add_blob", { baseAddress, bytes: base64, mode: forceReplace ? "replace" : "skip" });
  }

  async decompile(pp: PpssppClient, address: number, size: number, forceReplace: boolean): Promise<DecompileResult> {
    await this.ensureProgramFor(pp);
    const base64 = await dumpMemoryRangeChunked(pp, address, size);
    await this.importBytes(address, base64, forceReplace);
    return this.sidecar.call<DecompileResult>("decompile", { address });
  }

  /** Imports an entire resident module's memory range in one go, instead
   *  of a caller-guessed address window — see ppsspp_decompile_module. */
  async importModule(pp: PpssppClient, moduleAddress: number, moduleSize: number): Promise<ImportResult> {
    await this.ensureProgramFor(pp);
    const base64 = await dumpMemoryRangeChunked(pp, moduleAddress, moduleSize);
    return this.importBytes(moduleAddress, base64, false);
  }

  async applySymbols(entries: Array<{ address: number; name: string; type: "function" | "data" }>): Promise<SymbolApplyResult> {
    return this.sidecar.call<SymbolApplyResult>("apply_symbols", { entries });
  }

  async decompileAll(): Promise<{ functions: Array<{ address: number; name: string; signature?: string; pseudoC: string }> }> {
    return this.sidecar.call("decompile_all", {});
  }
}

/** Looks up a loaded module by name, or infers the one containing the
 *  current PC if `moduleName` is omitted. */
async function findModule(pp: PpssppClient, moduleName?: string): Promise<ModuleInfo> {
  const r = await pp.call<{ modules?: Array<{ name: string; address: number; size?: number }> }>("hle.module.list");
  const modules = r.modules ?? [];

  if (moduleName) {
    const m = modules.find((m) => m.name === moduleName);
    if (!m) throw new Error(`No loaded module named "${moduleName}" — use ppsspp_module_list to see what's loaded.`);
    return { name: m.name, address: m.address, size: m.size ?? 0 };
  }

  const status = await pp.call<{ pc?: number }>("cpu.status");
  if (status.pc === undefined) throw new Error("Could not determine current PC to infer the active module — pass moduleName explicitly.");
  const m = modules.find((m) => status.pc! >= m.address && status.pc! < m.address + (m.size ?? 0));
  if (!m) throw new Error(`No loaded module contains the current PC (${addrHex(status.pc)}) — pass moduleName explicitly.`);
  return { name: m.name, address: m.address, size: m.size ?? 0 };
}

/** Merges PPSSPP's own live HLE knowledge (it must resolve every imported
 *  SDK call's NID to know which HLE stub to run, so ppsspp_func_list/
 *  ppsspp_data_list already have names for everything it recognizes) with
 *  this MCP server's persistent per-game symbol store, then pushes the
 *  union into the sidecar's Ghidra program — so decompiled/disassembled
 *  output shows readable names immediately after a module import, with no
 *  separate manual sync step. Best-effort: a missing/empty source is fine. */
async function syncKnownSymbols(pp: PpssppClient, session: DecompileSession): Promise<number> {
  const entries: Array<{ address: number; name: string; type: "function" | "data" }> = [];

  const funcs = await pp.call<{ functions?: Array<{ name: string; address: number }> }>("hle.func.list").catch(() => ({ functions: [] }));
  for (const f of funcs.functions ?? []) entries.push({ address: f.address, name: f.name, type: "function" });

  const data = await pp.call<{ data?: Array<{ name: string; address: number }> }>("hle.data.list").catch(() => ({ data: [] }));
  for (const d of data.data ?? []) entries.push({ address: d.address, name: d.name, type: "data" });

  const discId = await currentDiscId(pp).catch(() => null);
  if (discId) {
    const persisted = await new SymbolStore().list(discId).catch(() => []);
    for (const s of persisted) {
      entries.push({ address: s.address, name: s.name, type: s.type === "data" || s.type === "struct" ? "data" : "function" });
    }
  }

  if (entries.length === 0) return 0;
  const r = await session.applySymbols(entries);
  return r.applied;
}

function formatResult(r: DecompileResult): string {
  const header = [
    r.functionName ? `Function: ${r.functionName}` : undefined,
    r.signature ? `Signature: ${r.signature}` : undefined,
  ].filter(Boolean).join("\n");
  return [
    header,
    "── Pseudo-C ──",
    r.pseudoC,
    r.disasm ? `\n── Disassembly ──\n${r.disasm}` : undefined,
  ].filter(Boolean).join("\n");
}

function safeFileNamePart(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]/g, "_");
}

const tools: Tool[] = [
  {
    name: "ppsspp_decompile",
    description:
      "PURPOSE: Decompile PSP MIPS/VFPU code at an address into pseudo-C, using a local Ghidra instance (via pyghidra, with the kotcrab/ghidra-allegrex extension for real VFPU support) fed with LIVE memory dumped from the running PPSSPP session. " +
      "USAGE: For understanding a function's logic beyond what raw disassembly (ppsspp_disasm) shows — e.g. reconstructing a physics formula. Only registered when this MCP server was started with GHIDRA_INSTALL_DIR set and pyghidra importable; its absence from your tool list means that setup is missing (see README). For whole-module context (better cross-references, less re-importing) use ppsspp_decompile_module first. EXPERIMENTAL: this feature's Ghidra integration has not been exhaustively validated across Ghidra versions — cross-check surprising output against ppsspp_disasm. " +
      "BEHAVIOR: Spawns (or reuses) a long-lived local Ghidra/JVM sidecar process on first use in a session — that first call can take tens of seconds (JVM + Ghidra startup). Dumps code with replacements:false (bypassing JIT emuhack markers — non-negotiable for correct decompilation). Imports into a Ghidra program keyed by the current game's disc ID; switching games resets it. Memory already imported by earlier calls is kept (not re-imported) so accumulated analysis isn't thrown away — use ppsspp_decompile_refresh to force a re-import of a specific region. " +
      "RETURNS: Pseudo-C text, the underlying disassembly, and an inferred function name/signature.",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: {
        address: { type: "integer", minimum: 0, description: "Address of the function/code to decompile." },
        size: { type: "integer", minimum: 4, description: "Bytes to dump starting at `address` if this region hasn't been imported yet. Default 4096." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ppsspp_decompile_refresh",
    description:
      "PURPOSE: Re-dump and re-decompile a region whose code may have changed since it was last imported. " +
      "USAGE: ppsspp_decompile skips re-importing a region it already has, by design (to preserve accumulated analysis) — use this to force a fresh dump of a specific region instead (e.g. after game state advanced past self-modifying/JIT-adjacent code, or you suspect a stale dump). " +
      "BEHAVIOR: Same JIT-safe dump as ppsspp_decompile, but replaces the sidecar's existing data for this region instead of skipping it. " +
      "RETURNS: Same shape as ppsspp_decompile.",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: {
        address: { type: "integer", minimum: 0 },
        size: { type: "integer", minimum: 4, description: "Default 4096." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ppsspp_decompile_module",
    description:
      "PURPOSE: Import an ENTIRE loaded PSP module's code+data into Ghidra in one shot, instead of an arbitrary caller-guessed address window — gives Ghidra's analyzer full context (correct function boundaries, cross-references) for everything the module contains. " +
      "USAGE: Run this once after reaching a game state that has the module of interest loaded, then use ppsspp_decompile(address) for individual functions within it — those calls will see the region already imported and skip straight to decompiling. Omit `moduleName` to target whichever module contains the current PC (handy right after ppsspp_wait_for_break). Automatically labels every function/data address PPSSPP's own live HLE knowledge or your persistent symbol store (ppsspp_symbol_add) already names. " +
      "BEHAVIOR: Dumps the module's full address range from PPSSPP's live (already decrypted and relocated) memory with replacements:false — no static EBOOT extraction or decryption needed. Only captures modules PPSSPP currently has resident; a not-yet-loaded overlay/plugin PRX needs the game driven to the state that loads it first. Can take a while for large modules (chunked, pipelined reads). " +
      "RETURNS: Confirmation with the module's address range, byte count, function count Ghidra's analyzer found, and how many known symbols were applied.",
    inputSchema: {
      type: "object",
      properties: {
        moduleName: { type: "string", description: "Exact name as shown by ppsspp_module_list. Omit to use the module containing the current PC." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ppsspp_decompile_module_export",
    description:
      "PURPOSE: Decompile EVERY function in a module and write one pseudo-C file per function to disk — a batch, browsable codebase instead of one-function-at-a-time interactive results. " +
      "USAGE: Run periodically as your persistent symbol store (ppsspp_symbol_add) grows — re-exporting after naming more functions produces progressively more readable output. Imports the module first if it isn't already (same as ppsspp_decompile_module). " +
      "BEHAVIOR: Writes to ~/.mcp-ppsspp/decompiled/<discId>/<moduleName>/ by default (override with `outDir`), one `ADDR_name.c` file per function. Can take a while for modules with many functions (decompiles each one). " +
      "RETURNS: Output directory path and number of files written.",
    inputSchema: {
      type: "object",
      properties: {
        moduleName: { type: "string", description: "Exact name as shown by ppsspp_module_list. Omit to use the module containing the current PC." },
        outDir: { type: "string", description: "Override the default ~/.mcp-ppsspp/decompiled/<discId>/<moduleName>/ output directory." },
      },
      additionalProperties: false,
    },
  },
];

export function createDecompilerTools(sidecar: PyghidraSidecar = new PyghidraSidecar()): ToolModule {
  const session = new DecompileSession(sidecar);
  return {
    tools,
    handlers: {
      ppsspp_decompile: async (pp, p) => {
        const address = p.address as number;
        const size = (p.size as number | undefined) ?? DEFAULT_DUMP_SIZE;
        const result = await session.decompile(pp, address, size, false);
        return ok(formatResult(result));
      },
      ppsspp_decompile_refresh: async (pp, p) => {
        const address = p.address as number;
        const size = (p.size as number | undefined) ?? DEFAULT_DUMP_SIZE;
        const result = await session.decompile(pp, address, size, true);
        return ok(formatResult(result));
      },

      ppsspp_decompile_module: async (pp, p) => {
        const mod = await findModule(pp, p.moduleName as string | undefined);
        if (!mod.size) throw new Error(`Module "${mod.name}" reports size 0 — nothing to import.`);
        const result = await session.importModule(pp, mod.address, mod.size);
        const applied = await syncKnownSymbols(pp, session);
        return ok(
          `Imported module "${mod.name}" (${addrHex(mod.address)}, ${mod.size} bytes). ` +
          `Ghidra found ${result.functionCount ?? "?"} function(s); applied ${applied} known symbol name(s). ` +
          `Use ppsspp_decompile(address) for individual functions within this range.`,
        );
      },

      ppsspp_decompile_module_export: async (pp, p) => {
        const mod = await findModule(pp, p.moduleName as string | undefined);
        if (!mod.size) throw new Error(`Module "${mod.name}" reports size 0 — nothing to import.`);
        await session.importModule(pp, mod.address, mod.size);
        await syncKnownSymbols(pp, session);

        const discId = await currentDiscId(pp);
        const outDir = (p.outDir as string | undefined)
          ?? path.join(os.homedir(), ".mcp-ppsspp", "decompiled", safeFileNamePart(discId), safeFileNamePart(mod.name));
        await fs.mkdir(outDir, { recursive: true });

        const { functions } = await session.decompileAll();
        let written = 0;
        for (const fn of functions) {
          const label = fn.name ? safeFileNamePart(fn.name) : `sub_${fn.address.toString(16)}`;
          const filePath = path.join(outDir, `${addrHex(fn.address)}_${label}.c`);
          const header = fn.signature ? `// ${fn.signature}\n` : "";
          await fs.writeFile(filePath, `${header}${fn.pseudoC}\n`, "utf8");
          written++;
        }
        return ok(`Exported ${written} function(s) from module "${mod.name}" to ${outDir}`);
      },
    },
  };
}
