import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { symbolTools } from "./symbols.js";
import type { PpssppClient } from "../ppsspp.js";

let tmpDir: string;
let originalEnv: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-ppsspp-symtools-test-"));
  originalEnv = process.env.MCP_PPSSPP_SYMBOLS_DIR;
  process.env.MCP_PPSSPP_SYMBOLS_DIR = tmpDir;
});

afterEach(async () => {
  if (originalEnv === undefined) delete process.env.MCP_PPSSPP_SYMBOLS_DIR;
  else process.env.MCP_PPSSPP_SYMBOLS_DIR = originalEnv;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// The symbolTools module holds a single module-scoped SymbolStore (by
// design — mirrors the real server's lifetime), which caches loaded files
// in memory keyed by disc ID. Give each test its own disc ID so that cache
// can't leak entries between tests even though MCP_PPSSPP_SYMBOLS_DIR
// changes per test.
let discCounter = 0;
function uniqueDiscId(): string {
  return `TEST${++discCounter}`;
}

function fakeClientWithGame(discId: string | null) {
  const hleCalls: Array<{ event: string; params: unknown }> = [];
  const pp = {
    call: vi.fn(async (event: string, params?: unknown) => {
      if (event === "game.status") return { game: discId ? { id: discId } : null };
      hleCalls.push({ event, params });
      return {};
    }),
  } as unknown as PpssppClient;
  return { pp, hleCalls };
}

describe("symbol tools", () => {
  it("errors clearly when no game is loaded", async () => {
    const { pp } = fakeClientWithGame(null);
    await expect(symbolTools.handlers.ppsspp_symbol_add(pp, { address: 1, name: "x", type: "function" }))
      .rejects.toThrow(/No game loaded/);
  });

  it("adds a symbol, syncs to the live session by default, and lists it", async () => {
    const { pp, hleCalls } = fakeClientWithGame(uniqueDiscId());

    const added = await symbolTools.handlers.ppsspp_symbol_add(pp, {
      address: 0x08812340, name: "CalcTireGrip", type: "function",
    });
    expect(added.content[0].text).toContain("CalcTireGrip");
    expect(hleCalls.some((c) => c.event === "hle.func.add")).toBe(true);

    const listed = await symbolTools.handlers.ppsspp_symbol_list(pp, {});
    expect(listed.content[0].text).toContain("CalcTireGrip");
  });

  it("skips live-session sync when syncToLive:false", async () => {
    const { pp, hleCalls } = fakeClientWithGame(uniqueDiscId());
    await symbolTools.handlers.ppsspp_symbol_add(pp, {
      address: 0x08812340, name: "Foo", type: "function", syncToLive: false,
    });
    expect(hleCalls.some((c) => c.event === "hle.func.add")).toBe(false);
  });

  it("routes data/struct types to hle.data.add instead of hle.func.add", async () => {
    const { pp, hleCalls } = fakeClientWithGame(uniqueDiscId());
    await symbolTools.handlers.ppsspp_symbol_add(pp, {
      address: 0x08810000, name: "gSpeed", type: "data", size: 4,
    });
    expect(hleCalls[0].event).toBe("hle.data.add");
  });

  it("remove and annotate round-trip", async () => {
    const { pp } = fakeClientWithGame(uniqueDiscId());
    await symbolTools.handlers.ppsspp_symbol_add(pp, { address: 0x1, name: "Foo", type: "function" });

    const annotated = await symbolTools.handlers.ppsspp_symbol_annotate(pp, { address: 0x1, notes: "confirmed via watchpoint" });
    expect(annotated.content[0].text).toContain("confirmed via watchpoint");

    const removed = await symbolTools.handlers.ppsspp_symbol_remove(pp, { address: 0x1 });
    expect(removed.content[0].text).toContain("removed");

    await expect(symbolTools.handlers.ppsspp_symbol_remove(pp, { address: 0x1 })).rejects.toThrow(/No persistent symbol/);
  });

  it("ppsspp_symbol_sync pushes every stored entry into the live session", async () => {
    const { pp, hleCalls } = fakeClientWithGame(uniqueDiscId());
    await symbolTools.handlers.ppsspp_symbol_add(pp, { address: 0x1, name: "A", type: "function", syncToLive: false });
    await symbolTools.handlers.ppsspp_symbol_add(pp, { address: 0x2, name: "B", type: "data", syncToLive: false });
    expect(hleCalls.length).toBe(0);

    const result = await symbolTools.handlers.ppsspp_symbol_sync(pp, {});
    expect(result.content[0].text).toContain("Synced 2/2");
    expect(hleCalls.some((c) => c.event === "hle.func.add")).toBe(true);
    expect(hleCalls.some((c) => c.event === "hle.data.add")).toBe(true);
  });
});
