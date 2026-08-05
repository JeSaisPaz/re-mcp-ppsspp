import { describe, it, expect, vi } from "vitest";
import { callDataEvent, callGpuBufferEvent } from "./shared.js";
import type { PpssppClient } from "../ppsspp.js";

/** Minimal client whose call() always rejects with `message`. */
function failingClient(message: string) {
  return { call: vi.fn(async () => { throw new Error(message); }) } as unknown as PpssppClient;
}

describe("callDataEvent", () => {
  // PPSSPP only added the hle.data.* events on its dev/master branch; every
  // released build through v1.20.4 rejects them with a bare "unknown event",
  // which says nothing about the real cause.
  it("translates PPSSPP's opaque 'unknown event' into a version explanation", async () => {
    const pp = failingClient("PPSSPP error: Bad message: unknown event");

    await expect(callDataEvent(pp, "hle.data.list")).rejects.toThrow(/v1\.20\.4/);
    await expect(callDataEvent(pp, "hle.data.list")).rejects.toThrow(/ppsspp_symbol_add/);
  });

  it("passes unrelated errors through untouched", async () => {
    const pp = failingClient("PPSSPP error: CPU not active");
    await expect(callDataEvent(pp, "hle.data.list")).rejects.toThrow("PPSSPP error: CPU not active");
  });

  it("returns the result when the call succeeds", async () => {
    const pp = { call: vi.fn(async () => ({ data: [] })) } as unknown as PpssppClient;
    await expect(callDataEvent(pp, "hle.data.list")).resolves.toEqual({ data: [] });
  });
});

describe("callGpuBufferEvent", () => {
  it("explains PPSSPP's opaque 'Could not download output'", async () => {
    const pp = failingClient("PPSSPP error: Could not download output");

    const p = callGpuBufferEvent(pp, "gpu.buffer.renderColor");
    await expect(p).rejects.toThrow(/gpu\.buffer\.renderColor/);
    await expect(callGpuBufferEvent(pp, "gpu.buffer.renderColor")).rejects.toThrow(/GPU backend/);
  });

  it("passes unrelated errors through untouched", async () => {
    const pp = failingClient("PPSSPP error: Neither CPU or GPU is stepping");
    await expect(callGpuBufferEvent(pp, "gpu.buffer.texture"))
      .rejects.toThrow("PPSSPP error: Neither CPU or GPU is stepping");
  });

  it("returns the result when the call succeeds", async () => {
    const pp = { call: vi.fn(async () => ({ base64: "QUJD" })) } as unknown as PpssppClient;
    await expect(callGpuBufferEvent(pp, "gpu.buffer.texture")).resolves.toEqual({ base64: "QUJD" });
  });
});
