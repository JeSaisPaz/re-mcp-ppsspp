// Regression coverage for the tools/ module split itself: every domain
// module's tools get aggregated with no name collisions, and dispatch
// through registerTools() correctly routes a call to its handler.

import { describe, it, expect, vi } from "vitest";
import { registerTools } from "./index.js";
import type { PpssppClient } from "../ppsspp.js";

function fakeServer() {
  const handlers = new Map<unknown, (req: unknown) => unknown>();
  return {
    setRequestHandler: (schema: unknown, handler: (req: unknown) => unknown) => {
      handlers.set(schema, handler);
    },
    handlers,
  };
}

describe("registerTools", () => {
  it("registers every tool exactly once, with no duplicate names across modules", async () => {
    const server = fakeServer();
    const pp = { call: vi.fn() } as unknown as PpssppClient;
    await registerTools(server as never, pp);

    const listHandler = [...server.handlers.values()][0];
    const { tools } = (await listHandler({})) as { tools: Array<{ name: string }> };

    expect(tools.length).toBeGreaterThan(20);
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("dispatches a call to the matching handler with the right params", async () => {
    const server = fakeServer();
    const pp = { call: vi.fn().mockResolvedValue({ name: "PPSSPP", version: "1.19" }) } as unknown as PpssppClient;
    await registerTools(server as never, pp);

    const callHandler = [...server.handlers.values()][1];
    const result = await callHandler({ params: { name: "ppsspp_ping", arguments: {} } }) as { content: Array<{ text: string }> };

    expect(pp.call).toHaveBeenCalledWith("version");
    expect(result.content[0].text).toContain("pong");
  });

  it("throws a clear error for an unknown tool name", async () => {
    const server = fakeServer();
    const pp = {} as PpssppClient;
    await registerTools(server as never, pp);

    const callHandler = [...server.handlers.values()][1];
    await expect(callHandler({ params: { name: "ppsspp_nonexistent", arguments: {} } }))
      .rejects.toThrow(/Unknown tool/);
  });

  it("does not register ppsspp_decompile* when GHIDRA_INSTALL_DIR is unset (the common case)", async () => {
    const original = process.env.GHIDRA_INSTALL_DIR;
    delete process.env.GHIDRA_INSTALL_DIR;
    try {
      const server = fakeServer();
      const pp = { call: vi.fn() } as unknown as PpssppClient;
      await registerTools(server as never, pp);

      const listHandler = [...server.handlers.values()][0];
      const { tools } = (await listHandler({})) as { tools: Array<{ name: string }> };
      expect(tools.some((t) => t.name.startsWith("ppsspp_decompile"))).toBe(false);
    } finally {
      if (original === undefined) delete process.env.GHIDRA_INSTALL_DIR;
      else process.env.GHIDRA_INSTALL_DIR = original;
    }
  });
});
