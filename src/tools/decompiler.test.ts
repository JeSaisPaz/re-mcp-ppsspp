// Tests for the Node-side session bookkeeping (import_blob vs add_blob,
// reset-on-game-switch) with a fully mocked sidecar — no Python/Ghidra
// dependency needed, since this logic lives entirely on the Node side.

import { describe, it, expect, vi } from "vitest";
import { createDecompilerTools } from "./decompiler.js";
import type { PyghidraSidecar } from "../decompiler.js";
import type { PpssppClient } from "../ppsspp.js";

function fakeSidecar() {
  const calls: Array<{ cmd: string; params: unknown }> = [];
  const sidecar = {
    call: vi.fn(async (cmd: string, params?: unknown) => {
      calls.push({ cmd, params });
      if (cmd === "decompile") return { pseudoC: "void f() { return; }", functionName: "f" };
      return {};
    }),
  } as unknown as PyghidraSidecar;
  return { sidecar, calls };
}

function fakePpsspp(discId: string | null, memoryBase64 = Buffer.from("code").toString("base64")) {
  return {
    call: vi.fn(async (event: string) => {
      if (event === "game.status") return { game: discId ? { id: discId } : null };
      if (event === "memory.read") return { base64: memoryBase64 };
      throw new Error(`unexpected event ${event}`);
    }),
  } as unknown as PpssppClient;
}

describe("decompiler tools (DecompileSession)", () => {
  it("errors clearly when no game is loaded", async () => {
    const { sidecar } = fakeSidecar();
    const tools = createDecompilerTools(sidecar);
    const pp = fakePpsspp(null);
    await expect(tools.handlers.ppsspp_decompile(pp, { address: 0x08800000 })).rejects.toThrow(/No game loaded/);
  });

  it("always reads memory with replacements:false, even without the caller specifying it", async () => {
    const { sidecar } = fakeSidecar();
    const tools = createDecompilerTools(sidecar);
    const pp = fakePpsspp("ULUS12345");
    await tools.handlers.ppsspp_decompile(pp, { address: 0x08812340 });

    const readCall = (pp.call as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === "memory.read");
    expect(readCall![1]).toMatchObject({ replacements: false });
  });

  it("uses import_blob for the first call, then add_blob for subsequent calls on the same game", async () => {
    const { sidecar, calls } = fakeSidecar();
    const tools = createDecompilerTools(sidecar);
    const pp = fakePpsspp("ULUS12345");

    await tools.handlers.ppsspp_decompile(pp, { address: 0x08812340 });
    await tools.handlers.ppsspp_decompile(pp, { address: 0x08812400 });

    const cmds = calls.map((c) => c.cmd);
    // Leading "reset" is expected even on a session's first call — the
    // session starts with no known discId, so the first game always looks
    // like a "switch" (harmless no-op reset on a sidecar with nothing open).
    expect(cmds).toEqual(["reset", "import_blob", "decompile", "add_blob", "decompile"]);
    expect(calls[3].params).toMatchObject({ mode: "skip" });
  });

  it("ppsspp_decompile_refresh forces add_blob mode:'replace'", async () => {
    const { sidecar, calls } = fakeSidecar();
    const tools = createDecompilerTools(sidecar);
    const pp = fakePpsspp("ULUS12345");

    await tools.handlers.ppsspp_decompile(pp, { address: 0x08812340 }); // import_blob first
    await tools.handlers.ppsspp_decompile_refresh(pp, { address: 0x08812340 });

    const addBlobCall = calls.find((c) => c.cmd === "add_blob");
    expect(addBlobCall!.params).toMatchObject({ mode: "replace" });
  });

  it("resets the sidecar program when the loaded game's disc ID changes", async () => {
    const { sidecar, calls } = fakeSidecar();
    const tools = createDecompilerTools(sidecar);

    await tools.handlers.ppsspp_decompile(fakePpsspp("ULUS11111"), { address: 0x1000 });
    await tools.handlers.ppsspp_decompile(fakePpsspp("ULUS22222"), { address: 0x1000 });

    const cmds = calls.map((c) => c.cmd);
    // Leading "reset" for the first game (see note above), then another
    // reset when the second call's disc ID differs from the first.
    expect(cmds).toEqual(["reset", "import_blob", "decompile", "reset", "import_blob", "decompile"]);
  });

  it("formats pseudo-C, function name, and signature into the returned text", async () => {
    const sidecar = {
      call: vi.fn(async (cmd: string) => {
        if (cmd === "decompile") {
          return { pseudoC: "int CalcGrip(void) {\n  return 1;\n}", functionName: "CalcGrip", signature: "int CalcGrip(void)" };
        }
        return {};
      }),
    } as unknown as PyghidraSidecar;
    const tools = createDecompilerTools(sidecar);
    const result = await tools.handlers.ppsspp_decompile(fakePpsspp("ULUS12345"), { address: 0x08812340 });
    const text = result.content[0].text as string;
    expect(text).toContain("Function: CalcGrip");
    expect(text).toContain("Signature: int CalcGrip(void)");
    expect(text).toContain("CalcGrip(void) {");
  });
});
