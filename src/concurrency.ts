/** Runs `fn` over `items` with at most `concurrency` in flight at once —
 *  pipelines PPSSPP round trips (over the one WebSocket connection, which
 *  supports concurrent ticketed calls) instead of serializing hundreds of
 *  them. Shared by the memory scanner's bulk snapshots and the decompiler's
 *  whole-module dumps — both need "read many chunks, bounded parallelism." */
export async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
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
