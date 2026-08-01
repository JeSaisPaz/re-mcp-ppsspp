// Cheat-Engine-style memory value scanner: snapshot a range of PSP memory as
// scan candidates, then iteratively narrow by re-reading and filtering
// against the previous snapshot. State is entirely in-process and ephemeral
// (dies with the server) — PPSSPP itself has no scanning API of its own.

import type { PpssppClient } from "./ppsspp.js";

export type ScanType = "u8" | "i8" | "u16" | "i16" | "u32" | "i32" | "float32";
export type ScanPredicate =
  | "exact" | "changed" | "unchanged"
  | "increased" | "decreased" | "increasedBy" | "decreasedBy"
  | "range";

const TYPE_WIDTH: Record<ScanType, number> = {
  u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, float32: 4,
};

// PSP user RAM — where most game state (including physics variables) lives.
const DEFAULT_RANGE = { start: 0x08800000, end: 0x0a000000 };
// Matches ppsspp_read_range's documented "stay reasonable" convention.
const CHUNK_SIZE = 0x10000;
const SNAPSHOT_CONCURRENCY = 8;
const FILTER_CONCURRENCY = 16;
const MAX_SESSIONS = 20;
const SESSION_IDLE_MS = 30 * 60 * 1000;

export interface ScanSession {
  id: string;
  type: ScanType;
  rangeStart: number;
  rangeEnd: number;
  addresses: Uint32Array;
  values: Float64Array;
  count: number;
  generation: number;
  createdAt: number;
  lastFilterAt: number;
}

export interface ScanSeedOptions {
  value?: number;
  min?: number;
  max?: number;
}

export interface ScanFilterOptions {
  predicate: ScanPredicate;
  value?: number;
  min?: number;
  max?: number;
  tolerance?: number;
}

function decodeAt(buf: Buffer, offset: number, type: ScanType): number {
  switch (type) {
    case "u8": return buf.readUInt8(offset);
    case "i8": return buf.readInt8(offset);
    case "u16": return buf.readUInt16LE(offset);
    case "i16": return buf.readInt16LE(offset);
    case "u32": return buf.readUInt32LE(offset);
    case "i32": return buf.readInt32LE(offset);
    case "float32": return buf.readFloatLE(offset);
  }
}

function matchesSeed(v: number, opts: ScanSeedOptions): boolean {
  if (opts.value !== undefined) return v === opts.value;
  if (opts.min !== undefined && v < opts.min) return false;
  if (opts.max !== undefined && v > opts.max) return false;
  return true;
}

function approxEqual(a: number, b: number, isFloat: boolean, tolerance: number): boolean {
  return isFloat ? Math.abs(a - b) <= tolerance : a === b;
}

function matchesPredicate(oldV: number, newV: number, opts: ScanFilterOptions, isFloat: boolean, tolerance: number): boolean {
  switch (opts.predicate) {
    case "exact": return opts.value !== undefined && approxEqual(newV, opts.value, isFloat, tolerance);
    case "changed": return !approxEqual(newV, oldV, isFloat, tolerance);
    case "unchanged": return approxEqual(newV, oldV, isFloat, tolerance);
    case "increased": return newV > oldV;
    case "decreased": return newV < oldV;
    case "increasedBy": return opts.value !== undefined && approxEqual(newV - oldV, opts.value, isFloat, tolerance);
    case "decreasedBy": return opts.value !== undefined && approxEqual(oldV - newV, opts.value, isFloat, tolerance);
    case "range": return (opts.min === undefined || newV >= opts.min) && (opts.max === undefined || newV <= opts.max);
  }
}

/** Runs `fn` over `items` with at most `concurrency` in flight at once —
 *  pipelines PPSSPP round trips instead of serializing hundreds of them. */
async function mapConcurrent<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  return results;
}

export class MemoryScanner {
  private sessions = new Map<string, ScanSession>();
  private nextId = 1;

  private evictIdle(): void {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [id, s] of this.sessions) {
      if (s.lastFilterAt < cutoff) this.sessions.delete(id);
    }
  }

  get(id: string): ScanSession {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`No scan session "${id}" — use ppsspp_scan_list to see active sessions, or ppsspp_scan_new to start one.`);
    return s;
  }

  list(): ScanSession[] {
    return [...this.sessions.values()];
  }

  reset(id: string): void {
    if (!this.sessions.delete(id)) {
      throw new Error(`No scan session "${id}".`);
    }
  }

  async newScan(pp: PpssppClient, opts: { type: ScanType; rangeStart?: number; rangeEnd?: number } & ScanSeedOptions): Promise<ScanSession> {
    this.evictIdle();
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error(`Too many active scan sessions (max ${MAX_SESSIONS}) — discard one with ppsspp_scan_reset first.`);
    }
    const width = TYPE_WIDTH[opts.type];
    const rangeStart = opts.rangeStart ?? DEFAULT_RANGE.start;
    const rangeEnd = opts.rangeEnd ?? DEFAULT_RANGE.end;
    if (rangeEnd <= rangeStart) throw new Error("rangeEnd must be greater than rangeStart.");

    const chunkStarts: number[] = [];
    for (let addr = rangeStart; addr < rangeEnd; addr += CHUNK_SIZE) chunkStarts.push(addr);

    const addresses: number[] = [];
    const values: number[] = [];

    await mapConcurrent(chunkStarts, SNAPSHOT_CONCURRENCY, async (chunkStart) => {
      const size = Math.min(CHUNK_SIZE, rangeEnd - chunkStart);
      const r = await pp.call<{ base64?: string }>("memory.read", { address: chunkStart, size });
      const buf = Buffer.from(r.base64 ?? "", "base64");
      for (let off = 0; off + width <= buf.length; off += width) {
        const v = decodeAt(buf, off, opts.type);
        if (matchesSeed(v, opts)) {
          addresses.push(chunkStart + off);
          values.push(v);
        }
      }
    });

    const id = `s${this.nextId++}`;
    const session: ScanSession = {
      id,
      type: opts.type,
      rangeStart,
      rangeEnd,
      addresses: Uint32Array.from(addresses),
      values: Float64Array.from(values),
      count: addresses.length,
      generation: 0,
      createdAt: Date.now(),
      lastFilterAt: Date.now(),
    };
    this.sessions.set(id, session);
    return session;
  }

  async filter(pp: PpssppClient, id: string, opts: ScanFilterOptions): Promise<ScanSession> {
    const session = this.get(id);
    const width = TYPE_WIDTH[session.type];
    const tolerance = opts.tolerance ?? 1e-4;
    const isFloat = session.type === "float32";

    const indices = Array.from({ length: session.count }, (_, i) => i);
    const newValues = await mapConcurrent(indices, FILTER_CONCURRENCY, async (i) => {
      const address = session.addresses[i];
      const r = await pp.call<{ base64?: string }>("memory.read", { address, size: width });
      const buf = Buffer.from(r.base64 ?? "", "base64");
      return decodeAt(buf, 0, session.type);
    });

    const survivingAddrs: number[] = [];
    const survivingVals: number[] = [];
    for (let i = 0; i < session.count; i++) {
      const oldV = session.values[i];
      const newV = newValues[i];
      if (matchesPredicate(oldV, newV, opts, isFloat, tolerance)) {
        survivingAddrs.push(session.addresses[i]);
        survivingVals.push(newV);
      }
    }

    session.addresses = Uint32Array.from(survivingAddrs);
    session.values = Float64Array.from(survivingVals);
    session.count = survivingAddrs.length;
    session.generation++;
    session.lastFilterAt = Date.now();
    return session;
  }
}
