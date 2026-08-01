// Persistent, per-game (per PSP disc ID) knowledge base of named
// addresses/structs/notes — separate from PPSSPP's own live-session
// hle.func.*/hle.data.* tables, which don't survive a PPSSPP restart.
// One JSON file per disc ID under ~/.mcp-ppsspp/symbols/ (or
// MCP_PPSSPP_SYMBOLS_DIR), so RE progress accumulates across sessions.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export type SymbolType = "function" | "data" | "struct" | "unknown";
export type SymbolConfidence = "confirmed" | "hypothesis";

export interface SymbolFieldEntry {
  offset: number;
  name: string;
  type?: string;
  notes?: string;
}

export interface SymbolEntry {
  address: number;
  name: string;
  type: SymbolType;
  size?: number;
  fields?: SymbolFieldEntry[];
  notes?: string;
  tags?: string[];
  confidence?: SymbolConfidence;
  createdAt: string;
  updatedAt: string;
}

interface SymbolFile {
  schemaVersion: 1;
  discId: string;
  gameTitle?: string;
  entries: SymbolEntry[];
}

export interface NewSymbolInput {
  address: number;
  name: string;
  type: SymbolType;
  size?: number;
  notes?: string;
  tags?: string[];
  confidence?: SymbolConfidence;
}

export interface SymbolListFilter {
  type?: SymbolType;
  tag?: string;
  nameContains?: string;
  addressMin?: number;
  addressMax?: number;
}

function symbolsDir(): string {
  return process.env.MCP_PPSSPP_SYMBOLS_DIR ?? path.join(os.homedir(), ".mcp-ppsspp", "symbols");
}

function filePathFor(discId: string): string {
  // discId is normally a PSP disc ID like "ULUS12345", but sanitize
  // defensively before using it as a filename.
  const safe = discId.replace(/[^A-Za-z0-9_-]/g, "_") || "unknown";
  return path.join(symbolsDir(), `${safe}.json`);
}

export class SymbolStore {
  private cache = new Map<string, SymbolFile>();
  private writeLock: Promise<void> = Promise.resolve();

  private async load(discId: string): Promise<SymbolFile> {
    const cached = this.cache.get(discId);
    if (cached) return cached;
    let data: SymbolFile;
    try {
      const text = await fs.readFile(filePathFor(discId), "utf8");
      data = JSON.parse(text) as SymbolFile;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      data = { schemaVersion: 1, discId, entries: [] };
    }
    this.cache.set(discId, data);
    return data;
  }

  /** Serializes writes for the whole store behind one promise chain — cheap
   *  and correct for the intended single-process usage; avoids interleaving
   *  a read-modify-write race between two near-simultaneous mutations. */
  private async save(discId: string, data: SymbolFile): Promise<void> {
    this.cache.set(discId, data);
    const doWrite = async () => {
      const dir = symbolsDir();
      await fs.mkdir(dir, { recursive: true });
      const file = filePathFor(discId);
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
      await fs.rename(tmp, file);
    };
    this.writeLock = this.writeLock.then(doWrite, doWrite);
    await this.writeLock;
  }

  async add(discId: string, input: NewSymbolInput, opts: { force?: boolean } = {}): Promise<SymbolEntry> {
    const data = await this.load(discId);
    const existing = data.entries.find((e) => e.address === input.address);
    if (existing && !opts.force) {
      throw new Error(
        `Address 0x${input.address.toString(16).toUpperCase()} is already named "${existing.name}" — pass force:true to overwrite.`,
      );
    }
    const now = new Date().toISOString();
    const entry: SymbolEntry = {
      address: input.address,
      name: input.name,
      type: input.type,
      size: input.size,
      notes: input.notes,
      tags: input.tags,
      confidence: input.confidence,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (existing) {
      Object.assign(existing, entry);
    } else {
      data.entries.push(entry);
    }
    await this.save(discId, data);
    return entry;
  }

  async list(discId: string, filter: SymbolListFilter = {}): Promise<SymbolEntry[]> {
    const data = await this.load(discId);
    return data.entries
      .filter((e) => {
        if (filter.type && e.type !== filter.type) return false;
        if (filter.tag && !(e.tags ?? []).includes(filter.tag)) return false;
        if (filter.nameContains && !e.name.toLowerCase().includes(filter.nameContains.toLowerCase())) return false;
        if (filter.addressMin !== undefined && e.address < filter.addressMin) return false;
        if (filter.addressMax !== undefined && e.address > filter.addressMax) return false;
        return true;
      })
      .sort((a, b) => a.address - b.address);
  }

  async remove(discId: string, address: number): Promise<boolean> {
    const data = await this.load(discId);
    const idx = data.entries.findIndex((e) => e.address === address);
    if (idx === -1) return false;
    data.entries.splice(idx, 1);
    await this.save(discId, data);
    return true;
  }

  async annotate(discId: string, address: number, notes: string, append = true): Promise<SymbolEntry> {
    const data = await this.load(discId);
    const entry = data.entries.find((e) => e.address === address);
    if (!entry) {
      throw new Error(`No persistent symbol at 0x${address.toString(16).toUpperCase()} — add one with ppsspp_symbol_add first.`);
    }
    const stamp = new Date().toISOString();
    entry.notes = append && entry.notes ? `${entry.notes}\n[${stamp}] ${notes}` : `[${stamp}] ${notes}`;
    entry.updatedAt = stamp;
    await this.save(discId, data);
    return entry;
  }
}
