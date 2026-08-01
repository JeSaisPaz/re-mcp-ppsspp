import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { PpssppClient } from "../ppsspp.js";
import { ok, addrHex, type ToolModule } from "./shared.js";
import { PyghidraSidecar } from "../decompiler.js";

const DEFAULT_DUMP_SIZE = 4096;

interface DecompileResult {
  pseudoC: string;
  disasm?: string;
  functionName?: string;
  signature?: string;
}

/** Tracks which game's code is currently loaded into the sidecar's Ghidra
 *  program, so a game switch resets it instead of mixing two games'
 *  address spaces into one program. */
class DecompileSession {
  constructor(private readonly sidecar: PyghidraSidecar) {}
  private discId: string | null = null;
  private hasImported = false;

  private async ensureProgramFor(pp: PpssppClient): Promise<void> {
    const status = await pp.call<{ game?: { id?: string } | null }>("game.status");
    const discId = status.game?.id;
    if (!discId) {
      throw new Error("No game loaded — decompilation needs a loaded game's disc ID to key the Ghidra program.");
    }
    if (this.discId !== discId) {
      await this.sidecar.call("reset", {});
      this.discId = discId;
      this.hasImported = false;
    }
  }

  async decompile(pp: PpssppClient, address: number, size: number, forceReplace: boolean): Promise<DecompileResult> {
    await this.ensureProgramFor(pp);
    // Code reads for decompilation MUST bypass PPSSPP's JIT "emuhack"
    // markers — replacements:false is hardcoded here, not a tool
    // parameter, since decompiling the patched view would corrupt every
    // JIT-compiled block's first instruction.
    const r = await pp.call<{ base64?: string }>("memory.read", { address, size, replacements: false });
    if (!r.base64) throw new Error(`Could not read ${size} bytes at ${addrHex(address)}`);

    if (!this.hasImported) {
      await this.sidecar.call("import_blob", { baseAddress: address, bytes: r.base64 });
      this.hasImported = true;
    } else {
      await this.sidecar.call("add_blob", { baseAddress: address, bytes: r.base64, mode: forceReplace ? "replace" : "skip" });
    }
    return this.sidecar.call<DecompileResult>("decompile", { address });
  }
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

const tools: Tool[] = [
  {
    name: "ppsspp_decompile",
    description:
      "PURPOSE: Decompile PSP MIPS code at an address into pseudo-C, using a local Ghidra instance (via pyghidra) fed with LIVE memory dumped from the running PPSSPP session. " +
      "USAGE: For understanding a function's logic beyond what raw disassembly (ppsspp_disasm) shows — e.g. reconstructing a physics formula. Only registered when this MCP server was started with GHIDRA_INSTALL_DIR set and pyghidra importable; its absence from your tool list means that setup is missing (see README). EXPERIMENTAL: this feature's Ghidra integration has not been exhaustively validated across Ghidra versions — cross-check surprising output against ppsspp_disasm. " +
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
    },
  };
}
