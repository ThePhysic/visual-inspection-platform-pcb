/** Readiness is operational background work, never a public request dependency. */
export function startInferenceAvailability(probe: (signal: AbortSignal) => Promise<boolean>,
  now: () => number = Date.now) {
  const lifetime = new AbortController();
  let observed: { available: boolean; at: number } | undefined;
  let pending: Promise<void> | undefined;
  let closed = false;

  function sample() {
    if (closed) return Promise.resolve();
    pending ??= (async () => {
      try {
        // The strict HTTP probe is bounded too; this race also bounds an
        // unexpected probe implementation which fails to honor cancellation.
        const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(2000)]);
        let abort: (() => void) | undefined;
        const cancelled = new Promise<boolean>(resolve => {
          abort = () => { resolve(false); };
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        });
        let available: boolean;
        try { available = await Promise.race([probe(signal), cancelled]); }
        finally { if (abort) signal.removeEventListener('abort', abort); }
        if (!closed) observed = { available, at: now() };
      } catch { if (!closed) observed = { available: false, at: now() }; }
    })().finally(() => { pending = undefined; });
    return pending;
  }
  const interval = setInterval(() => { void sample(); }, 5000);
  interval.unref();
  void sample();
  return {
    available() {
      const age = observed ? now() - observed.at : Infinity;
      return !closed && observed?.available === true && age >= 0 && age <= 10_000;
    },
    async close() {
      closed = true;
      clearInterval(interval);
      lifetime.abort();
      await pending;
    },
  };
}
