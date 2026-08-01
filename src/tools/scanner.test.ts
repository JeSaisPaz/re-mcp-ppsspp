import { describe, it, expect, vi } from "vitest";
import { scannerTools } from "./scanner.js";
import type { PpssppClient } from "../ppsspp.js";

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

describe("scanner tools", () => {
  it("ppsspp_scan_new then ppsspp_scan_list shows the session and its candidates", async () => {
    const { pp } = fakePpsspp(new Map([[0x08810000, 7]]));
    const created = await scannerTools.handlers.ppsspp_scan_new(pp, {
      type: "u32", rangeStart: 0x08810000, rangeEnd: 0x08810004,
    });
    const idMatch = /Scan (s\d+) created/.exec(created.content[0].text as string);
    expect(idMatch).not.toBeNull();
    const scanId = idMatch![1];

    const listed = await scannerTools.handlers.ppsspp_scan_list(pp, {});
    expect(listed.content[0].text).toContain(scanId);

    const detail = await scannerTools.handlers.ppsspp_scan_list(pp, { scanId });
    expect(detail.content[0].text).toContain("0x08810000");
    expect(detail.content[0].text).toContain("7");
  });

  it("ppsspp_scan_filter narrows candidates and reports the survivors", async () => {
    const { pp, memory } = fakePpsspp(new Map([
      [0x08820000, 10],
      [0x08820004, 10],
    ]));
    const created = await scannerTools.handlers.ppsspp_scan_new(pp, {
      type: "u32", rangeStart: 0x08820000, rangeEnd: 0x08820008,
    });
    const scanId = /Scan (s\d+) created/.exec(created.content[0].text as string)![1];

    memory.set(0x08820000, 20); // increased
    // 0x08820004 stays at 10

    const filtered = await scannerTools.handlers.ppsspp_scan_filter(pp, { scanId, predicate: "increased" });
    const text = filtered.content[0].text as string;
    expect(text).toContain("1 candidate remaining");
    expect(text).toContain("0x08820000");
  });

  it("ppsspp_scan_reset discards a session so later list calls error", async () => {
    const { pp } = fakePpsspp(new Map([[0x08830000, 1]]));
    const created = await scannerTools.handlers.ppsspp_scan_new(pp, {
      type: "u32", rangeStart: 0x08830000, rangeEnd: 0x08830004,
    });
    const scanId = /Scan (s\d+) created/.exec(created.content[0].text as string)![1];

    await scannerTools.handlers.ppsspp_scan_reset(pp, { scanId });

    await expect(scannerTools.handlers.ppsspp_scan_list(pp, { scanId })).rejects.toThrow(/No scan session/);
  });
});
