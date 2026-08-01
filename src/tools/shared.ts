// Shared helpers/types for the tools/ domain modules — formatting, the
// per-module registration contract, and the memory-width table used by
// both the read/write tool generators (memory.ts) and their dispatcher.

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { PpssppClient } from "../ppsspp.js";

export type ToolResult = {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
};

export type ToolHandler = (pp: PpssppClient, p: Record<string, unknown>) => Promise<ToolResult>;

/** Each domain module (core.ts, memory.ts, breakpoints.ts, disasm.ts, ...)
 *  exports one of these; tools/index.ts concatenates `tools` arrays and
 *  merges `handlers` maps into a single dispatch table. */
export interface ToolModule {
  tools: Tool[];
  handlers: Record<string, ToolHandler>;
}

export function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function fmtHex(n: unknown): string {
  if (typeof n !== "number") return String(n);
  return `${n} (0x${n.toString(16).toUpperCase()})`;
}

export function addrHex(n: number): string {
  return `0x${n.toString(16).toUpperCase().padStart(8, "0")}`;
}

export interface RegisterCategory {
  name: string;
  registerNames?: string[];
  uintValues?: number[];
  floatValues?: string[];
}

/** PPSSPP's cpu.getAllRegs returns categories with PARALLEL arrays:
 *  { categories: [{ name, registerNames: [...], uintValues: [...], floatValues: [...] }] }
 *  Not an array of {name, value} objects. */
export function formatRegisters(categories: RegisterCategory[]): string {
  const lines: string[] = [];
  for (const cat of categories) {
    lines.push(`── ${cat.name} ──`);
    const names = cat.registerNames ?? [];
    const vals  = cat.uintValues ?? [];
    for (let i = 0; i < Math.max(names.length, vals.length); i++) {
      const nm = names[i] ?? `r${i}`;
      const v  = vals[i];
      lines.push(`  ${nm.padEnd(8)} = ${v !== undefined ? addrHex(v) : "(unavailable)"}`);
    }
  }
  return lines.join("\n") || "(no registers returned)";
}

export interface BacktraceFrame {
  entry: number;
  pc: number;
  sp: number;
  stackSize?: number;
  code?: string;
}

export function formatBacktrace(frames: BacktraceFrame[]): string {
  if (frames.length === 0) return "(empty call stack)";
  return frames.map((f, i) =>
    `  #${i} pc=${addrHex(f.pc)} entry=${addrHex(f.entry)}${f.code ? ` (${f.code})` : ""} sp=${addrHex(f.sp)}`).join("\n");
}

// Canonical PSP button names PPSSPP's input.buttons.send understands.
export const PSP_BUTTONS = [
  "cross", "circle", "triangle", "square",   // Face buttons
  "up", "down", "left", "right",             // D-pad
  "start", "select",                         // System
  "ltrigger", "rtrigger",                    // Shoulder buttons
  "home",                                    // Home
];

// ──────────────────────────────────────────────────────────────────────────────
// Tool descriptions are written to the TDQS rubric (Glama's Tool Definition
// Quality Score). Each description covers, in order:
//
//   • PURPOSE — one clear action sentence.
//   • USAGE — when to use this vs sibling tools.
//   • BEHAVIOR — side effects, error conditions, destructive notes.
//   • RETURNS — exact shape of the success output.
//
// Each parameter has a `description` that adds context beyond the schema
// (address-space conventions, alignment, button names, examples).
// ──────────────────────────────────────────────────────────────────────────────

export const ADDRESS_PARAM_DESC =
  "PSP physical address. PSP memory layout: user RAM starts at 0x08800000 " +
  "(or 0x08000000 — varies by firmware allocation), kernel RAM at 0x08000000-0x087FFFFF, " +
  "VRAM at 0x04000000-0x041FFFFF, scratchpad at 0x00010000-0x00013FFF, hardware regs " +
  "at 0xBC000000+. Most game state lives in user RAM. Note PPSSPP may also accept " +
  "0x88xxxxxx kernel-mode mirrors of the same physical memory.";

export const REPLACEMENTS_PARAM_DESC =
  "Optional, default true (PPSSPP's own default — matches normal debugger behavior). " +
  "PPSSPP's JIT overwrites the FIRST WORD of every code block it has compiled with an " +
  "internal 'emuhack' marker (opcode 0x1A, MIPS_EMUHACK_OPCODE) so it can find its own " +
  "compiled-code cache — reading memory with the default `true` shows you that patched " +
  "byte, not the real instruction underneath. Pass `false` to read the REAL underlying " +
  "bytes instead (PPSSPP transparently un-patches its JIT cache for the duration of this " +
  "one read, then restores it — no CPU core change, no side effects on execution). " +
  "USAGE: pass `false` whenever you're reading CODE to disassemble/decompile (e.g. " +
  "dumping a region for Ghidra) — code that has already executed will otherwise come back " +
  "corrupted at every JIT block boundary. Leave at the default `true` (or omit) when " +
  "reading plain DATA (struct fields, counters) — the JIT never patches non-code memory, " +
  "so it makes no difference there, and the default avoids the extra unpatch/repatch work.";

export type MemWidth = 8 | 16 | 32;

export const MEM_WIDTH_INFO: Record<MemWidth, {
  readEvent: string;
  writeEvent: string;
  max: number;
  valueLabel: string;
  siblings: string;
}> = {
  8: {
    readEvent: "memory.read_u8", writeEvent: "memory.write_u8", max: 0xFF,
    valueLabel: "an unsigned 8-bit byte",
    siblings: "For 16/32-bit values use ppsspp_read16/read32 (one call instead of multi-byte assembly); for spans use ppsspp_read_range.",
  },
  16: {
    readEvent: "memory.read_u16", writeEvent: "memory.write_u16", max: 0xFFFF,
    valueLabel: "an unsigned 16-bit little-endian value",
    siblings: "For single bytes use ppsspp_read8; for 32-bit use ppsspp_read32; for arbitrary byte spans use ppsspp_read_range.",
  },
  32: {
    readEvent: "memory.read_u32", writeEvent: "memory.write_u32", max: 0xFFFFFFFF,
    valueLabel: "an unsigned 32-bit little-endian value",
    siblings: "For 8/16-bit use ppsspp_read8/read16; for spans use ppsspp_read_range.",
  },
};

export function makeReadTool(width: MemWidth): Tool {
  const info = MEM_WIDTH_INFO[width];
  return {
    name: `ppsspp_read${width}`,
    description:
      `PURPOSE: Read ${info.valueLabel} from PSP memory at the given physical address. ` +
      `USAGE: ${info.siblings} ` +
      `BEHAVIOR: No side effects — pure read. PSP is little-endian (MIPS Allegrex). Returns an error if the address isn't a valid PSP memory address (PPSSPP validates against the PSP's mapped regions). ` +
      "RETURNS: Single line 'ADDR_HEX: VAL_DEC (0xVAL_HEX)'.",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: {
        address: { type: "integer", minimum: 0, description: ADDRESS_PARAM_DESC },
        replacements: { type: "boolean", description: REPLACEMENTS_PARAM_DESC },
      },
      additionalProperties: false,
    },
  };
}

export function makeWriteTool(width: MemWidth): Tool {
  const info = MEM_WIDTH_INFO[width];
  return {
    name: `ppsspp_write${width}`,
    description:
      `PURPOSE: Write ${info.valueLabel.replace("an ", "a ")} to PSP memory at the given physical address. ` +
      `USAGE: ${info.siblings.replace(/read/g, "write")} ` +
      `BEHAVIOR: DESTRUCTIVE: overwrites whatever was at \`address\` with no undo. Direct memory write — no hardware mediation. PSP is little-endian. Returns an error if the address is outside valid memory or value > ${info.max}. ` +
      "RETURNS: Single line 'Wrote VAL → ADDR_HEX'.",
    inputSchema: {
      type: "object",
      required: ["address", "value"],
      properties: {
        address: { type: "integer", minimum: 0, description: ADDRESS_PARAM_DESC },
        value:   { type: "integer", minimum: 0, maximum: info.max, description: `Value (0-${info.max}).` },
      },
      additionalProperties: false,
    },
  };
}
