import { afterEach, describe, expect, it, vi } from 'vitest';
import { startInferenceAvailability } from '../src/inference-availability.js';
import { buildApp } from '../src/app.js';

afterEach(() => { vi.useRealTimers(); });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe('background trained readiness observation', () => {
  it('starts unavailable, records validated readiness, and expires stale or future observations', async () => {
    let clock = 1000;
    let resolveReady!: (ready: boolean) => void;
    const ready = new Promise<boolean>(resolve => { resolveReady = resolve; });
    const monitor = startInferenceAvailability(() => ready, () => clock);
    try {
      expect(monitor.available()).toBe(false);
      resolveReady(true); await flush();
      expect(monitor.available()).toBe(true);
      clock = 11_001; expect(monitor.available()).toBe(false);
      clock = 999; expect(monitor.available()).toBe(false);
    } finally { await monitor.close(); }
  });

  it('refreshes periodically and fails closed after an unavailable or failed probe', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const probe = vi.fn<(signal: AbortSignal) => Promise<boolean>>()
      .mockResolvedValueOnce(true).mockRejectedValueOnce(new Error('private detail')).mockResolvedValue(false);
    const monitor = startInferenceAvailability(probe);
    try {
      await flush(); expect(monitor.available()).toBe(true);
      await vi.advanceTimersByTimeAsync(5000);
      expect(monitor.available()).toBe(false); expect(probe).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(5000);
      expect(monitor.available()).toBe(false); expect(probe).toHaveBeenCalledTimes(3);
    } finally { await monitor.close(); }
  });

  it('serves public availability without awaiting or triggering a Python probe and aborts shutdown', async () => {
    const probe = vi.fn(() => new Promise<boolean>(() => {}));
    const monitor = startInferenceAvailability(probe);
    const app = buildApp({ trainedInference: { enabled: true, available: () => monitor.available() } });
    try {
      const responses = await Promise.all(Array.from({ length: 3 }, () => app.inject('/api/v1/inference-modes')));
      for (const response of responses) {
        expect(response.statusCode).toBe(200);
        expect(response.json().trained).toMatchObject({ enabled: true, available: false });
      }
      expect(probe).toHaveBeenCalledTimes(1);
      await monitor.close(); // Even a broken probe ignoring AbortSignal cannot hold shutdown open.
      expect(monitor.available()).toBe(false);
    } finally { await monitor.close(); await app.close(); }
  });
});
