/**
 * Wrap an async callback for an API that expects a plain `void` callback
 * (DOM listeners, Obsidian `onChange`/`onClick`, timers). The promise is
 * dropped exactly as it was when the async function was passed directly; the
 * wrapper only makes that explicit, so the type checker can tell a deliberate
 * fire-and-forget from a forgotten `await`.
 */
export function fireAndForget<A extends unknown[]>(fn: (...args: A) => Promise<unknown>): (...args: A) => void {
  return (...args: A) => {
    void fn(...args);
  };
}
