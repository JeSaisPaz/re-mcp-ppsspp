import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ok, addrHex, type ToolModule } from "./shared.js";
import { MemoryScanner, type ScanType, type ScanPredicate } from "../scanner.js";

const scanner = new MemoryScanner();

const TYPE_ENUM = ["u8", "i8", "u16", "i16", "u32", "i32", "float32"];
const PREDICATE_ENUM = ["exact", "changed", "unchanged", "increased", "decreased", "increasedBy", "decreasedBy", "range"];

const tools: Tool[] = [
  {
    name: "ppsspp_scan_new",
    description:
      "PURPOSE: Snapshot a PSP memory range as scan candidates — the first step of a Cheat-Engine-style search for an unknown variable's address (e.g. GT's speed, grip, or tire-load floats). " +
      "USAGE: Seed with a known value (`value`) or a plausible bound (`min`/`max`) whenever possible — an unfiltered full-range scan is the expensive path (hundreds of round trips over the ~24 MiB default range). Narrow `rangeStart`/`rangeEnd` too if you already suspect a region. Follow up with ppsspp_scan_filter after changing the value in-game to narrow further. " +
      "BEHAVIOR: Creates a new independent scan session (previous sessions are unaffected). Reads use PPSSPP's default replacements behavior — fine here since scans target DATA, not JIT-compiled code. " +
      "RETURNS: The new scan session ID and initial candidate count.",
    inputSchema: {
      type: "object",
      required: ["type"],
      properties: {
        type: { type: "string", enum: TYPE_ENUM, description: "Value width/signedness/kind to scan for." },
        rangeStart: { type: "integer", minimum: 0, description: "Default 0x08800000 (start of PSP user RAM)." },
        rangeEnd: { type: "integer", minimum: 0, description: "Default 0x0A000000 (end of the default 24 MiB user RAM range)." },
        value: { type: "number", description: "Optional seed: only keep addresses whose current value exactly equals this." },
        min: { type: "number", description: "Optional seed: only keep addresses whose current value is >= this." },
        max: { type: "number", description: "Optional seed: only keep addresses whose current value is <= this." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ppsspp_scan_filter",
    description:
      "PURPOSE: Narrow an existing scan session's candidates by re-reading their current values and applying a predicate against the previous snapshot. " +
      "USAGE: The iterative-narrowing step — change something in-game (e.g. accelerate, brake) between calls, then filter by 'increased'/'decreased'/'changed' to zero in on the address. 'exact'/'range' compare against an absolute value/bounds instead of the previous snapshot. " +
      "BEHAVIOR: Modifies the session in place — survivors' new values become the baseline for the next filter call. `tolerance` (default 0.0001) governs float32 comparisons: physics accumulator floats can drift by tiny amounts even when a value looks 'at rest', so exact float equality would spuriously reject real survivors. " +
      "RETURNS: Remaining candidate count plus a sample of up to 50 surviving address/value pairs.",
    inputSchema: {
      type: "object",
      required: ["scanId", "predicate"],
      properties: {
        scanId: { type: "string", description: "Session ID returned by ppsspp_scan_new." },
        predicate: { type: "string", enum: PREDICATE_ENUM },
        value: { type: "number", description: "Required for 'exact', 'increasedBy', 'decreasedBy'." },
        min: { type: "number", description: "For 'range'." },
        max: { type: "number", description: "For 'range'." },
        tolerance: { type: "number", description: "Default 0.0001. Only applies to float32 scans." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ppsspp_scan_list",
    description:
      "PURPOSE: List active scan sessions, or page through one session's surviving candidates. " +
      "USAGE: Check candidate counts across sessions, or inspect actual addresses/values once a session is narrow enough to look at directly. " +
      "BEHAVIOR: No side effects — pure read. " +
      "RETURNS: Without `scanId`: one line per session (id, type, range, candidate count). With `scanId`: paginated address/value pairs.",
    inputSchema: {
      type: "object",
      properties: {
        scanId: { type: "string", description: "Optional. Omit to list all sessions instead of one session's candidates." },
        offset: { type: "integer", minimum: 0, description: "Default 0. Only used with `scanId`." },
        limit: { type: "integer", minimum: 1, maximum: 1000, description: "Default 100. Only used with `scanId`." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ppsspp_scan_reset",
    description:
      "PURPOSE: Discard a scan session and free its memory. " +
      "USAGE: Clean up once you've found the address (or want to restart a scan from scratch). " +
      "BEHAVIOR: Irreversible — the session's candidate list is gone. " +
      "RETURNS: Confirmation.",
    inputSchema: {
      type: "object",
      required: ["scanId"],
      properties: { scanId: { type: "string" } },
      additionalProperties: false,
    },
  },
];

function fmtValue(type: ScanType, v: number): string {
  return type === "float32" ? v.toFixed(6) : String(v);
}

export const scannerTools: ToolModule = {
  tools,
  handlers: {
    ppsspp_scan_new: async (pp, p) => {
      const session = await scanner.newScan(pp, {
        type: p.type as ScanType,
        rangeStart: p.rangeStart as number | undefined,
        rangeEnd: p.rangeEnd as number | undefined,
        value: p.value as number | undefined,
        min: p.min as number | undefined,
        max: p.max as number | undefined,
      });
      return ok(`Scan ${session.id} created: ${session.count} candidate${session.count === 1 ? "" : "s"} (type ${session.type}, range ${addrHex(session.rangeStart)}-${addrHex(session.rangeEnd)})`);
    },

    ppsspp_scan_filter: async (pp, p) => {
      const session = await scanner.filter(pp, p.scanId as string, {
        predicate: p.predicate as ScanPredicate,
        value: p.value as number | undefined,
        min: p.min as number | undefined,
        max: p.max as number | undefined,
        tolerance: p.tolerance as number | undefined,
      });
      const sampleCount = Math.min(50, session.count);
      const sample = Array.from({ length: sampleCount }, (_, i) => `  ${addrHex(session.addresses[i])} = ${fmtValue(session.type, session.values[i])}`);
      return ok(`Scan ${session.id}: ${session.count} candidate${session.count === 1 ? "" : "s"} remaining\n${sample.join("\n")}`);
    },

    ppsspp_scan_list: async (_pp, p) => {
      if (p.scanId === undefined) {
        const sessions = scanner.list();
        if (sessions.length === 0) return ok("No active scan sessions.");
        return ok(sessions.map((s) =>
          `  ${s.id}: ${s.count} candidates, type=${s.type}, range=${addrHex(s.rangeStart)}-${addrHex(s.rangeEnd)}`).join("\n"));
      }
      const session = scanner.get(p.scanId as string);
      const offset = (p.offset as number | undefined) ?? 0;
      const limit = (p.limit as number | undefined) ?? 100;
      const lines: string[] = [];
      for (let i = offset; i < Math.min(session.count, offset + limit); i++) {
        lines.push(`  ${addrHex(session.addresses[i])} = ${fmtValue(session.type, session.values[i])}`);
      }
      return ok(`Scan ${session.id}: showing ${lines.length} of ${session.count} candidates (offset ${offset})\n${lines.join("\n")}`);
    },

    ppsspp_scan_reset: async (_pp, p) => {
      const scanId = p.scanId as string;
      scanner.reset(scanId);
      return ok(`Scan ${scanId} discarded.`);
    },
  },
};
