import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { SymbolStore } from "./symbols.js";

let tmpDir: string;
let originalEnv: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-ppsspp-symbols-test-"));
  originalEnv = process.env.MCP_PPSSPP_SYMBOLS_DIR;
  process.env.MCP_PPSSPP_SYMBOLS_DIR = tmpDir;
});

afterEach(async () => {
  if (originalEnv === undefined) delete process.env.MCP_PPSSPP_SYMBOLS_DIR;
  else process.env.MCP_PPSSPP_SYMBOLS_DIR = originalEnv;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("SymbolStore", () => {
  it("adds an entry and persists it to disk as JSON", async () => {
    const store = new SymbolStore();
    const entry = await store.add("ULUS12345", { address: 0x08812340, name: "CalcTireGrip", type: "function" });

    expect(entry.name).toBe("CalcTireGrip");
    expect(entry.createdAt).toBe(entry.updatedAt);

    const raw = JSON.parse(await fs.readFile(path.join(tmpDir, "ULUS12345.json"), "utf8"));
    expect(raw.discId).toBe("ULUS12345");
    expect(raw.entries).toHaveLength(1);
    expect(raw.entries[0].address).toBe(0x08812340);
  });

  it("refuses to overwrite an existing entry without force", async () => {
    const store = new SymbolStore();
    await store.add("ULUS12345", { address: 0x08812340, name: "First", type: "function" });
    await expect(store.add("ULUS12345", { address: 0x08812340, name: "Second", type: "function" }))
      .rejects.toThrow(/already named "First"/);

    const forced = await store.add("ULUS12345", { address: 0x08812340, name: "Second", type: "function" }, { force: true });
    expect(forced.name).toBe("Second");
  });

  it("lists entries filtered by type/tag/name/address range", async () => {
    const store = new SymbolStore();
    await store.add("ULUS12345", { address: 0x08810000, name: "gSpeed", type: "data", tags: ["physics"] });
    await store.add("ULUS12345", { address: 0x08820000, name: "CalcGrip", type: "function", tags: ["physics"] });
    await store.add("ULUS12345", { address: 0x08830000, name: "MenuInit", type: "function", tags: ["ui"] });

    expect((await store.list("ULUS12345", { type: "data" })).map((e) => e.name)).toEqual(["gSpeed"]);
    expect((await store.list("ULUS12345", { tag: "physics" })).map((e) => e.name)).toEqual(["gSpeed", "CalcGrip"]);
    expect((await store.list("ULUS12345", { nameContains: "grip" })).map((e) => e.name)).toEqual(["CalcGrip"]);
    expect((await store.list("ULUS12345", { addressMin: 0x08815000 })).map((e) => e.name)).toEqual(["CalcGrip", "MenuInit"]);
  });

  it("removes an entry, returning false for an address with nothing recorded", async () => {
    const store = new SymbolStore();
    await store.add("ULUS12345", { address: 0x08812340, name: "Foo", type: "function" });
    expect(await store.remove("ULUS12345", 0x08812340)).toBe(true);
    expect(await store.remove("ULUS12345", 0x08812340)).toBe(false);
    expect(await store.list("ULUS12345")).toHaveLength(0);
  });

  it("annotate appends timestamped notes by default, and can replace instead", async () => {
    const store = new SymbolStore();
    await store.add("ULUS12345", { address: 0x08812340, name: "Foo", type: "function" });

    const first = await store.annotate("ULUS12345", 0x08812340, "first observation");
    expect(first.notes).toMatch(/first observation/);

    const second = await store.annotate("ULUS12345", 0x08812340, "second observation");
    expect(second.notes).toContain("first observation");
    expect(second.notes).toContain("second observation");

    const replaced = await store.annotate("ULUS12345", 0x08812340, "replaced", false);
    expect(replaced.notes).not.toContain("first observation");
    expect(replaced.notes).toContain("replaced");
  });

  it("annotate on a nonexistent address throws", async () => {
    const store = new SymbolStore();
    await expect(store.annotate("ULUS12345", 0x1, "note")).rejects.toThrow(/No persistent symbol/);
  });

  it("keeps separate games in separate files", async () => {
    const store = new SymbolStore();
    await store.add("ULUS12345", { address: 0x1, name: "A", type: "function" });
    await store.add("ULUS99999", { address: 0x1, name: "B", type: "function" });

    expect((await store.list("ULUS12345"))[0].name).toBe("A");
    expect((await store.list("ULUS99999"))[0].name).toBe("B");
    const files = await fs.readdir(tmpDir);
    expect(files.sort()).toEqual(["ULUS12345.json", "ULUS99999.json"]);
  });
});
