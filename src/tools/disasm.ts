import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ok, addrHex, formatBacktrace, ADDRESS_PARAM_DESC, type ToolModule, type BacktraceFrame } from "./shared.js";

export interface DisasmLine {
  address: number;
  name?: string;
  params?: string;
  symbol?: string;
  isCurrentPC?: boolean;
  breakpoint?: boolean;
  conditionMet?: boolean;
}

export function formatDisasmLines(lines: DisasmLine[]): string {
  return lines.map((l) => {
    const marker = l.isCurrentPC ? "→ " : "  ";
    const bp = l.breakpoint ? (l.conditionMet === false ? "○" : "●") : " ";
    const sym = l.symbol ? ` [${l.symbol}]` : "";
    const instr = [l.name, l.params].filter(Boolean).join(" ");
    return `${marker}${bp} ${addrHex(l.address)}: ${instr}${sym}`;
  }).join("\n");
}

const tools: Tool[] = [
  {
    name: "ppsspp_disasm",
    description:
      "PURPOSE: Disassemble MIPS Allegrex instructions starting at a PSP address, using PPSSPP's own disassembler. " +
      "USAGE: The core RE tool for reading code — inspect a function body, trace branches, or build a disassembly window around a breakpoint hit (ppsspp_wait_for_break does this automatically). Give either `count` (number of instructions) or `end` (address to stop at), not both. " +
      "BEHAVIOR: No side effects — pure read, safe to call while running or paused. `displaySymbols` (default true) inlines known function/data symbol names (from hle.func.* / ppsspp_symbol_sync) next to addresses they reference. " +
      "RETURNS: One line per instruction: a `→` marker on the current PC (if within range), a breakpoint dot, address, mnemonic + operands, and `[symbol]` if known.",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: {
        address: { type: "integer", minimum: 0, description: ADDRESS_PARAM_DESC },
        count: { type: "integer", minimum: 1, maximum: 500, description: "Number of instructions to disassemble (mutually exclusive with `end`)." },
        end: { type: "integer", minimum: 0, description: "Address to stop disassembling at, exclusive (mutually exclusive with `count`)." },
        displaySymbols: { type: "boolean", description: "Default true — inline known symbol names next to referenced addresses." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ppsspp_search_disasm",
    description:
      "PURPOSE: Search disassembled text for a substring match (e.g. a specific mnemonic or operand pattern), starting from an address. " +
      "USAGE: Find the next occurrence of an instruction pattern without manually paging through ppsspp_disasm output — e.g. search for 'jal' to find the next function call, or a specific register name in operands. " +
      "BEHAVIOR: No side effects — pure read. Searches forward from `address` to `end` (or a PPSSPP-chosen bound if omitted). " +
      "RETURNS: The matching address, or a message that nothing matched in range.",
    inputSchema: {
      type: "object",
      required: ["address", "match"],
      properties: {
        address: { type: "integer", minimum: 0, description: "Address to start searching from." },
        match: { type: "string", description: "Substring to search for in disassembled instruction text (e.g. 'jal', 'lui\tt0')." },
        end: { type: "integer", minimum: 0, description: "Optional address to stop searching at." },
        displaySymbols: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ppsspp_evaluate",
    description:
      "PURPOSE: Evaluate a MIPS-debugger expression (registers, labels, arithmetic/logic operators) via PPSSPP's expression engine. " +
      "USAGE: Quick one-off computation without a chain of separate register reads — e.g. 'a0+0x10', 'sp-4', a named symbol from ppsspp_symbol_sync. Also useful as the `condition` for ppsspp_breakpoint_add/ppsspp_watchpoint_add (same expression syntax). " +
      "BEHAVIOR: No side effects — pure read. Returns an error if the expression doesn't parse. " +
      "RETURNS: Single line with the uint and (if applicable) float interpretation of the result.",
    inputSchema: {
      type: "object",
      required: ["expression"],
      properties: {
        expression: { type: "string", description: "Expression using registers ($a0/a0, $sp/sp, pc, ...), labels/symbols, and operators (+ - * / & | etc.) — same syntax PPSSPP's own debugger UI accepts." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ppsspp_backtrace",
    description:
      "PURPOSE: Get the current MIPS call stack (who called who, up to the current PC). " +
      "USAGE: After a breakpoint/watchpoint hit, use this to see the calling context — which higher-level function led to the code that just touched your address of interest. Included automatically in ppsspp_wait_for_break's bundled response. " +
      "BEHAVIOR: No side effects — pure read. Most meaningful while the CPU is stopped (paused/stepping); walks the stack from the current frame using the stack pointer and saved return addresses. " +
      "RETURNS: One line per frame (innermost first): entry point, current PC within that frame, and stack pointer.",
    inputSchema: {
      type: "object",
      properties: {
        thread: { type: "integer", description: "Optional PPSSPP thread ID. Defaults to the current thread." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ppsspp_thread_list",
    description:
      "PURPOSE: List PSP-OS (HLE) threads — the game's kernel-level thread table, not host OS threads. " +
      "USAGE: Useful for games with multiple worker threads (e.g. separate physics/render/audio threads) — find the thread ID relevant to ppsspp_backtrace's `thread` param or ppsspp_get_registers-while-paused context. " +
      "BEHAVIOR: No side effects — pure read. " +
      "RETURNS: One line per thread: ID, name, status, priority, and current PC.",
    inputSchema: { type: "object", properties: {} },
  },

  // ── HLE function symbols ──────────────────────────────────────────────────

  {
    name: "ppsspp_func_list",
    description:
      "PURPOSE: List function symbols currently known to PPSSPP's live session (from firmware HLE modules and anything added via ppsspp_func_add / ppsspp_symbol_sync). " +
      "USAGE: See what's already named before adding a duplicate. NOTE: this reflects PPSSPP's in-memory session table, which does NOT persist across PPSSPP restarts — the durable store is ppsspp_symbol_add/ppsspp_symbol_sync (Phase 5). " +
      "BEHAVIOR: No side effects — pure read. " +
      "RETURNS: One line per function: address, size, name.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ppsspp_func_add",
    description:
      "PURPOSE: Register a named function symbol in PPSSPP's live session, so ppsspp_disasm/ppsspp_backtrace show its name instead of a bare address. " +
      "USAGE: After identifying what a function does (e.g. via ppsspp_decompile or manual analysis), name it here for readable disassembly during the rest of this session. For a persistent record across sessions, use ppsspp_symbol_add instead (or in addition). " +
      "BEHAVIOR: Modifies PPSSPP's live session-only symbol table — lost on PPSSPP restart. " +
      "RETURNS: Single line confirming address, size, and name.",
    inputSchema: {
      type: "object",
      required: ["address", "name"],
      properties: {
        address: { type: "integer", minimum: 0, description: "Function start address." },
        size: { type: "integer", minimum: 1, description: "Optional function size in bytes, if known." },
        name: { type: "string", description: "Name to display for this function." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ppsspp_func_rename",
    description:
      "PURPOSE: Rename an existing function symbol in PPSSPP's live session. " +
      "USAGE: Refine a name as understanding improves (e.g. 'sub_08812340' → 'CalcTireGrip'). " +
      "BEHAVIOR: Modifies PPSSPP's live session-only symbol table. Returns an error if no function is registered at that address. " +
      "RETURNS: Single line confirming the new name.",
    inputSchema: {
      type: "object",
      required: ["address", "name"],
      properties: {
        address: { type: "integer", minimum: 0 },
        name: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ppsspp_func_remove",
    description:
      "PURPOSE: Remove a function symbol from PPSSPP's live session. " +
      "USAGE: Undo a mis-scanned or incorrect entry. " +
      "BEHAVIOR: Modifies PPSSPP's live session-only symbol table. " +
      "RETURNS: Single line confirming removal.",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: { address: { type: "integer", minimum: 0 } },
      additionalProperties: false,
    },
  },
  {
    name: "ppsspp_func_scan",
    description:
      "PURPOSE: Run PPSSPP's built-in function-signature scanner over a memory range. " +
      "USAGE: PPSSPP's scanner matches known SDK/firmware library signatures (sceKernel*, sceGe*, and similar statically-linked PSP SDK functions) — NOT custom game logic. For a retail game like Gran Turismo whose own physics code is Polyphony-authored and stripped of debug symbols, expect this to identify recognizable SDK boilerplate around the game's own code, not the physics functions themselves — its value here is narrowing what to IGNORE in disassembly, not finding what to reverse-engineer. " +
      "BEHAVIOR: Modifies PPSSPP's live session-only symbol table with whatever it recognizes in range. " +
      "RETURNS: Confirmation that the scan ran (check ppsspp_func_list afterward for results).",
    inputSchema: {
      type: "object",
      required: ["address", "size"],
      properties: {
        address: { type: "integer", minimum: 0, description: "Start of the range to scan." },
        size: { type: "integer", minimum: 1, description: "Size of the range to scan, in bytes." },
        remove: { type: "boolean", description: "If true, remove existing signature-matched functions in range instead of adding." },
      },
      additionalProperties: false,
    },
  },

  // ── HLE data symbols ──────────────────────────────────────────────────────

  {
    name: "ppsspp_data_list",
    description:
      "PURPOSE: List named data symbols in PPSSPP's live session. " +
      "USAGE: Companion to ppsspp_func_list for non-code addresses (structs, tables, globals). Session-only — see ppsspp_symbol_add for a persistent record. " +
      "BEHAVIOR: No side effects — pure read. " +
      "RETURNS: One line per entry: address, size, type, name.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ppsspp_data_add",
    description:
      "PURPOSE: Register a named data symbol (struct/table/global) in PPSSPP's live session. " +
      "USAGE: Name a physics-state struct or array once you've located it, so disassembly referencing it shows the name. " +
      "BEHAVIOR: Modifies PPSSPP's live session-only symbol table — lost on PPSSPP restart; pair with ppsspp_symbol_add for persistence. " +
      "RETURNS: Single line confirming the entry.",
    inputSchema: {
      type: "object",
      required: ["address", "size", "type"],
      properties: {
        address: { type: "integer", minimum: 0 },
        size: { type: "integer", minimum: 1 },
        type: { type: "string", description: "Free-form type label PPSSPP stores alongside the entry (e.g. 'struct', 'array', 'float')." },
        name: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ppsspp_data_rename",
    description:
      "PURPOSE: Rename an existing data symbol in PPSSPP's live session. " +
      "BEHAVIOR: Modifies PPSSPP's live session-only symbol table. Returns an error if nothing is registered at that address. " +
      "RETURNS: Single line confirming the new name.",
    inputSchema: {
      type: "object",
      required: ["address", "name"],
      properties: {
        address: { type: "integer", minimum: 0 },
        name: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ppsspp_data_remove",
    description:
      "PURPOSE: Remove a data symbol from PPSSPP's live session. " +
      "BEHAVIOR: Modifies PPSSPP's live session-only symbol table. " +
      "RETURNS: Single line confirming removal.",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: { address: { type: "integer", minimum: 0 } },
      additionalProperties: false,
    },
  },

  {
    name: "ppsspp_module_list",
    description:
      "PURPOSE: List loaded PSP modules (the game's own PRX/ELF modules plus firmware HLE modules). " +
      "USAGE: Orient yourself in address space — which module owns the code at a given address, and whether it's currently active. " +
      "BEHAVIOR: No side effects — pure read. " +
      "RETURNS: One line per module: name, base address, size, active flag.",
    inputSchema: { type: "object", properties: {} },
  },
];

export const disasmTools: ToolModule = {
  tools,
  handlers: {
    ppsspp_disasm: async (pp, p) => {
      const address = p.address as number;
      const r = await pp.call<{ range?: { start: number; end: number }; lines?: DisasmLine[] }>(
        "memory.disasm",
        {
          address,
          ...(p.count !== undefined ? { count: p.count } : {}),
          ...(p.end !== undefined ? { end: p.end } : {}),
          displaySymbols: p.displaySymbols ?? true,
        },
      );
      const lines = r.lines ?? [];
      if (lines.length === 0) return ok(`No instructions returned for ${addrHex(address)}.`);
      return ok(formatDisasmLines(lines));
    },
    ppsspp_search_disasm: async (pp, p) => {
      const r = await pp.call<{ address?: number | null }>("memory.searchDisasm", {
        address: p.address,
        match: p.match,
        ...(p.end !== undefined ? { end: p.end } : {}),
        displaySymbols: p.displaySymbols ?? true,
      });
      if (r.address === null || r.address === undefined) {
        return ok(`No match for "${p.match as string}" found in range.`);
      }
      return ok(`Match found at ${addrHex(r.address)}`);
    },
    ppsspp_evaluate: async (pp, p) => {
      const r = await pp.call<{ uintValue?: number; floatValue?: string }>("cpu.evaluate", { expression: p.expression });
      const parts = [
        r.uintValue !== undefined ? addrHex(r.uintValue) : undefined,
        r.floatValue !== undefined ? `float ${r.floatValue}` : undefined,
      ].filter(Boolean);
      return ok(`${p.expression as string} = ${parts.join(" / ") || "(no result)"}`);
    },
    ppsspp_backtrace: async (pp, p) => {
      const r = await pp.call<{ frames?: BacktraceFrame[] }>(
        "hle.backtrace",
        p.thread !== undefined ? { thread: p.thread } : {},
      );
      return ok(formatBacktrace(r.frames ?? []));
    },
    ppsspp_thread_list: async (pp) => {
      const r = await pp.call<{ threads?: Array<{ id: number; name?: string; status?: string; priority?: number; pc?: number; isCurrent?: boolean }> }>("hle.thread.list");
      const threads = r.threads ?? [];
      if (threads.length === 0) return ok("(no threads)");
      const lines = threads.map((t) =>
        `  ${t.isCurrent ? "→ " : "  "}#${t.id} ${t.name ?? "(unnamed)"} [${t.status ?? "?"}] prio=${t.priority ?? "?"} pc=${t.pc !== undefined ? addrHex(t.pc) : "?"}`);
      return ok(lines.join("\n"));
    },

    ppsspp_func_list: async (pp) => {
      const r = await pp.call<{ functions?: Array<{ name: string; address: number; size?: number }> }>("hle.func.list");
      const fns = r.functions ?? [];
      if (fns.length === 0) return ok("(no functions registered)");
      return ok(fns.map((f) => `  ${addrHex(f.address)} size=${f.size ?? "?"} ${f.name}`).join("\n"));
    },
    ppsspp_func_add: async (pp, p) => {
      await pp.call("hle.func.add", { address: p.address, ...(p.size !== undefined ? { size: p.size } : {}), name: p.name });
      return ok(`Function ${p.name as string} added at ${addrHex(p.address as number)}`);
    },
    ppsspp_func_rename: async (pp, p) => {
      await pp.call("hle.func.rename", { address: p.address, name: p.name });
      return ok(`Function at ${addrHex(p.address as number)} renamed to ${p.name as string}`);
    },
    ppsspp_func_remove: async (pp, p) => {
      await pp.call("hle.func.remove", { address: p.address });
      return ok(`Function removed at ${addrHex(p.address as number)}`);
    },
    ppsspp_func_scan: async (pp, p) => {
      await pp.call("hle.func.scan", { address: p.address, size: p.size, ...(p.remove !== undefined ? { remove: p.remove } : {}) });
      return ok(`Scanned ${addrHex(p.address as number)} (${p.size as number} bytes) for known SDK signatures — check ppsspp_func_list for results.`);
    },

    ppsspp_data_list: async (pp) => {
      const r = await pp.call<{ data?: Array<{ name: string; address: number; size?: number; type?: string }> }>("hle.data.list");
      const items = r.data ?? [];
      if (items.length === 0) return ok("(no data symbols registered)");
      return ok(items.map((d) => `  ${addrHex(d.address)} size=${d.size ?? "?"} [${d.type ?? "?"}] ${d.name}`).join("\n"));
    },
    ppsspp_data_add: async (pp, p) => {
      await pp.call("hle.data.add", { address: p.address, size: p.size, type: p.type, ...(p.name !== undefined ? { name: p.name } : {}) });
      return ok(`Data symbol added at ${addrHex(p.address as number)} (${p.type as string}, size ${p.size as number})`);
    },
    ppsspp_data_rename: async (pp, p) => {
      await pp.call("hle.data.rename", { address: p.address, name: p.name });
      return ok(`Data symbol at ${addrHex(p.address as number)} renamed to ${p.name as string}`);
    },
    ppsspp_data_remove: async (pp, p) => {
      await pp.call("hle.data.remove", { address: p.address });
      return ok(`Data symbol removed at ${addrHex(p.address as number)}`);
    },

    ppsspp_module_list: async (pp) => {
      const r = await pp.call<{ modules?: Array<{ name: string; address: number; size?: number; isActive?: boolean }> }>("hle.module.list");
      const mods = r.modules ?? [];
      if (mods.length === 0) return ok("(no modules)");
      return ok(mods.map((m) => `  ${addrHex(m.address)} size=${m.size ?? "?"} ${m.isActive ? "[active]" : ""} ${m.name}`).join("\n"));
    },
  },
};
