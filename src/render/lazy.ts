/**
 * Runs a dynamic `import()` for a lazy chunk and gives up after `timeoutMs`.
 * Resolves with `null` when the chunk fails to load (offline and never
 * cached) or takes too long, so a deck always goes on to measure with the
 * content the chunk would have replaced left as plain text (rule 4).
 */
export async function loadWithin<T>(load: () => Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([load(), timeout]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
