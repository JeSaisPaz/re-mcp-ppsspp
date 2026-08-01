import { describe, it, expect } from "vitest";
import { mapConcurrent } from "./concurrency.js";

describe("mapConcurrent", () => {
  it("maps every item and preserves result order regardless of completion order", async () => {
    const items = [50, 10, 30, 5, 20];
    const results = await mapConcurrent(items, 3, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms * 2;
    });
    expect(results).toEqual([100, 20, 60, 10, 40]);
  });

  it("never runs more than `concurrency` callbacks at once", async () => {
    let active = 0;
    let maxActive = 0;
    await mapConcurrent(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it("handles an empty input array", async () => {
    const results = await mapConcurrent([], 4, async (x: number) => x);
    expect(results).toEqual([]);
  });

  it("propagates a rejection from any callback", async () => {
    await expect(
      mapConcurrent([1, 2, 3], 2, async (x) => {
        if (x === 2) throw new Error("boom");
        return x;
      }),
    ).rejects.toThrow("boom");
  });
});
