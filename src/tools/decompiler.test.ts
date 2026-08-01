// Tests for the Node-side session bookkeeping (import_blob vs add_blob,
// reset-on-game-switch) with a fully mocked sidecar — no Python/Ghidra
// dependency needed, since this logic lives entirely on the Node side.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createDecompilerTools } from "./decompiler.js";
import type { PyghidraSidecar } from "../decompiler.js";
import type { PpssppClient } from "../ppsspp.js";
import { SymbolStore } from "../symbols.js";

function fakeSidecar() {
  const calls: Array<{ cmd: string; params: unknown }> = [];
  const sidecar = {
    call: vi.fn(async (cmd: string, params?: unknown) => {
      calls.push({ cmd, params });
      if (cmd === "decompile") return { pseudoC: "void f() { return; }", functionName: "f" };
      if (cmd === "import_blob" || cmd === "add_blob") return { functionCount: 3 };
      if (cmd === "apply_symbols") return { applied: (params as { entries: unknown[] }).entries.length, total: (params as { entries: unknown[] }).entries.length };
      if (cmd === "decompile_all") return { functions: [] };
      return {};
    }),
  } as unknown as PyghidraSidecar;
  return { sidecar, calls };
}

function fakePpsspp(discId: string | null, opts: {
  memoryBase64?: string;
  modules?: Array<{ name: string; address: number; size?: number }>;
  pc?: number;
  funcList?: Array<{ name: string; address: number }>;
  dataList?: Array<{ name: string; address: number }>;
} = {}) {
  const memoryBase64 = opts.memoryBase64 ?? Buffer.from("code").toString("base64");
  return {
    call: vi.fn(async (event: string) => {
      if (event === "game.status") return { game: discId ? { id: discId } : null };
      if (event === "memory.read") return { base64: memoryBase64 };
      if (event === "hle.module.list") return { modules: opts.modules ?? [] };
      if (event === "cpu.status") return { pc: opts.pc };
      if (event === "hle.func.list") return { functions: opts.funcList ?? [] };
      if (event === "hle.data.list") return { data: opts.dataList ?? [] };
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

describe("decompiler tools — whole-module import (Roadmap Phase B/C)", () => {
  let tmpSymbolsDir: string;
  let originalEnv: string | undefined;

  beforeEach(async () => {
    tmpSymbolsDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-ppsspp-decomp-symbols-"));
    originalEnv = process.env.MCP_PPSSPP_SYMBOLS_DIR;
    process.env.MCP_PPSSPP_SYMBOLS_DIR = tmpSymbolsDir;
  });

  afterEach(async () => {
    if (originalEnv === undefined) delete process.env.MCP_PPSSPP_SYMBOLS_DIR;
    else process.env.MCP_PPSSPP_SYMBOLS_DIR = originalEnv;
    await fs.rm(tmpSymbolsDir, { recursive: true, force: true });
  });

  it("imports the full module range by name, not a caller-guessed window", async () => {
    const { sidecar, calls } = fakeSidecar();
    const tools = createDecompilerTools(sidecar);
    const pp = fakePpsspp("ULUS12345", {
      modules: [{ name: "psp_code", address: 0x08804000, size: 0x2000 }],
      memoryBase64: Buffer.alloc(0x2000, 0xab).toString("base64"),
    });

    const result = await tools.handlers.ppsspp_decompile_module(pp, { moduleName: "psp_code" });

    const importCall = calls.find((c) => c.cmd === "import_blob");
    expect(importCall!.params).toMatchObject({ baseAddress: 0x08804000 });
    expect(Buffer.from((importCall!.params as { bytes: string }).bytes, "base64").length).toBe(0x2000);
    const text = result.content[0].text as string;
    expect(text).toContain("0x08804000");
    expect(text).toContain("8192 bytes");
    expect(text).toContain("found 3 function(s)");
  });

  it("infers the module containing the current PC when moduleName is omitted", async () => {
    const { sidecar, calls } = fakeSidecar();
    const tools = createDecompilerTools(sidecar);
    const pp = fakePpsspp("ULUS12345", {
      modules: [
        { name: "sceModA", address: 0x08800000, size: 0x1000 },
        { name: "sceModB", address: 0x08810000, size: 0x1000 },
      ],
      pc: 0x08810123,
      memoryBase64: Buffer.alloc(0x1000).toString("base64"),
    });

    await tools.handlers.ppsspp_decompile_module(pp, {});

    const importCall = calls.find((c) => c.cmd === "import_blob");
    expect(importCall!.params).toMatchObject({ baseAddress: 0x08810000 });
  });

  it("errors clearly when the named module doesn't exist", async () => {
    const { sidecar } = fakeSidecar();
    const tools = createDecompilerTools(sidecar);
    const pp = fakePpsspp("ULUS12345", { modules: [{ name: "other", address: 0x1000, size: 0x100 }] });
    await expect(tools.handlers.ppsspp_decompile_module(pp, { moduleName: "nope" })).rejects.toThrow(/No loaded module named/);
  });

  it("errors clearly when no module contains the current PC and none was named", async () => {
    const { sidecar } = fakeSidecar();
    const tools = createDecompilerTools(sidecar);
    const pp = fakePpsspp("ULUS12345", { modules: [{ name: "other", address: 0x1000, size: 0x100 }], pc: 0x9999 });
    await expect(tools.handlers.ppsspp_decompile_module(pp, {})).rejects.toThrow(/No loaded module contains/);
  });

  it("merges live HLE names and the persistent symbol store, then applies them via apply_symbols", async () => {
    const { sidecar, calls } = fakeSidecar();
    const tools = createDecompilerTools(sidecar);

    // Seed the persistent store for this game before importing the module.
    await new SymbolStore().add("ULUS12345", { address: 0x08804100, name: "CalcTireGrip", type: "function" });

    const pp = fakePpsspp("ULUS12345", {
      modules: [{ name: "psp_code", address: 0x08804000, size: 0x1000 }],
      memoryBase64: Buffer.alloc(0x1000).toString("base64"),
      funcList: [{ name: "sceKernelCreateThread", address: 0x08804050 }],
      dataList: [{ name: "gSpeed", address: 0x08804200 }],
    });

    const result = await tools.handlers.ppsspp_decompile_module(pp, { moduleName: "psp_code" });

    const applyCall = calls.find((c) => c.cmd === "apply_symbols");
    const entries = (applyCall!.params as { entries: Array<{ address: number; name: string; type: string }> }).entries;
    expect(entries).toContainEqual({ address: 0x08804050, name: "sceKernelCreateThread", type: "function" });
    expect(entries).toContainEqual({ address: 0x08804200, name: "gSpeed", type: "data" });
    expect(entries).toContainEqual({ address: 0x08804100, name: "CalcTireGrip", type: "function" });
    expect(result.content[0].text).toContain("applied 3 known symbol");
  });

  it("ppsspp_decompile_module_export writes one .c file per decompiled function", async () => {
    const { sidecar } = fakeSidecar();
    (sidecar.call as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string) => {
      if (cmd === "import_blob") return { functionCount: 2 };
      if (cmd === "apply_symbols") return { applied: 0, total: 0 };
      if (cmd === "decompile_all") {
        return {
          functions: [
            { address: 0x08804000, name: "CalcTireGrip", signature: "void CalcTireGrip(void)", pseudoC: "void CalcTireGrip(void) {}" },
            { address: 0x08804100, name: "", signature: undefined, pseudoC: "void sub_08804100(void) {}" },
          ],
        };
      }
      return {};
    });
    const tools = createDecompilerTools(sidecar);
    const pp = fakePpsspp("ULUS12345", {
      modules: [{ name: "psp_code", address: 0x08804000, size: 0x1000 }],
      memoryBase64: Buffer.alloc(0x1000).toString("base64"),
    });

    const exportDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-ppsspp-decomp-export-"));
    try {
      const result = await tools.handlers.ppsspp_decompile_module_export(pp, { moduleName: "psp_code", outDir: exportDir });
      expect(result.content[0].text).toContain("Exported 2 function(s)");

      const files = await fs.readdir(exportDir);
      expect(files.length).toBe(2);
      expect(files.some((f) => f.includes("CalcTireGrip"))).toBe(true);

      const content = await fs.readFile(path.join(exportDir, files.find((f) => f.includes("CalcTireGrip"))!), "utf8");
      expect(content).toContain("void CalcTireGrip(void) {}");
      expect(content).toContain("// void CalcTireGrip(void)");
    } finally {
      await fs.rm(exportDir, { recursive: true, force: true });
    }
  });

  it("ppsspp_decompile_module_export defaults the output dir to ~/.mcp-ppsspp/decompiled/<discId>/<moduleName>", async () => {
    const { sidecar } = fakeSidecar();
    const tools = createDecompilerTools(sidecar);
    const pp = fakePpsspp("ULUS99999", {
      modules: [{ name: "weird name!", address: 0x1000, size: 0x100 }],
      memoryBase64: Buffer.alloc(0x100).toString("base64"),
    });

    const result = await tools.handlers.ppsspp_decompile_module_export(pp, { moduleName: "weird name!" });
    const text = result.content[0].text as string;
    expect(text).toContain(".mcp-ppsspp");
    expect(text).toContain("decompiled");
    expect(text).toContain("ULUS99999");
    // The module name displays as-is, but the directory path sanitizes
    // unsafe filename characters (space, "!").
    expect(text).toContain('module "weird name!"');
    expect(text).toContain("weird_name_");
    expect(text).not.toContain("decompiled/weird name!");

    // Clean up the real-homedir default path this test intentionally exercises.
    await fs.rm(path.join(os.homedir(), ".mcp-ppsspp", "decompiled", "ULUS99999"), { recursive: true, force: true });
  });
});
