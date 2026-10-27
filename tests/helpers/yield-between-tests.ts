/**
 * Setup file (vitest.config.ts `setupFiles`): yield to the event loop after
 * every test.
 *
 * Fixture-backed tests resolve every WHOOP request immediately, so a whole test
 * file can run on microtasks alone without the worker ever reaching its I/O
 * phase. Vitest's worker then cannot read the replies to its own progress
 * messages, and when a file runs longer than vitest's 60-second RPC timeout
 * (seen under coverage on slower machines) the run fails with
 * `[vitest-worker]: Timeout calling "onTaskUpdate"` although every test passed.
 *
 * The real `setImmediate` is captured when the file loads, before any test
 * installs fake timers.
 */

import { afterEach } from "vitest";

const realSetImmediate = globalThis.setImmediate;

afterEach(async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    realSetImmediate(resolve);
  });
});
