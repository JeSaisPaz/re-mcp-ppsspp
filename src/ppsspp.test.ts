// Tests for PpssppClient's WebSocket plumbing — ticket correlation, the
// fireAndForget/waitForState pattern, and the reconnect state machine. This
// is the trickiest code in the repo (three CHANGELOG entries are bugfixes
// here) and previously had zero automated coverage. Uses a hand-rolled
// EventEmitter-based mock in place of the real `ws` module — no live
// PPSSPP instance needed.

import { describe, it, expect, vi, beforeEach } from "vitest";

// NOTE: vi.hoisted() runs before any static imports are evaluated (that's
// what lets vi.mock below see it), so this can't rely on an imported
// EventEmitter — it hand-rolls the minimal on/once/off/emit surface
// ppsspp.ts actually uses instead.
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
    url: string;
    protocol: string;

    constructor(url: string, protocol: string) {
      super();
      this.url = url;
      this.protocol = protocol;
      instances.push(this);
    }

    send(data: string): void {
      this.sent.push(data);
    }

    close(): void {
      this.readyState = MockWebSocket.CLOSED;
      this.emit("close", 1000, Buffer.from(""));
    }

    /** Test helper: flip to OPEN and fire the 'open' handler. */
    openNow(): void {
      this.readyState = MockWebSocket.OPEN;
      this.emit("open");
    }

    /** Test helper: deliver a JSON message as PPSSPP would over the wire. */
    receive(obj: Record<string, unknown>): void {
      this.emit("message", Buffer.from(JSON.stringify(obj)));
    }

    lastSent(): Record<string, unknown> {
      return JSON.parse(this.sent[this.sent.length - 1]);
    }
  }

  return { MockWebSocket, instances };
});

vi.mock("ws", () => ({ WebSocket: MockWebSocket }));

const { PpssppClient } = await import("./ppsspp.js");

beforeEach(() => {
  instances.length = 0;
});

async function connectedClient(opts: { timeoutMs?: number } = {}) {
  const pp = new PpssppClient({ port: 12345, ...opts });
  const startPromise = pp.start();
  await Promise.resolve();
  const ws = instances[0];
  ws.openNow();
  await startPromise;
  return { pp, ws };
}

describe("PpssppClient — ticket correlation", () => {
  it("resolves concurrent calls to their own ticketed reply, even answered out of order", async () => {
    const { pp, ws } = await connectedClient();

    const pA = pp.call<{ value: string }>("event.a");
    const pB = pp.call<{ value: string }>("event.b");
    await Promise.resolve();

    const sentA = JSON.parse(ws.sent[0]);
    const sentB = JSON.parse(ws.sent[1]);
    expect(sentA.ticket).not.toEqual(sentB.ticket);

    // Answer B before A — correlation must be by ticket, not send order.
    ws.receive({ event: "event.b", ticket: sentB.ticket, value: "B" });
    ws.receive({ event: "event.a", ticket: sentA.ticket, value: "A" });

    await expect(pA).resolves.toMatchObject({ value: "A" });
    await expect(pB).resolves.toMatchObject({ value: "B" });
  });

  it("rejects the matching call when PPSSPP sends an error response", async () => {
    const { pp, ws } = await connectedClient();

    const p = pp.call("memory.read_u8", { address: 0 });
    await Promise.resolve();
    const sent = ws.lastSent();

    ws.receive({ event: "error", ticket: sent.ticket, message: "bad address" });

    await expect(p).rejects.toThrow(/bad address/);
  });

  it("times out a call that never receives a reply", async () => {
    const { pp } = await connectedClient({ timeoutMs: 20 });

    await expect(pp.call("memory.read_u8", { address: 0 })).rejects.toThrow(/timed out/);
  });

  it("ignores untracked broadcasts (no ticket) without disturbing pending calls", async () => {
    const { pp, ws } = await connectedClient();

    ws.receive({ event: "log", message: "some async log line" });

    const p = pp.call<{ version: string }>("version");
    await Promise.resolve();
    const sent = ws.lastSent();
    ws.receive({ event: "version", ticket: sent.ticket, version: "1.2.3" });

    await expect(p).resolves.toMatchObject({ version: "1.2.3" });
  });
});

describe("PpssppClient — fireAndForget / waitForState", () => {
  it("fireAndForget sends immediately without a ticket and does not wait for a reply", async () => {
    const { pp, ws } = await connectedClient();

    await pp.fireAndForget("cpu.stepping");

    expect(ws.sent.length).toBe(1);
    const sent = ws.lastSent();
    expect(sent.event).toBe("cpu.stepping");
    expect(sent.ticket).toBeUndefined();
  });

  it("waitForState resolves once a polled cpu.status satisfies the predicate", async () => {
    const { pp, ws } = await connectedClient();

    // Auto-answer every cpu.status poll: not stepping, then stepping.
    let pollCount = 0;
    const originalSend = ws.send.bind(ws);
    ws.send = (data: string) => {
      originalSend(data);
      const msg = JSON.parse(data);
      if (msg.event === "cpu.status") {
        const stepping = pollCount > 0;
        pollCount++;
        queueMicrotask(() => ws.receive({ event: "cpu.status", ticket: msg.ticket, stepping }));
      }
    };

    await pp.waitForState((s) => s.stepping === true, { intervalMs: 1, timeoutMs: 1000 });
    expect(pollCount).toBeGreaterThanOrEqual(2);
  });
});

describe("PpssppClient — reconnect (v0.1.3 regression)", () => {
  it("attempts a fresh connection after the socket closes, instead of hanging on a stale readyPromise", async () => {
    const { pp, ws: ws1 } = await connectedClient();
    expect(pp.isConnected()).toBe(true);

    // Simulate PPSSPP closing the connection out from under us.
    ws1.close();
    expect(pp.isConnected()).toBe(false);

    // The bug: start() short-circuited on the old resolved readyPromise here,
    // so ensureConnected() returned immediately and call() threw a null-deref
    // on `this.ws!.send(...)`. The fix clears readyPromise on close, so this
    // call must trigger a brand new WebSocket construction.
    const callPromise = pp.call<{ version: string }>("version");
    await Promise.resolve();
    await Promise.resolve();

    expect(instances.length).toBe(2);
    const ws2 = instances[1];
    ws2.openNow();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const sent = ws2.lastSent();
    ws2.receive({ event: "version", ticket: sent.ticket, version: "reconnected" });

    await expect(callPromise).resolves.toMatchObject({ version: "reconnected" });
  });

  it("rejects in-flight requests when the socket closes mid-request", async () => {
    const { pp, ws } = await connectedClient();

    const p = pp.call("memory.read_u32", { address: 0x08800000 });
    await Promise.resolve();

    ws.close();

    await expect(p).rejects.toThrow(/closed mid-request/i);
  });
});

describe("PpssppClient — event plumbing", () => {
  it("emits 'connected' and 'disconnected' at socket open/close", async () => {
    const pp = new PpssppClient({ port: 12345 });
    const connected = vi.fn();
    const disconnected = vi.fn();
    pp.on("connected", connected);
    pp.on("disconnected", disconnected);

    const startPromise = pp.start();
    await Promise.resolve();
    const ws = instances[0];
    ws.openNow();
    await startPromise;
    expect(connected).toHaveBeenCalledTimes(1);
    expect(disconnected).not.toHaveBeenCalled();

    ws.close();
    expect(disconnected).toHaveBeenCalledTimes(1);
    expect(disconnected.mock.calls[0][0]).toMatchObject({ code: 1000 });
  });

  it("re-emits an untracked broadcast by its PPSSPP event name, plus a catch-all 'broadcast'", async () => {
    const { pp, ws } = await connectedClient();
    const stepping = vi.fn();
    const broadcast = vi.fn();
    pp.on("cpu.stepping", stepping);
    pp.on("broadcast", broadcast);

    ws.receive({ event: "cpu.stepping", pc: 0x08812340 });

    expect(stepping).toHaveBeenCalledTimes(1);
    expect(stepping.mock.calls[0][0]).toMatchObject({ pc: 0x08812340 });
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("waitForBreak resolves on the next cpu.stepping broadcast", async () => {
    const { pp, ws } = await connectedClient();

    const waitPromise = pp.waitForBreak({ timeoutMs: 1000 });
    ws.receive({ event: "cpu.stepping", pc: 0x08812340 });

    await expect(waitPromise).resolves.toMatchObject({ pc: 0x08812340 });
  });

  it("waitForBreak rejects if the socket disconnects first", async () => {
    const { pp, ws } = await connectedClient();

    const waitPromise = pp.waitForBreak({ timeoutMs: 1000 });
    ws.close();

    await expect(waitPromise).rejects.toThrow(/disconnected/i);
  });

  it("waitForBreak times out if the CPU never stops", async () => {
    const { pp } = await connectedClient();

    await expect(pp.waitForBreak({ timeoutMs: 10 })).rejects.toThrow(/timed out/i);
  });
});
