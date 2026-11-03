import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
function app(options: Parameters<typeof buildApp>[0] = {}) {
  const instance = buildApp(options); apps.push(instance); return instance;
}
describe('inference availability is distinct from API liveness', () => {
  it('defaults to mock without contacting any model service', async () => {
    const ready = vi.fn(async () => true);
    const response = await app({ trainedInference: { enabled: false, ready } }).inject('/api/v1/inference-modes');
    expect(response.statusCode).toBe(200);
    expect(response.json().trained).toMatchObject({ enabled: false, available: false });
    expect(ready).not.toHaveBeenCalled();
  });
  it('advertises trained mode only after validated readiness', async () => {
    const instance = app({ trainedInference: { enabled: true, ready: async () => true } });
    expect((await instance.inject('/api/v1/inference-modes')).json()).toEqual({ trained: { enabled: true, available: true } });
  });
  it('reports model outage safely while keeping liveness available', async () => {
    const instance = app({ trainedInference: { enabled: true, ready: async () => { throw new Error('private service detail'); } } });
    const response = await instance.inject('/api/v1/inference-modes');
    expect(response.statusCode).toBe(200);
    expect(response.json().trained).toMatchObject({ enabled: true, available: false });
    expect(response.body).not.toContain('private service detail');
    expect((await instance.inject('/api/v1/health')).statusCode).toBe(200);
    expect((await instance.inject('/api/v1/inference-modes?url=http://attacker')).statusCode).toBe(400);
  });
});
