import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ok, addrHex, ADDRESS_PARAM_DESC, type ToolModule } from "./shared.js";

const CONDITION_PARAM_DESC =
  "Optional MIPS-debugger expression (labels, registers, operators — same syntax as " +
  "ppsspp_evaluate) — the breakpoint only fires when this evaluates truthy. Omit for an " +
  "unconditional breakpoint.";
const LOG_PARAM_DESC =
  "Optional. If true, PPSSPP logs a line each time this fires instead of (or in addition " +
  "to) halting — useful for tracing a hot address without stopping execution every hit.";
const LOG_FORMAT_PARAM_DESC =
  "Optional format string for the log line when `log` is true (PPSSPP's breakpoint log " +
  "format syntax — supports embedding register/expression values).";

const tools: Tool[] = [
  {
    name: "ppsspp_breakpoint_add",
    description:
      "PURPOSE: Add a CPU execution breakpoint at the given PSP physical address. Emulation halts when PC reaches that address (unless `condition` is set and false, or `log` is set instead of a hard stop). " +
      "USAGE: For RE work and HLE intercepts. Combine with ppsspp_wait_for_break (or ppsspp_resume + ppsspp_get_registers) to inspect state when it's hit. For 'break when a value changes' instead of 'break at an address', use ppsspp_watchpoint_add. " +
      "BEHAVIOR: Modifies PPSSPP's breakpoint table. The breakpoint persists until removed via ppsspp_breakpoint_remove or PPSSPP restarts. Returns an error if the address isn't executable memory. " +
      "RETURNS: Single line 'Breakpoint added at ADDR_HEX'.",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: {
        address:   { type: "integer", minimum: 0, description: "PSP execution address. Usually in user RAM (0x08800000+) or kernel RAM." },
        enabled:   { type: "boolean", description: "Optional, default true. Set false to add it disabled (armed but inactive)." },
        log:       { type: "boolean", description: LOG_PARAM_DESC },
        condition: { type: "string", description: CONDITION_PARAM_DESC },
        logFormat: { type: "string", description: LOG_FORMAT_PARAM_DESC },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ppsspp_breakpoint_update",
    description:
      "PURPOSE: Change an existing CPU execution breakpoint's enabled/log/condition/logFormat without removing and re-adding it. " +
      "USAGE: Toggle a breakpoint off mid-session (`enabled:false`) instead of removing it, or tighten/loosen its condition. " +
      "BEHAVIOR: Modifies PPSSPP's breakpoint table in place. Returns an error if no breakpoint exists at `address`. " +
      "RETURNS: Single line confirming the update.",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: {
        address:   { type: "integer", minimum: 0, description: "Address of the existing breakpoint to update." },
        enabled:   { type: "boolean" },
        log:       { type: "boolean", description: LOG_PARAM_DESC },
        condition: { type: "string", description: CONDITION_PARAM_DESC },
        logFormat: { type: "string", description: LOG_FORMAT_PARAM_DESC },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ppsspp_breakpoint_remove",
    description:
      "PURPOSE: Remove a previously-added CPU execution breakpoint. " +
      "USAGE: Clean up breakpoints when done debugging. To remove all, query ppsspp_breakpoint_list first. " +
      "BEHAVIOR: Modifies PPSSPP's breakpoint table. Idempotent for non-existent breakpoints (no error). " +
      "RETURNS: Single line 'Breakpoint removed at ADDR_HEX'.",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: {
        address: { type: "integer", minimum: 0, description: "PSP execution address of the breakpoint to remove." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ppsspp_breakpoint_list",
    description:
      "PURPOSE: List all currently-set CPU execution breakpoints. " +
      "USAGE: Inventory before bulk-removing, or sanity-check what's set. " +
      "BEHAVIOR: No side effects — pure read. " +
      "RETURNS: Multi-line text, one line per breakpoint with its address, enabled/log state, condition, and symbol if known.",
    inputSchema: { type: "object", properties: {} },
  },

  // ── Memory watchpoints (data breakpoints) ─────────────────────────────────

  {
    name: "ppsspp_watchpoint_add",
    description:
      "PURPOSE: Add a memory watchpoint — halts (or logs) when the given address range is read, written, or changed. This is a DATA breakpoint, distinct from ppsspp_breakpoint_add's execution breakpoints. " +
      "USAGE: The core tool for finding what code touches a variable you've located (e.g. via a memory scan): arm `write` or `change` on the candidate address, then ppsspp_resume or ppsspp_wait_for_break — execution halts at the instruction that touches it, with ppsspp_get_registers/ppsspp_backtrace showing exactly which code did it. " +
      "BEHAVIOR: Modifies PPSSPP's memory-breakpoint table. At least one of `read`/`write`/`change` should be true (PPSSPP defaults 'change' semantics if none given — prefer `write:true` for a plain write-breakpoint, or `change:true` if you want it to fire on writes that alter the value but not writes of the same value). Persists until removed or PPSSPP restarts. " +
      "RETURNS: Single line confirming the watchpoint and its size/flags.",
    inputSchema: {
      type: "object",
      required: ["address", "size"],
      properties: {
        address:   { type: "integer", minimum: 0, description: ADDRESS_PARAM_DESC },
        size:      { type: "integer", minimum: 1, description: "Byte width of the watched range starting at `address` (e.g. 4 for a 32-bit float/int field)." },
        read:      { type: "boolean", description: "Fire on any read of the range." },
        write:     { type: "boolean", description: "Fire on any write to the range (regardless of whether the value actually changed)." },
        change:    { type: "boolean", description: "Fire only on writes that actually change the value — quieter than `write` for fields that get rewritten with the same value every frame." },
        enabled:   { type: "boolean", description: "Optional, default true." },
        log:       { type: "boolean", description: LOG_PARAM_DESC },
        condition: { type: "string", description: CONDITION_PARAM_DESC },
        logFormat: { type: "string", description: LOG_FORMAT_PARAM_DESC },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ppsspp_watchpoint_update",
    description:
      "PURPOSE: Change an existing memory watchpoint's flags/condition without removing and re-adding it. " +
      "USAGE: Same address+size identifies which watchpoint to update — matches PPSSPP's own addressing (a watchpoint is keyed by its address+size pair). " +
      "BEHAVIOR: Modifies PPSSPP's memory-breakpoint table in place. Returns an error if no watchpoint exists at that address+size. " +
      "RETURNS: Single line confirming the update.",
    inputSchema: {
      type: "object",
      required: ["address", "size"],
      properties: {
        address:   { type: "integer", minimum: 0, description: ADDRESS_PARAM_DESC },
        size:      { type: "integer", minimum: 1, description: "Must match the size the watchpoint was added with." },
        read:      { type: "boolean" },
        write:     { type: "boolean" },
        change:    { type: "boolean" },
        enabled:   { type: "boolean" },
        log:       { type: "boolean", description: LOG_PARAM_DESC },
        condition: { type: "string", description: CONDITION_PARAM_DESC },
        logFormat: { type: "string", description: LOG_FORMAT_PARAM_DESC },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ppsspp_watchpoint_remove",
    description:
      "PURPOSE: Remove a previously-added memory watchpoint. " +
      "USAGE: Clean up once you've identified the code touching a variable. " +
      "BEHAVIOR: Modifies PPSSPP's memory-breakpoint table. Idempotent for non-existent watchpoints. " +
      "RETURNS: Single line 'Watchpoint removed at ADDR_HEX'.",
    inputSchema: {
      type: "object",
      required: ["address", "size"],
      properties: {
        address: { type: "integer", minimum: 0, description: ADDRESS_PARAM_DESC },
        size:    { type: "integer", minimum: 1, description: "Must match the size the watchpoint was added with." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ppsspp_watchpoint_list",
    description:
      "PURPOSE: List all currently-set memory watchpoints, including hit counts. " +
      "USAGE: Check which watchpoints have actually fired (`hits`) versus which are still waiting — useful when several are armed at once while narrowing down a physics variable. " +
      "BEHAVIOR: No side effects — pure read. " +
      "RETURNS: Multi-line text, one line per watchpoint with address, size, flags, hit count, and symbol if known.",
    inputSchema: { type: "object", properties: {} },
  },
];

function bpParams(p: Record<string, unknown>) {
  return {
    address: p.address,
    ...(p.enabled !== undefined ? { enabled: p.enabled } : {}),
    ...(p.log !== undefined ? { log: p.log } : {}),
    ...(p.condition !== undefined ? { condition: p.condition } : {}),
    ...(p.logFormat !== undefined ? { logFormat: p.logFormat } : {}),
  };
}

function wpParams(p: Record<string, unknown>) {
  return {
    address: p.address,
    size: p.size,
    ...(p.read !== undefined ? { read: p.read } : {}),
    ...(p.write !== undefined ? { write: p.write } : {}),
    ...(p.change !== undefined ? { change: p.change } : {}),
    ...(p.enabled !== undefined ? { enabled: p.enabled } : {}),
    ...(p.log !== undefined ? { log: p.log } : {}),
    ...(p.condition !== undefined ? { condition: p.condition } : {}),
    ...(p.logFormat !== undefined ? { logFormat: p.logFormat } : {}),
  };
}

export const breakpointTools: ToolModule = {
  tools,
  handlers: {
    ppsspp_breakpoint_add: async (pp, p) => {
      await pp.call("cpu.breakpoint.add", bpParams(p));
      return ok(`Breakpoint added at ${addrHex(p.address as number)}`);
    },
    ppsspp_breakpoint_update: async (pp, p) => {
      await pp.call("cpu.breakpoint.update", bpParams(p));
      return ok(`Breakpoint updated at ${addrHex(p.address as number)}`);
    },
    ppsspp_breakpoint_remove: async (pp, p) => {
      await pp.call("cpu.breakpoint.remove", { address: p.address });
      return ok(`Breakpoint removed at ${addrHex(p.address as number)}`);
    },
    ppsspp_breakpoint_list: async (pp) => {
      const r = await pp.call<{ breakpoints?: Array<{ address: number; enabled?: boolean; log?: boolean; condition?: string; symbol?: string }> }>("cpu.breakpoint.list");
      const bps = r.breakpoints ?? [];
      if (bps.length === 0) return ok("No breakpoints set.");
      const lines = bps.map((b) =>
        `  ${addrHex(b.address)}${b.symbol ? ` (${b.symbol})` : ""} ${b.enabled === false ? "(disabled)" : ""}${b.log ? " [log]" : ""}${b.condition ? ` if ${b.condition}` : ""}`);
      return ok(`${bps.length} breakpoint${bps.length === 1 ? "" : "s"}:\n${lines.join("\n")}`);
    },

    ppsspp_watchpoint_add: async (pp, p) => {
      await pp.call("memory.breakpoint.add", wpParams(p));
      const flags = ["read", "write", "change"].filter((f) => p[f]).join("+") || "change (default)";
      return ok(`Watchpoint added at ${addrHex(p.address as number)} (size ${p.size}, ${flags})`);
    },
    ppsspp_watchpoint_update: async (pp, p) => {
      await pp.call("memory.breakpoint.update", wpParams(p));
      return ok(`Watchpoint updated at ${addrHex(p.address as number)} (size ${p.size})`);
    },
    ppsspp_watchpoint_remove: async (pp, p) => {
      await pp.call("memory.breakpoint.remove", { address: p.address, size: p.size });
      return ok(`Watchpoint removed at ${addrHex(p.address as number)} (size ${p.size})`);
    },
    ppsspp_watchpoint_list: async (pp) => {
      const r = await pp.call<{
        breakpoints?: Array<{
          address: number; size: number; enabled?: boolean; log?: boolean;
          read?: boolean; write?: boolean; change?: boolean; hits?: number;
          condition?: string; symbol?: string;
        }>;
      }>("memory.breakpoint.list");
      const wps = r.breakpoints ?? [];
      if (wps.length === 0) return ok("No watchpoints set.");
      const lines = wps.map((w) => {
        const flags = ["read", "write", "change"].filter((f) => (w as Record<string, unknown>)[f]).join("+") || "change";
        return `  ${addrHex(w.address)} size=${w.size}${w.symbol ? ` (${w.symbol})` : ""} [${flags}] hits=${w.hits ?? 0}${w.enabled === false ? " (disabled)" : ""}${w.condition ? ` if ${w.condition}` : ""}`;
      });
      return ok(`${wps.length} watchpoint${wps.length === 1 ? "" : "s"}:\n${lines.join("\n")}`);
    },
  },
};
