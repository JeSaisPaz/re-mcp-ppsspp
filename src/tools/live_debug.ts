// The core "live debugging loop" tool: resume execution and block until the
// CPU next stops (breakpoint, watchpoint, or step), returning PC + a
// disassembly window + full registers + call stack in one bundled response
// instead of four sequential tool calls.

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { PpssppClient } from "../ppsspp.js";
import {
  ok, addrHex, formatRegisters, formatBacktrace,
  type ToolModule, type RegisterCategory, type BacktraceFrame,
} from "./shared.js";
import { formatDisasmLines, type DisasmLine } from "./disasm.js";

interface WatchHit { address: number; size: number; hits?: number; read?: boolean; write?: boolean; change?: boolean; symbol?: string; }

async function fetchWatchpoints(pp: PpssppClient): Promise<WatchHit[]> {
  const r = await pp
    .call<{ breakpoints?: WatchHit[] }>("memory.breakpoint.list")
    .catch(() => ({ breakpoints: [] as WatchHit[] }));
  return r.breakpoints ?? [];
}

/**
 * PPSSPP's execution/memory breakpoint lists don't carry a "this is why the
 * CPU just stopped" field directly, so this reconstructs it: an execution
 * breakpoint whose address equals the current PC is the likely cause;
 * failing that, a watchpoint whose hit count increased since `watchBefore`
 * was snapshotted (taken right before resuming) is the likely cause.
 */
async function describeStopReason(pp: PpssppClient, pc: number | undefined, watchBefore: Map<string, number>): Promise<string> {
  if (pc !== undefined) {
    const bps = await pp
      .call<{ breakpoints?: Array<{ address: number; symbol?: string; condition?: string }> }>("cpu.breakpoint.list")
      .catch(() => ({ breakpoints: [] }));
    const hit = (bps.breakpoints ?? []).find((b) => b.address === pc);
    if (hit) {
      return `execution breakpoint at ${addrHex(pc)}${hit.symbol ? ` (${hit.symbol})` : ""}${hit.condition ? ` if ${hit.condition}` : ""}`;
    }
  }
  const after = await fetchWatchpoints(pp);
  for (const w of after) {
    const key = `${w.address}:${w.size}`;
    const before = watchBefore.get(key) ?? 0;
    if ((w.hits ?? 0) > before) {
      const flags = ["read", "write", "change"].filter((f) => (w as unknown as Record<string, unknown>)[f]).join("+") || "change";
      return `watchpoint at ${addrHex(w.address)} size=${w.size} [${flags}]${w.symbol ? ` (${w.symbol})` : ""}`;
    }
  }
  return "manual pause/step, or unrecognized cause";
}

interface BreakContext {
  pc: number;
  ticks?: number;
  disasmLines: DisasmLine[];
  registers: RegisterCategory[];
  frames: BacktraceFrame[];
}

async function captureBreakContext(pp: PpssppClient, disasmWindow: number): Promise<BreakContext> {
  const status = await pp.call<{ pc?: number; ticks?: number }>("cpu.status");
  const pc = status.pc ?? 0;
  const half = Math.max(1, Math.floor(disasmWindow / 2));
  const [disasmResult, regsResult, backtraceResult] = await Promise.all([
    pp.call<{ lines?: DisasmLine[] }>("memory.disasm", { address: pc - half * 4, count: half * 2, displaySymbols: true }),
    pp.call<{ categories?: RegisterCategory[] }>("cpu.getAllRegs"),
    pp.call<{ frames?: BacktraceFrame[] }>("hle.backtrace").catch(() => ({ frames: [] })),
  ]);
  return {
    pc,
    ticks: status.ticks,
    disasmLines: disasmResult.lines ?? [],
    registers: regsResult.categories ?? [],
    frames: backtraceResult.frames ?? [],
  };
}

function formatBreakContext(ctx: BreakContext): string {
  return [
    `PC: ${addrHex(ctx.pc)}  ticks: ${ctx.ticks ?? "?"}`,
    "",
    "── Disassembly ──",
    ctx.disasmLines.length ? formatDisasmLines(ctx.disasmLines) : "(no disassembly returned)",
    "",
    "── Registers ──",
    formatRegisters(ctx.registers),
    "",
    "── Call stack ──",
    formatBacktrace(ctx.frames),
  ].join("\n");
}

const tools: Tool[] = [
  {
    name: "ppsspp_wait_for_break",
    description:
      "PURPOSE: Resume execution and block until the CPU next stops (an execution breakpoint or memory watchpoint fired, or a step completed), then return PC + a disassembly window around it + full registers + the call stack in ONE response. " +
      "USAGE: The core live-debugging loop — arm a ppsspp_breakpoint_add / ppsspp_watchpoint_add first, then call this instead of ppsspp_resume followed by separate ppsspp_disasm/ppsspp_get_registers/ppsspp_backtrace calls. Pass `resume:false` to 'peek' without disturbing current state — if already stopped it returns immediately with the current context; if running, it waits for the next natural stop without you having explicitly resumed anything. " +
      "BEHAVIOR: Modifies emulator run state when `resume` is true (the default) and the CPU is currently stopped — resumes it, then waits. If the CPU is already running, does not re-resume, just waits. On timeout, leaves the CPU running (does not re-pause) and the error message includes the last-known PC/ticks so you can retry or investigate manually. The reported stop reason is a best-effort reconstruction (matching PC against armed execution breakpoints, or watchpoint hit-count deltas since the call started) since PPSSPP's broadcast doesn't carry an explicit reason field. " +
      "RETURNS: 'Stopped — REASON' followed by disassembly / registers / call stack sections.",
    inputSchema: {
      type: "object",
      properties: {
        resume: { type: "boolean", description: "Default true. Set false to 'peek' — wait for a stop without resuming a currently-paused CPU yourself." },
        timeoutMs: { type: "integer", minimum: 1, description: "Default 30000. How long to wait for a stop before giving up." },
        disasmWindow: { type: "integer", minimum: 2, maximum: 200, description: "Default 16. Total instructions to disassemble, centered on PC." },
      },
      additionalProperties: false,
    },
  },
];

export const liveDebugTools: ToolModule = {
  tools,
  handlers: {
    ppsspp_wait_for_break: async (pp, p) => {
      const resume = p.resume !== false;
      const timeoutMs = (p.timeoutMs as number | undefined) ?? 30000;
      const disasmWindow = (p.disasmWindow as number | undefined) ?? 16;

      const watchBefore = new Map<string, number>();
      for (const w of await fetchWatchpoints(pp)) watchBefore.set(`${w.address}:${w.size}`, w.hits ?? 0);

      const status0 = await pp.call<{ stepping?: boolean }>("cpu.status");
      const alreadyStopped = !!status0.stepping;

      if (!(!resume && alreadyStopped)) {
        // Register the break listener BEFORE sending resume, so a stop that
        // fires between "send resume" and "start listening" can't be missed.
        const breakPromise = pp.waitForBreak({ timeoutMs });
        // breakPromise may settle (e.g. time out) while we're still below,
        // confirming the resume took effect — attach a no-op catch now so
        // Node doesn't flag it as an unhandled rejection in that window;
        // the real handling still happens at the `await breakPromise` below.
        breakPromise.catch(() => {});
        if (resume && alreadyStopped) {
          await pp.fireAndForget("cpu.resume");
          // Never wait longer to confirm the resume than the caller's own
          // overall timeout budget.
          await pp.waitForState((s) => s.stepping === false, { timeoutMs: Math.min(2000, timeoutMs) }).catch(() => {});
        }
        try {
          await breakPromise;
        } catch (err) {
          const status = await pp.call<{ pc?: number; ticks?: number }>("cpu.status").catch(() => ({}) as { pc?: number; ticks?: number });
          throw new Error(
            `${(err as Error).message} — CPU still running (last pc=${status.pc !== undefined ? addrHex(status.pc) : "?"}, ticks=${status.ticks ?? "?"})`,
          );
        }
      }

      const ctx = await captureBreakContext(pp, disasmWindow);
      const reason = await describeStopReason(pp, ctx.pc, watchBefore);
      return ok(`Stopped — ${reason}\n\n${formatBreakContext(ctx)}`);
    },
  },
};
