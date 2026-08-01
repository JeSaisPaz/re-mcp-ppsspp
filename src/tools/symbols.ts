import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { PpssppClient } from "../ppsspp.js";
import { ok, addrHex, type ToolModule } from "./shared.js";
import { SymbolStore, type SymbolEntry, type SymbolType, type SymbolConfidence } from "../symbols.js";

const store = new SymbolStore();

/** Shared with tools/decompiler.ts, which needs the same disc-ID lookup to
 *  merge the persistent symbol store into a Ghidra program's labels. */
export async function currentDiscId(pp: PpssppClient): Promise<string> {
  const status = await pp.call<{ game?: { id?: string } | null }>("game.status");
  if (!status.game?.id) {
    throw new Error("No game loaded — symbol tools are keyed by PSP disc ID, load a game first.");
  }
  return status.game.id;
}

/** Best-effort mirror into PPSSPP's live session so ppsspp_disasm's
 *  displaySymbols shows the name immediately — never throws, returns
 *  whether it actually succeeded so callers can report accurate counts. */
async function syncOneToLive(pp: PpssppClient, entry: SymbolEntry): Promise<boolean> {
  try {
    if (entry.type === "data" || entry.type === "struct") {
      await pp.call("hle.data.add", { address: entry.address, size: entry.size ?? 4, type: entry.type, name: entry.name });
    } else {
      await pp.call("hle.func.add", { address: entry.address, ...(entry.size !== undefined ? { size: entry.size } : {}), name: entry.name });
    }
    return true;
  } catch {
    return false;
  }
}

const TYPE_ENUM = ["function", "data", "struct", "unknown"];
const CONFIDENCE_ENUM = ["confirmed", "hypothesis"];

const tools: Tool[] = [
  {
    name: "ppsspp_symbol_add",
    description:
      "PURPOSE: Record a named address (function, data, struct, or unknown) in a persistent, per-game knowledge base that survives PPSSPP restarts and MCP sessions — unlike ppsspp_func_add/ppsspp_data_add, which only affect PPSSPP's in-memory session. " +
      "USAGE: Save RE progress as you identify what an address does — e.g. after confirming a function's purpose via ppsspp_decompile, or naming a struct field mapped out via watchpoint hits. Keyed by the currently-loaded game's PSP disc ID (a game must be loaded). " +
      "BEHAVIOR: Persists to a JSON file under ~/.mcp-ppsspp/symbols/ (or MCP_PPSSPP_SYMBOLS_DIR). Errors if an entry already exists at this address unless `force:true`. By default (`syncToLive:true`) also best-effort mirrors into PPSSPP's live session (hle.func.add/hle.data.add) — non-fatal if that fails. " +
      "RETURNS: Confirmation of the saved entry.",
    inputSchema: {
      type: "object",
      required: ["address", "name", "type"],
      properties: {
        address: { type: "integer", minimum: 0 },
        name: { type: "string" },
        type: { type: "string", enum: TYPE_ENUM },
        size: { type: "integer", minimum: 1 },
        notes: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        confidence: { type: "string", enum: CONFIDENCE_ENUM },
        force: { type: "boolean", description: "Overwrite an existing entry at this address. Default false." },
        syncToLive: { type: "boolean", description: "Default true. Also mirror into PPSSPP's live session symbol table." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ppsspp_symbol_list",
    description:
      "PURPOSE: List persistent symbols recorded for the currently-loaded game. " +
      "USAGE: Review RE progress, or filter by type/tag/name substring/address range before deciding what to name next. " +
      "BEHAVIOR: No side effects — pure read. " +
      "RETURNS: One line per entry: address, type, name, and tags if any.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: TYPE_ENUM },
        tag: { type: "string" },
        nameContains: { type: "string" },
        addressMin: { type: "integer", minimum: 0 },
        addressMax: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ppsspp_symbol_remove",
    description:
      "PURPOSE: Delete a persistent symbol entry. " +
      "BEHAVIOR: Modifies the per-game JSON store. Returns an error if nothing is recorded at that address. " +
      "RETURNS: Confirmation.",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: { address: { type: "integer", minimum: 0 } },
      additionalProperties: false,
    },
  },
  {
    name: "ppsspp_symbol_annotate",
    description:
      "PURPOSE: Add a freeform, timestamped note to an existing persistent symbol. " +
      "USAGE: Build a running narrative for an address as understanding deepens (e.g. 'confirmed increases while drifting') without losing earlier notes. " +
      "BEHAVIOR: By default (`append:true`) adds a new timestamped line to existing notes; `append:false` replaces them entirely. Returns an error if no symbol exists at that address yet — add one with ppsspp_symbol_add first. " +
      "RETURNS: Confirmation with the updated notes.",
    inputSchema: {
      type: "object",
      required: ["address", "notes"],
      properties: {
        address: { type: "integer", minimum: 0 },
        notes: { type: "string" },
        append: { type: "boolean", description: "Default true." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ppsspp_symbol_sync",
    description:
      "PURPOSE: Push every persistent symbol recorded for the currently-loaded game into PPSSPP's live session (hle.func.add/hle.data.add), so ppsspp_disasm/ppsspp_backtrace show readable names. " +
      "USAGE: Call once after loading/resetting the game — PPSSPP's own symbol tables don't survive restarts, so this re-establishes them from the persistent store in one batch instead of relying on syncToLive from each individual ppsspp_symbol_add call. " +
      "BEHAVIOR: Best-effort — a failure on one entry doesn't stop the rest. " +
      "RETURNS: Count of entries synced.",
    inputSchema: { type: "object", properties: {} },
  },
];

export const symbolTools: ToolModule = {
  tools,
  handlers: {
    ppsspp_symbol_add: async (pp, p) => {
      const discId = await currentDiscId(pp);
      const entry = await store.add(discId, {
        address: p.address as number,
        name: p.name as string,
        type: p.type as SymbolType,
        size: p.size as number | undefined,
        notes: p.notes as string | undefined,
        tags: p.tags as string[] | undefined,
        confidence: p.confidence as SymbolConfidence | undefined,
      }, { force: p.force as boolean | undefined });

      if (p.syncToLive !== false) await syncOneToLive(pp, entry);
      return ok(`Symbol saved: ${addrHex(entry.address)} (${entry.type}) ${entry.name}`);
    },

    ppsspp_symbol_list: async (pp, p) => {
      const discId = await currentDiscId(pp);
      const entries = await store.list(discId, {
        type: p.type as SymbolType | undefined,
        tag: p.tag as string | undefined,
        nameContains: p.nameContains as string | undefined,
        addressMin: p.addressMin as number | undefined,
        addressMax: p.addressMax as number | undefined,
      });
      if (entries.length === 0) return ok("No persistent symbols recorded for this game yet.");
      const lines = entries.map((e) => `  ${addrHex(e.address)} [${e.type}] ${e.name}${e.tags?.length ? ` (${e.tags.join(", ")})` : ""}`);
      return ok(`${entries.length} symbol${entries.length === 1 ? "" : "s"}:\n${lines.join("\n")}`);
    },

    ppsspp_symbol_remove: async (pp, p) => {
      const discId = await currentDiscId(pp);
      const address = p.address as number;
      const removed = await store.remove(discId, address);
      if (!removed) throw new Error(`No persistent symbol at ${addrHex(address)}.`);
      return ok(`Symbol removed: ${addrHex(address)}`);
    },

    ppsspp_symbol_annotate: async (pp, p) => {
      const discId = await currentDiscId(pp);
      const entry = await store.annotate(discId, p.address as number, p.notes as string, p.append !== false);
      return ok(`Notes updated for ${addrHex(entry.address)} (${entry.name}):\n${entry.notes}`);
    },

    ppsspp_symbol_sync: async (pp) => {
      const discId = await currentDiscId(pp);
      const entries = await store.list(discId);
      let synced = 0;
      for (const entry of entries) {
        if (await syncOneToLive(pp, entry)) synced++;
      }
      return ok(`Synced ${synced}/${entries.length} symbols into the live session.`);
    },
  },
};
