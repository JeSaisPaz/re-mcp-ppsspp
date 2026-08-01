import { describe, it, expect, vi } from "vitest";
import { textureTools } from "./texture.js";
import type { PpssppClient } from "../ppsspp.js";

function fakeClient(responses: Record<string, unknown>) {
  const calls: Array<{ event: string; params: unknown }> = [];
  const pp = {
    call: vi.fn(async (event: string, params?: unknown) => {
      calls.push({ event, params });
      if (event === "cpu.status") return { stepping: true };
      const resp = responses[event];
      if (resp === undefined) throw new Error(`no mock response for ${event}`);
      return resp;
    }),
    fireAndForget: vi.fn(async () => {}),
    waitForState: vi.fn(async () => {}),
  } as unknown as PpssppClient;
  return { pp, calls };
}

describe("ppsspp_texture_dump", () => {
  it("defaults to visual mode and returns an inline PNG", async () => {
    const { pp, calls } = fakeClient({
      "gpu.buffer.texture": { width: 64, height: 64, uri: "data:image/png;base64,QUJD" },
    });

    const result = await textureTools.handlers.ppsspp_texture_dump(pp, {});

    const texCall = calls.find((c) => c.event === "gpu.buffer.texture");
    expect((texCall?.params as Record<string, unknown>).type).toBe("uri");
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(result.content[1]).toMatchObject({ type: "image", data: "QUJD", mimeType: "image/png" });
  });

  it("raw mode returns format metadata and base64 pixel bytes, not a PNG", async () => {
    const { pp, calls } = fakeClient({
      "gpu.buffer.texture": { width: 32, height: 32, format: "A1B5G5R5_UNORM_PACK16", flipped: false, base64: "QUJD" },
    });

    const result = await textureTools.handlers.ppsspp_texture_dump(pp, { mode: "raw" });

    const texCall = calls.find((c) => c.event === "gpu.buffer.texture");
    expect((texCall?.params as Record<string, unknown>).type).toBe("base64");
    const text = result.content[0].text as string;
    expect(text).toContain("A1B5G5R5_UNORM_PACK16");
    expect(text).toContain("QUJD");
    expect(result.content.length).toBe(1); // no image block in raw mode
  });

  it("throws a clear error when no texture is bound", async () => {
    const { pp } = fakeClient({ "gpu.buffer.texture": {} });
    await expect(textureTools.handlers.ppsspp_texture_dump(pp, {})).rejects.toThrow(/no texture/i);
  });

  it("passes level and alpha through to PPSSPP", async () => {
    const { pp, calls } = fakeClient({
      "gpu.buffer.texture": { width: 8, height: 8, uri: "data:image/png;base64,QUJD" },
    });
    await textureTools.handlers.ppsspp_texture_dump(pp, { level: 2, alpha: true });
    const texCall = calls.find((c) => c.event === "gpu.buffer.texture");
    expect(texCall?.params).toMatchObject({ level: 2, alpha: true });
  });
});

describe("ppsspp_texture_clut_dump", () => {
  it("returns the palette format and raw bytes", async () => {
    const { pp } = fakeClient({
      "gpu.buffer.clut": { width: 16, format: "R8G8B8A8_UNORM", base64: "QUJD" },
    });
    const result = await textureTools.handlers.ppsspp_texture_clut_dump(pp, {});
    const text = result.content[0].text as string;
    expect(text).toContain("16 entries");
    expect(text).toContain("R8G8B8A8_UNORM");
    expect(text).toContain("QUJD");
  });

  it("throws a clear error when the bound texture isn't paletted", async () => {
    const { pp } = fakeClient({ "gpu.buffer.clut": {} });
    await expect(textureTools.handlers.ppsspp_texture_clut_dump(pp, {})).rejects.toThrow(/CLUT/i);
  });
});
