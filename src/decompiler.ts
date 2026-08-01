// Node-side client for the Ghidra decompilation sidecar
// (scripts/ghidra_sidecar.py) — a long-lived Python child process hosting a
// persistent pyghidra/Ghidra Program, communicating over a newline-delimited
// JSON protocol on a TCP loopback socket (not stdio — Ghidra/JVM logging can
// write to the child's stdout, which would corrupt a stdio-framed protocol).
//
// Fully opt-in: see isGhidraAvailable(). If it returns false, the
// ppsspp_decompile* tools are never registered — the rest of the server
// works with zero Python/Ghidra dependency.

import { spawn, type ChildProcess } from "node:child_process";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCRIPT_PATH = path.join(__dirname, "..", "scripts", "ghidra_sidecar.py");

/**
 * Cheap startup-time probe: is decompilation even worth registering tools
 * for? Checks GHIDRA_INSTALL_DIR is set and `python3 -c "import pyghidra"`
 * succeeds. Deliberately does NOT start the JVM (slow, tens of seconds) —
 * that cost is only paid lazily on the first real ppsspp_decompile call,
 * where a misconfigured GHIDRA_INSTALL_DIR surfaces as a clear tool error
 * instead of a failed server boot.
 */
export async function isGhidraAvailable(pythonBin = process.env.MCP_PPSSPP_PYTHON ?? "python3"): Promise<boolean> {
  if (!process.env.GHIDRA_INSTALL_DIR) return false;
  return new Promise((resolve) => {
    const proc = spawn(pythonBin, ["-c", "import pyghidra"], { stdio: "ignore" });
    proc.on("error", () => resolve(false));
    proc.on("exit", (code) => resolve(code === 0));
  });
}

interface PendingCmd {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

export interface PyghidraSidecarOptions {
  scriptPath?: string;
  pythonBin?: string;
  /** Per-call timeout (ms). Default 120000 — decompilation and JVM startup are both slow. */
  timeoutMs?: number;
}

export class PyghidraSidecar {
  private proc: ChildProcess | null = null;
  private socket: net.Socket | null = null;
  private inflight = new Map<string, PendingCmd>();
  private nextId = 1;
  private startPromise: Promise<void> | null = null;
  private recentLog: string[] = [];
  /** Set by the process "exit" handler so a racing socket "close" event
   *  (both fire when the child dies — order between them isn't guaranteed)
   *  reuses the informative crash reason instead of a generic one. */
  private crashError: Error | null = null;
  private readonly scriptPath: string;
  private readonly pythonBin: string;
  private readonly timeoutMs: number;

  constructor(opts: PyghidraSidecarOptions = {}) {
    this.scriptPath = opts.scriptPath ?? DEFAULT_SCRIPT_PATH;
    this.pythonBin = opts.pythonBin ?? process.env.MCP_PPSSPP_PYTHON ?? "python3";
    this.timeoutMs = opts.timeoutMs ?? 120000;
  }

  isRunning(): boolean {
    return this.proc !== null && this.socket !== null;
  }

  private pushLog(text: string): void {
    this.recentLog.push(...text.split("\n").filter(Boolean));
    if (this.recentLog.length > 200) this.recentLog.splice(0, this.recentLog.length - 200);
  }

  private failAllPending(err: Error): void {
    for (const p of this.inflight.values()) p.reject(err);
    this.inflight.clear();
  }

  /**
   * Spawns the sidecar and connects to its handshake port. Memoized like
   * PpssppClient.start() — concurrent callers share one connect attempt,
   * and a failed attempt resets `startPromise` so the next call retries
   * instead of replaying a stale rejection forever.
   */
  private async ensureStarted(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.crashError = null;
    this.startPromise = new Promise<void>((resolve, reject) => {
      const proc = spawn(this.pythonBin, [this.scriptPath], { stdio: ["ignore", "pipe", "pipe"] });
      this.proc = proc;
      let handshakeDone = false;
      let stdoutBuf = "";

      const failStartup = (err: Error) => {
        this.startPromise = null;
        this.proc = null;
        this.socket = null;
        if (!handshakeDone) reject(err);
      };

      proc.on("error", failStartup);
      proc.on("exit", (code) => {
        const err = new Error(
          `Ghidra sidecar process exited (code=${code}). Recent output:\n${this.recentLog.slice(-20).join("\n")}`,
        );
        this.crashError = err;
        this.startPromise = null;
        this.proc = null;
        this.socket?.destroy();
        this.socket = null;
        this.failAllPending(err);
        if (!handshakeDone) reject(err);
      });

      proc.stderr?.on("data", (chunk: Buffer) => this.pushLog(chunk.toString("utf8")));

      proc.stdout?.on("data", (chunk: Buffer) => {
        if (handshakeDone) {
          // Anything after the handshake line is free-form log noise —
          // never parsed as protocol (the protocol lives on the TCP socket).
          this.pushLog(chunk.toString("utf8"));
          return;
        }
        stdoutBuf += chunk.toString("utf8");
        const nl = stdoutBuf.indexOf("\n");
        if (nl === -1) return;
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        const m = /^READY (\d+)$/.exec(line);
        if (!m) {
          failStartup(new Error(`Ghidra sidecar handshake failed — expected "READY <port>", got: ${JSON.stringify(line)}`));
          return;
        }
        handshakeDone = true;
        const port = Number(m[1]);
        const socket = net.connect(port, "127.0.0.1");
        let buf = "";
        socket.on("connect", () => {
          this.socket = socket;
          resolve();
        });
        socket.on("data", (data: Buffer) => {
          buf += data.toString("utf8");
          let idx: number;
          while ((idx = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, idx);
            buf = buf.slice(idx + 1);
            if (line.trim()) this.onMessage(line);
          }
        });
        socket.on("error", (err) => failStartup(err));
        socket.on("close", () => {
          this.socket = null;
          this.startPromise = null;
          // Brief real delay, not just a tick: when the child process
          // dies, this socket "close" event reliably fires well before
          // Node's process "exit" event (SIGCHLD reaping lags socket
          // teardown) — giving "exit" a moment to run first (and set
          // crashError with the actual reason) means a real crash reports
          // why, instead of a generic "socket closed". If "exit" already
          // cleared `inflight` by the time this runs, the failAllPending
          // below is a harmless no-op.
          setTimeout(() => {
            const err = this.crashError ?? new Error("Ghidra sidecar socket closed");
            this.failAllPending(err);
          }, 200);
        });
      });
    });
    return this.startPromise;
  }

  private onMessage(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const id = msg.id as string | undefined;
    if (!id) return; // async/log message with no id — nothing to correlate yet
    const pending = this.inflight.get(id);
    if (!pending) return;
    this.inflight.delete(id);
    if (msg.ok === false) {
      pending.reject(new Error(String(msg.error ?? "Ghidra sidecar returned an error")));
    } else {
      pending.resolve(msg.result);
    }
  }

  async call<T = unknown>(cmd: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.ensureStarted();
    return new Promise<T>((resolve, reject) => {
      const id = `d${this.nextId++}`;
      const timer = setTimeout(() => {
        this.inflight.delete(id);
        reject(new Error(`Ghidra sidecar call "${cmd}" timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.inflight.set(id, {
        resolve: (r) => { clearTimeout(timer); resolve(r as T); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      if (!this.socket) {
        clearTimeout(timer);
        this.inflight.delete(id);
        reject(new Error("Ghidra sidecar socket not connected"));
        return;
      }
      this.socket.write(`${JSON.stringify({ id, cmd, params })}\n`);
    });
  }

  stop(): void {
    this.proc?.kill();
    this.proc = null;
    this.socket?.destroy();
    this.socket = null;
    this.startPromise = null;
  }
}
