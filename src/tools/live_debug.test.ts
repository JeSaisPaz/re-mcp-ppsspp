// End-to-end tests for ppsspp_wait_for_break against a real PpssppClient
// with a mocked WebSocket — exercises the actual resume/waitForBreak/
// context-capture/stop-reason-heuristic flow, not just the formatting.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { MockWebSocket, instances } = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;

  class MiniEmitter {
    private listeners = new Map<string, Set<Listener>>();
    on(event: string, fn: Listener): this {
      let set = this.listeners.get(event);
      if (!set) { set = new Set(); this.listeners.set(event, set); }
      set.add(fn);
      return this;
    }
    once(event: string, fn: Listener): this {
      const wrapper: Listener = (...args) => { this.off(event, wrapper); fn(...args); };
      return this.on(event, wrapper);
    }
    off(event: string, fn: Listener): this {
      this.listeners.get(event)?.delete(fn);
      return this;
    }
    emit(event: string, ...args: unknown[]): boolean {
      const set = this.listeners.get(event);
      if (!set || set.size === 0) return false;
      for (const fn of [...set]) fn(...args);
      return true;
    }
  }

  const instances: InstanceType<typeof MockWebSocket>[] = [];

  class MockWebSocket extends MiniEmitter {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    readyState = MockWebSocket.CONNECTING;
    sent: string[] = [];

    constructor(_url: string, _protocol: string) {
      super();
      instances.push(this);
    }

    send(data: string): void {
      this.sent.push(data);
    }

    close(): void {
      this.readyState = MockWebSocket.CLOSED;
      this.emit("close", 1000, Buffer.from(""));
    }

    openNow(): void {
      this.readyState = MockWebSocket.OPEN;
      this.emit("open");
    }

    receive(obj: Record<string, unknown>): void {
      this.emit("message", Buffer.from(JSON.stringify(obj)));
    }
  }

  return { MockWebSocket, instances };
});

vi.mock("ws", () => ({ WebSocket: MockWebSocket }));

const { PpssppClient } = await import("../ppsspp.js");
const { liveDebugTools } = await import("./live_debug.js");

beforeEach(() => {
  instances.length = 0;
});

/** Auto-answers every ticketed call() based on its `event`, using a
 *  responses table the test supplies. `cpu.resume`/`cpu.stepping` (fire &
 *  forget, no ticket) are handled specially: `cpu.resume` triggers a
 *  `cpu.stepping` broadcast on the next tick if `autoBreakOnResume` is set. */
function installAutoResponder(
  ws: InstanceType<typeof MockWebSocket>,
  responses: Record<string, unknown>,
  opts: { autoBreakOnResume?: boolean } = {},
) {
  ws.send = (data: string) => {
    const msg = JSON.parse(data);
    if (msg.event === "cpu.resume" && opts.autoBreakOnResume) {
      queueMicrotask(() => ws.receive({ event: "cpu.stepping", pc: (responses["cpu.status"] as { pc?: number })?.pc }));
      return;
    }
    if (!msg.ticket) return; // other fire-and-forget events, ignore
    const resp = responses[msg.event as string];
    if (resp === undefined) throw new Error(`test: no mock response configured for event "${msg.event}"`);
    queueMicrotask(() => ws.receive({ event: msg.event, ticket: msg.ticket, ...(typeof resp === "function" ? (resp as (m: unknown) => object)(msg) : resp) }));
  };
}

async function connectedClient() {
  const pp = new PpssppClient({ port: 12345 });
  const startPromise = pp.start();
  await Promise.resolve();
  const ws = instances[0];
  ws.openNow();
  await startPromise;
  return { pp, ws };
}

const DISASM_RESPONSE = { lines: [{ address: 0x08812340, name: "jal", params: "0x08813000", isCurrentPC: true }] };
const REGS_RESPONSE = { categories: [{ name: "GPR", registerNames: ["pc"], uintValues: [0x08812340] }] };
const BACKTRACE_RESPONSE = { frames: [{ entry: 0x08812000, pc: 0x08812340, sp: 0x09ffff00 }] };

describe("ppsspp_wait_for_break", () => {
  it("resumes a stopped CPU, waits for the next stop, and bundles disasm+registers+backtrace", async () => {
    const { pp, ws } = await connectedClient();
    installAutoResponder(ws, {
      "memory.breakpoint.list": { breakpoints: [] },
      "cpu.status": { stepping: true, pc: 0x08812340, ticks: 1000 },
      "cpu.breakpoint.list": { breakpoints: [{ address: 0x08812340, symbol: "CalcTireGrip" }] },
      "memory.disasm": DISASM_RESPONSE,
      "cpu.getAllRegs": REGS_RESPONSE,
      "hle.backtrace": BACKTRACE_RESPONSE,
    }, { autoBreakOnResume: true });

    const result = await liveDebugTools.handlers.ppsspp_wait_for_break(pp, {});
    const text = result.content[0].text as string;

    expect(text).toContain("execution breakpoint at 0x08812340 (CalcTireGrip)");
    expect(text).toContain("jal");
    expect(text).toContain("GPR");
    expect(text).toContain("pc=0x08812340");
  });

  it("does not resume when the CPU is already running", async () => {
    const { pp, ws } = await connectedClient();
    installAutoResponder(ws, {
      "memory.breakpoint.list": { breakpoints: [] },
      "cpu.status": { stepping: false, pc: 0x08812340, ticks: 1000 },
      "cpu.breakpoint.list": { breakpoints: [] },
      "memory.disasm": DISASM_RESPONSE,
      "cpu.getAllRegs": REGS_RESPONSE,
      "hle.backtrace": BACKTRACE_RESPONSE,
    });

    // Fire the stop as a real macrotask, independent of exact microtask
    // timing inside wait_for_break's internal round trips — this simulates
    // the CPU stopping on its own while wait_for_break is waiting, without
    // us ever having called cpu.resume. A real timer only fires once all
    // pending microtasks (the internal round trips) have drained.
    setTimeout(() => ws.receive({ event: "cpu.stepping", pc: 0x08812340 }), 10);

    const result = await liveDebugTools.handlers.ppsspp_wait_for_break(pp, {});

    const sentEvents = ws.sent.map((s) => JSON.parse(s).event);
    expect(sentEvents).not.toContain("cpu.resume");
    expect((result.content[0].text as string)).toContain("Stopped —");
  });

  it("peek mode (resume:false) returns immediately if already stopped, without resuming", async () => {
    const { pp, ws } = await connectedClient();
    installAutoResponder(ws, {
      "memory.breakpoint.list": { breakpoints: [] },
      "cpu.status": { stepping: true, pc: 0x08812340, ticks: 1000 },
      "cpu.breakpoint.list": { breakpoints: [] },
      "memory.disasm": DISASM_RESPONSE,
      "cpu.getAllRegs": REGS_RESPONSE,
      "hle.backtrace": BACKTRACE_RESPONSE,
    });

    const result = await liveDebugTools.handlers.ppsspp_wait_for_break(pp, { resume: false });

    const sentEvents = ws.sent.map((s) => JSON.parse(s).event);
    expect(sentEvents).not.toContain("cpu.resume");
    expect((result.content[0].text as string)).toContain("Stopped —");
  });

  it("attributes the stop to a watchpoint via hit-count delta when PC doesn't match a breakpoint", async () => {
    const { pp, ws } = await connectedClient();
    let watchHits = 0;
    installAutoResponder(ws, {
      "memory.breakpoint.list": () => ({ breakpoints: [{ address: 0x08900000, size: 4, write: true, hits: watchHits, symbol: "gSpeed" }] }),
      "cpu.status": { stepping: true, pc: 0x08812340, ticks: 1000 },
      "cpu.breakpoint.list": { breakpoints: [] },
      "memory.disasm": DISASM_RESPONSE,
      "cpu.getAllRegs": REGS_RESPONSE,
      "hle.backtrace": BACKTRACE_RESPONSE,
    }, { autoBreakOnResume: true });

    // After the baseline snapshot (hits=0), bump hits before the second
    // (post-stop) memory.breakpoint.list read used by describeStopReason.
    const originalSend = ws.send.bind(ws);
    let breakpointListCalls = 0;
    ws.send = (data: string) => {
      const msg = JSON.parse(data);
      if (msg.event === "memory.breakpoint.list") breakpointListCalls++;
      if (breakpointListCalls === 2) watchHits = 1;
      originalSend(data);
    };

    const result = await liveDebugTools.handlers.ppsspp_wait_for_break(pp, {});
    expect((result.content[0].text as string)).toContain("watchpoint at 0x08900000 size=4 [write] (gSpeed)");
  });

  it("throws a timeout error that includes the last-known PC when the CPU never stops", async () => {
    const { pp, ws } = await connectedClient();
    installAutoResponder(ws, {
      "memory.breakpoint.list": { breakpoints: [] },
      "cpu.status": { stepping: true, pc: 0x08812340, ticks: 1000 },
    }); // no autoBreakOnResume — cpu.resume never triggers a stop

    await expect(liveDebugTools.handlers.ppsspp_wait_for_break(pp, { timeoutMs: 20 }))
      .rejects.toThrow(/timed out.*0x08812340/s);
  });
});
