import { describe, it, expect, vi } from "vitest";
import { MemoryScanner } from "./scanner.js";
import type { PpssppClient } from "./ppsspp.js";

/** A tiny fake "PSP RAM" backing store the fake client reads/writes u32s
 *  from/to, so scans can be driven through realistic memory.read calls. */
function fakePpsspp(initialMemory: Map<number, number>) {
  const memory = new Map(initialMemory);
  const pp = {
    call: vi.fn(async (event: string, params?: Record<string, unknown>) => {
      if (event !== "memory.read") throw new Error(`unexpected event ${event}`);
      const address = params!.address as number;
      const size = params!.size as number;
      const buf = Buffer.alloc(size);
      for (let off = 0; off < size; off += 4) {
        buf.writeUInt32LE(memory.get(address + off) ?? 0, off);
      }
      return { base64: buf.toString("base64") };
    }),
  } as unknown as PpssppClient;
  return { pp, memory };
}

describe("MemoryScanner", () => {
  it("snapshots a range and keeps only addresses matching a value seed", async () => {
    const { pp } = fakePpsspp(new Map([
      [0x08800000, 100],
      [0x08800004, 42],
      [0x08800008, 100],
    ]));
    const scanner = new MemoryScanner();

    const session = await scanner.newScan(pp, {
      type: "u32", rangeStart: 0x08800000, rangeEnd: 0x08800010, value: 100,
    });

    expect(session.count).toBe(2);
    expect(Array.from(session.addresses)).toEqual([0x08800000, 0x08800008]);
  });

  it("narrows candidates across filter passes using 'increased'/'decreased'", async () => {
    const { pp, memory } = fakePpsspp(new Map([
      [0x08800000, 50], // will increase — the target
      [0x08800004, 50], // will decrease
      [0x08800008, 50], // stays the same
    ]));
    const scanner = new MemoryScanner();
    const session = await scanner.newScan(pp, { type: "u32", rangeStart: 0x08800000, rangeEnd: 0x0880000c });
    expect(session.count).toBe(3);

    memory.set(0x08800000, 75);
    memory.set(0x08800004, 25);
    // 0x08800008 unchanged at 50

    const narrowed = await scanner.filter(pp, session.id, { predicate: "increased" });
    expect(narrowed.count).toBe(1);
    expect(narrowed.addresses[0]).toBe(0x08800000);
  });

  it("float32 'unchanged' tolerates tiny drift instead of requiring bit-exact equality", async () => {
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, 10.0, true);
    const bits = view.getUint32(0, true);

    const { pp, memory } = fakePpsspp(new Map([[0x08800000, bits]]));
    const scanner = new MemoryScanner();
    const session = await scanner.newScan(pp, { type: "float32", rangeStart: 0x08800000, rangeEnd: 0x08800004 });
    expect(session.count).toBe(1);

    const driftView = new DataView(new ArrayBuffer(4));
    driftView.setFloat32(0, 10.00001, true); // within default 1e-4 tolerance
    memory.set(0x08800000, driftView.getUint32(0, true));

    const narrowed = await scanner.filter(pp, session.id, { predicate: "unchanged" });
    expect(narrowed.count).toBe(1);
  });

  it("throws a clear error for an unknown session id", () => {
    const scanner = new MemoryScanner();
    expect(() => scanner.get("nope")).toThrow(/No scan session/);
  });

  it("reset discards a session", async () => {
    const { pp } = fakePpsspp(new Map([[0x08800000, 1]]));
    const scanner = new MemoryScanner();
    const session = await scanner.newScan(pp, { type: "u32", rangeStart: 0x08800000, rangeEnd: 0x08800004 });
    scanner.reset(session.id);
    expect(() => scanner.get(session.id)).toThrow();
  });

  it("rejects rangeEnd <= rangeStart", async () => {
    const { pp } = fakePpsspp(new Map());
    const scanner = new MemoryScanner();
    await expect(scanner.newScan(pp, { type: "u32", rangeStart: 0x08800010, rangeEnd: 0x08800000 }))
      .rejects.toThrow(/rangeEnd/);
  });
});
