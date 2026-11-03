import { rename, writeFile, unlink } from 'node:fs/promises';

export interface ConsumerState {
  mongodb: boolean;
  redis: boolean;
  running: boolean;
  oldestActiveAt: number | null;
  lastCompletedAt: number | null;
  trainedModelAvailable?: boolean;
}

export function consumerHealthy(state: ConsumerState, now: number, maximumActiveMs: number) {
  return state.mongodb && state.redis && state.running
    && (state.oldestActiveAt === null || now - state.oldestActiveAt <= maximumActiveMs);
}

// A local, expiring observation of connectivity, event-loop responsiveness and
// bounded active work. No HTTP listener, public controls, or image-volume writes.
export function startHealthFile(path: string, observe: () => Promise<ConsumerState>, maximumActiveMs: number) {
  let pending: Promise<void> | undefined;
  const sample = () => {
    if (pending) return pending;
    pending = (async () => {
      const state = await observe();
      const observedAt = Date.now();
      await writeFile(`${path}.tmp`, JSON.stringify({ ...state, observedAt,
        healthy: consumerHealthy(state, observedAt, maximumActiveMs) }), { mode: 0o600 });
      await rename(`${path}.tmp`, path);
    })().finally(() => { pending = undefined; });
    return pending;
  };
  const run = () => { void sample().catch(() => {}); }; // An expired/missing file fails the external probe.
  run();
  const timer = setInterval(run, 5000); timer.unref();
  return { sample, async close() {
    clearInterval(timer);
    await pending?.catch(() => {});
    for (const file of [path, `${path}.tmp`]) await unlink(file).catch(() => {});
  } };
}
