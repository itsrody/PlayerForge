/**
 * Tiny bounded-concurrency worker pool for the parse/import child processes.
 * Deterministic: results keep the input order regardless of completion order.
 */
export async function inParallel(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
