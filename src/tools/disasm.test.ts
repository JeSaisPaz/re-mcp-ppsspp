import { describe, it, expect, vi } from "vitest";
import { disasmTools } from "./disasm.js";
import type { PpssppClient } from "../ppsspp.js";

/** Client that reports the CPU as RUNNING, so withStepping() has to pause
 *  and resume around the wrapped call. */
function runningClient(responses: Record<string, unknown> = {}) {
  const calls: Array<{ event: string; params: unknown }> = [];
  const fired: string[] = [];
  let stepping = false;
  const pp = {
    call: vi.fn(async (event: string, params?: unknown) => {
      calls.push({ event, params });
      if (event === "cpu.status") return { stepping };
      return responses[event] ?? {};
    }),
    fireAndForget: vi.fn(async (event: string) => {
      fired.push(event);
      if (event === "cpu.stepping") stepping = true;
      if (event === "cpu.resume") stepping = false;
    }),
    waitForState: vi.fn(async () => {}),
  } as unknown as PpssppClient;
  return { pp, calls, fired };
}

// PPSSPP's hle.func.add/rename/remove/scan all reject with "CPU currently
// running (cpu.stepping first)" unless the CPU is stopped — unlike
// hle.func.list, which works either way. These tools now pause/resume around
// the call rather than surfacing that error to the caller.
describe.each([
  ["ppsspp_func_add", { address: 0x08800000, name: "f" }, "hle.func.add"],
  ["ppsspp_func_rename", { address: 0x08800000, name: "f" }, "hle.func.rename"],
  ["ppsspp_func_remove", { address: 0x08800000 }, "hle.func.remove"],
  ["ppsspp_func_scan", { address: 0x08800000, size: 256 }, "hle.func.scan"],
])("%s", (tool, params, event) => {
  it("pauses the CPU around the call and resumes afterwards", async () => {
    const { pp, calls, fired } = runningClient();

    await disasmTools.handlers[tool](pp, params);

    expect(fired).toEqual(["cpu.stepping", "cpu.resume"]);
    expect(calls.some((c) => c.event === event)).toBe(true);
  });

  it("leaves an already-paused CPU paused", async () => {
    const { pp, fired } = runningClient();
    // Simulate "already stepping" by pausing first.
    await pp.fireAndForget("cpu.stepping");
    fired.length = 0;

    await disasmTools.handlers[tool](pp, params);

    expect(fired).toEqual([]);
  });
});

describe("ppsspp_data_list", () => {
  it("surfaces a version explanation when PPSSPP rejects hle.data.*", async () => {
    const pp = {
      call: vi.fn(async (event: string) => {
        if (event === "cpu.status") return { stepping: true };
        throw new Error("PPSSPP error: Bad message: unknown event");
      }),
      fireAndForget: vi.fn(async () => {}),
      waitForState: vi.fn(async () => {}),
    } as unknown as PpssppClient;

    await expect(disasmTools.handlers.ppsspp_data_list(pp, {})).rejects.toThrow(/v1\.20\.4/);
  });
});
