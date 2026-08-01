// Tests for the Node-side Ghidra sidecar client against a lightweight fake
// Python "sidecar" (a real child process, real TCP socket — just not real
// Ghidra, which this environment has no install of). Exercises the actual
// handshake/framing/ticket-correlation/crash-isolation logic in
// src/decompiler.ts, not just mocked behavior.

import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { PyghidraSidecar, isGhidraAvailable } from "./decompiler.js";

// These tests spawn a real Python process to exercise the sidecar's actual
// handshake/framing logic (not mocked) — skip gracefully wherever a Python
// interpreter genuinely isn't on PATH (e.g. some Windows CI runners),
// rather than failing the whole suite for an environment gap unrelated to
// the code under test.
function findPython(): string | null {
  for (const candidate of [process.env.MCP_PPSSPP_PYTHON, "python3", "python"].filter((c): c is string => !!c)) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      return candidate;
    } catch { /* try next candidate */ }
  }
  return null;
}
const PYTHON = findPython();
const describePython = PYTHON ? describe : describe.skip;
// Faking an arbitrary standalone "interpreter executable" via a shebang
// script only works on POSIX — Windows' CreateProcess doesn't interpret
// shebangs the way spawn() needs here.
const describePosix = process.platform !== "win32" ? describe : describe.skip;

const FAKE_SIDECAR = `
import json, socket, sys

server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
server.bind(("127.0.0.1", 0))
server.listen(1)
print(f"READY {server.getsockname()[1]}", flush=True)

conn, _ = server.accept()
buf = b""
while True:
    chunk = conn.recv(65536)
    if not chunk:
        break
    buf += chunk
    while b"\\n" in buf:
        line, buf = buf.split(b"\\n", 1)
        if not line.strip():
            continue
        msg = json.loads(line)
        cmd = msg["cmd"]
        if cmd == "echo":
            reply = {"id": msg["id"], "ok": True, "result": msg.get("params", {})}
        elif cmd == "boom":
            reply = {"id": msg["id"], "ok": False, "error": "boom happened"}
        elif cmd == "crash":
            sys.exit(1)
        elif cmd == "silent":
            continue  # never reply — simulates a hang, for timeout tests
        else:
            reply = {"id": msg["id"], "ok": False, "error": f"unknown cmd {cmd}"}
        conn.sendall((json.dumps(reply) + "\\n").encode("utf8"))
`;

const BAD_HANDSHAKE_SIDECAR = `
print("this is not a valid handshake line", flush=True)
import time
time.sleep(5)
`;

let scriptPath: string;
let sidecars: PyghidraSidecar[] = [];

async function writeFixture(source: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-ppsspp-sidecar-test-"));
  const file = path.join(dir, "fixture.py");
  await fs.writeFile(file, source, "utf8");
  return file;
}

/** A standalone executable (shebang + chmod), for injecting as `pythonBin`
 *  — ignores its args entirely and just exits with a fixed code, so
 *  isGhidraAvailable() tests don't depend on the real environment's
 *  actual Python/pyghidra install state. */
async function writeFakePythonBin(exitCode: number): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-ppsspp-fakepython-"));
  const file = path.join(dir, "fake-python");
  await fs.writeFile(file, `#!/bin/sh\nexit ${exitCode}\n`, "utf8");
  await fs.chmod(file, 0o755);
  return file;
}

afterEach(() => {
  for (const s of sidecars) s.stop();
  sidecars = [];
});

function makeSidecar(script: string, timeoutMs?: number): PyghidraSidecar {
  const s = new PyghidraSidecar({ scriptPath: script, pythonBin: PYTHON ?? "python3", timeoutMs });
  sidecars.push(s);
  return s;
}

describePython("PyghidraSidecar", () => {
  it("performs the READY handshake and completes a round trip", async () => {
    scriptPath = await writeFixture(FAKE_SIDECAR);
    const sidecar = makeSidecar(scriptPath);
    const result = await sidecar.call<{ hello: string }>("echo", { hello: "world" });
    expect(result).toEqual({ hello: "world" });
  });

  it("rejects with the sidecar's error message on an ok:false response", async () => {
    scriptPath = await writeFixture(FAKE_SIDECAR);
    const sidecar = makeSidecar(scriptPath);
    await expect(sidecar.call("boom")).rejects.toThrow(/boom happened/);
  });

  it("correlates concurrent calls by ticket id", async () => {
    scriptPath = await writeFixture(FAKE_SIDECAR);
    const sidecar = makeSidecar(scriptPath);
    const [a, b] = await Promise.all([
      sidecar.call<{ n: number }>("echo", { n: 1 }),
      sidecar.call<{ n: number }>("echo", { n: 2 }),
    ]);
    expect(a).toEqual({ n: 1 });
    expect(b).toEqual({ n: 2 });
  });

  it("rejects in-flight calls when the sidecar process crashes", async () => {
    scriptPath = await writeFixture(FAKE_SIDECAR);
    const sidecar = makeSidecar(scriptPath);
    await sidecar.call("echo", {}); // establish the connection first
    await expect(sidecar.call("crash")).rejects.toThrow(/exited/);
  });

  it("times out a call that never gets a reply", async () => {
    scriptPath = await writeFixture(FAKE_SIDECAR);
    const sidecar = makeSidecar(scriptPath, 100);
    await expect(sidecar.call("silent")).rejects.toThrow(/timed out/);
  });

  it("surfaces a clear error when the handshake line is malformed", async () => {
    scriptPath = await writeFixture(BAD_HANDSHAKE_SIDECAR);
    const sidecar = makeSidecar(scriptPath);
    await expect(sidecar.call("echo")).rejects.toThrow(/handshake failed/);
  });

  it("surfaces a clear error when the interpreter itself can't be spawned", async () => {
    const sidecar = new PyghidraSidecar({ scriptPath: "/nonexistent.py", pythonBin: "/nonexistent-python-binary" });
    sidecars.push(sidecar);
    await expect(sidecar.call("echo")).rejects.toThrow();
  });
});

describe("isGhidraAvailable", () => {
  it("returns false when GHIDRA_INSTALL_DIR is unset", async () => {
    const original = process.env.GHIDRA_INSTALL_DIR;
    delete process.env.GHIDRA_INSTALL_DIR;
    try {
      expect(await isGhidraAvailable()).toBe(false);
    } finally {
      if (original === undefined) delete process.env.GHIDRA_INSTALL_DIR;
      else process.env.GHIDRA_INSTALL_DIR = original;
    }
  });

  describePosix("with a fake pythonBin executable (POSIX-only — Windows doesn't spawn shebang scripts this way)", () => {
    it("returns false when the python import fails, even if GHIDRA_INSTALL_DIR is set", async () => {
      // Inject a fake "python" that always fails, so this test's outcome
      // doesn't depend on whether pyghidra happens to be pip-installed in
      // whatever environment runs the suite.
      const fakePython = await writeFakePythonBin(1);
      const original = process.env.GHIDRA_INSTALL_DIR;
      process.env.GHIDRA_INSTALL_DIR = "/nonexistent-ghidra-dir";
      try {
        expect(await isGhidraAvailable(fakePython)).toBe(false);
      } finally {
        if (original === undefined) delete process.env.GHIDRA_INSTALL_DIR;
        else process.env.GHIDRA_INSTALL_DIR = original;
      }
    });

    it("returns true when GHIDRA_INSTALL_DIR is set and the python import succeeds", async () => {
      const fakePython = await writeFakePythonBin(0);
      const original = process.env.GHIDRA_INSTALL_DIR;
      process.env.GHIDRA_INSTALL_DIR = "/nonexistent-ghidra-dir";
      try {
        expect(await isGhidraAvailable(fakePython)).toBe(true);
      } finally {
        if (original === undefined) delete process.env.GHIDRA_INSTALL_DIR;
        else process.env.GHIDRA_INSTALL_DIR = original;
      }
    });
  });
});
