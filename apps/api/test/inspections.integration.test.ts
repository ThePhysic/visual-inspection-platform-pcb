import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fork } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createServer, connect, type Socket, type AddressInfo } from 'node:net';
import { Worker, type ConnectionOptions } from 'bullmq';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Value } from 'typebox/value';
import {
  InspectionResponseSchema, isInferenceResult, MOCK_CONFIGURATION, PCB_CONFIGURATION,
  type InspectionAccepted, type InspectionJob, type AssetResponse,
} from '@vip/contracts';
import {
  connectDatabase, createAssetModel, createInspectionModel, LocalImageStorage,
  InspectionQueue, InspectionReconciler, MockInferenceProvider, MOCK_FIXTURES,
  startInspectionWorker, createInspectionProcessor, InferenceError, EXECUTION_POLICY, jobId, redisConnection,
  type InferenceProvider, type PipelineLogger, type InspectionRecord, OperationalMetrics, sampleQueue,
} from '@vip/backend';
import { buildApp } from '../src/app.js';

const logger: PipelineLogger = { info: () => {}, warn: () => {}, error: () => {} };
const policy = { ...EXECUTION_POLICY, backoffMs: 20, attemptTimeoutMs: 2000, reconcileIntervalMs: 50, batchSize: 10 };

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('asynchronous inspections with real MongoDB and Redis', () => {
  const databaseName = `vip_inspection_test_${randomUUID().replaceAll('-', '')}`;
  const redisUrl = process.env.REDIS_TEST_URL ?? 'redis://127.0.0.1:6379';
  let connection: Awaited<ReturnType<typeof connectDatabase>>;
  let assets: ReturnType<typeof createAssetModel>;
  let inspections: ReturnType<typeof createInspectionModel>;
  let app: ReturnType<typeof buildApp>;
  let storage: LocalImageStorage;
  let directory: string;
  let queue: InspectionQueue;
  let reconciler: InspectionReconciler;
  let asset: AssetResponse;
  let consumers: Array<() => Promise<void>>;
  let panel: Buffer;
  let metrics: OperationalMetrics;

  beforeAll(async () => {
    connection = await connectDatabase(process.env.MONGODB_TEST_URI ?? 'mongodb://127.0.0.1:27017', databaseName);
    assets = createAssetModel(connection); inspections = createInspectionModel(connection);
    await Promise.all([assets.createIndexes(), inspections.createIndexes()]);
    panel = await readFile(new URL('../../../fixtures/inspections/panel.png', import.meta.url));
  });

  async function upload(bytes: Buffer, mimeType: 'image/png' | 'image/jpeg' = 'image/png') {
    const boundary = 'inspection-fixture';
    const response = await app.inject({ method: 'POST', url: '/api/v1/assets',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="fixture.${mimeType === 'image/png' ? 'png' : 'jpg'}"\r\nContent-Type: ${mimeType}\r\n\r\n`),
        bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<AssetResponse>();
  }

  beforeEach(async () => {
    metrics = new OperationalMetrics();
    await Promise.all([assets.deleteMany({}), inspections.deleteMany({})]);
    consumers = [];
    directory = await mkdtemp(join(tmpdir(), 'vip-pipeline-test-'));
    storage = new LocalImageStorage(directory); await storage.initialize();
    queue = new InspectionQueue(redisUrl, logger, `inspections-test-${randomUUID()}`, policy);
    await queue.queue.waitUntilReady();
    reconciler = new InspectionReconciler(inspections, queue, logger, policy, metrics);
    app = buildApp({ assets: { model: assets, storage }, inspections: { assets, inspections }, dispatchQueue: queue });
    asset = await upload(panel);
    expect(asset.sha256).toBe(MOCK_FIXTURES.panel);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const close of consumers ?? []) await close();
    if (reconciler) await reconciler.close();
    if (queue) {
      if (queue.redis.status === 'end') await queue.redis.connect();
      if (!queue.queue.name.startsWith('inspections-test-')) throw new Error('Unsafe queue cleanup');
      await queue.queue.obliterate({ force: true });
      await queue.close();
    }
    if (app) await app.close();
    if (directory) {
      if (!resolve(directory).startsWith(`${resolve(tmpdir())}${sep}vip-pipeline-test-`)) throw new Error('Unsafe storage cleanup');
      await rm(directory, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    if (connection) {
      if (connection.name !== databaseName || !databaseName.startsWith('vip_inspection_test_')) throw new Error('Unsafe database cleanup');
      await connection.dropDatabase(); await connection.close();
    }
  });

  function submit(key = 'request-1', assetId = asset.id, provider?: typeof MOCK_CONFIGURATION) {
    return app.inject({ method: 'POST', url: '/api/v1/inspections', headers: { 'idempotency-key': key },
      payload: { assetId, ...(provider ? { provider } : {}) } });
  }
  async function accepted(key?: string, assetId?: string) {
    const response = await submit(key, assetId);
    expect(response.statusCode, response.body).toBe(202);
    const result = response.json<InspectionAccepted>();
    expect(response.headers.location).toBe(result.url);
    return result;
  }
  function dependencies(provider: InferenceProvider = new MockInferenceProvider()) {
    return { inspections, assets, storage, provider, logger, policy, metrics };
  }
  async function consumer(provider?: InferenceProvider) {
    const instance = startInspectionWorker(redisUrl, dependencies(provider), queue.queue.name);
    consumers.push(instance.close);
    await instance.worker.waitUntilReady();
    return instance;
  }
  function waitForState(worker: Worker<InspectionJob>, id: string, status: string): Promise<InspectionRecord> {
    return new Promise((done, reject) => {
      const cleanup = () => { clearTimeout(timer); worker.off('completed', check); worker.off('failed', check); };
      const inspect = async () => {
        const record = await inspections.findById(id).lean().orFail();
        if (record.status === status) { cleanup(); done(record); }
      };
      const check = () => { void inspect().catch(error => { cleanup(); reject(error); }); };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Inspection did not reach ${status}`)); }, 10_000);
      worker.on('completed', check); worker.on('failed', check); check();
    });
  }
  function payload(id: string, generation = 0): InspectionJob { return { payloadVersion: 'v1', inspectionId: id, generation }; }

  async function enablePromptDispatch() {
    await app.close();
    app = buildApp({ assets: { model: assets, storage }, inspections: { assets, inspections }, dispatchQueue: queue,
      notifyAccepted: id => { reconciler.notify(id); } });
    // Deliberately do NOT start the periodic timer. Completion must be caused
    // by the post-response hint, independently of any scan interval.
  }

  it('promptly completes concurrent idempotent acceptance without a periodic scan or duplicate commit', async () => {
    await enablePromptDispatch();
    const instance = await consumer();
    const responses = await Promise.all(Array.from({ length: 8 }, () => submit('prompt-duplicate')));
    expect(responses.every(response => response.statusCode === 202)).toBe(true);
    const id = responses[0]!.json<InspectionAccepted>().id;
    expect(new Set(responses.map(response => response.json().id)).size).toBe(1);
    const record = await waitForState(instance.worker, id, 'completed');
    expect(record.attemptCount).toBe(1);
    expect(await inspections.countDocuments()).toBe(1);
    await accepted('prompt-duplicate');
    reconciler.notify(id);
    await reconciler.reconcile(); // Terminal replay is a no-op, even after a fresh scan.
    expect(await inspections.findById(id).lean().orFail()).toEqual(record);
    expect(await metrics.registry.metrics()).toContain('vip_inspection_terminals_total{status="completed"} 1');
    expect(await queue.queue.getJobCounts('completed')).toEqual({ completed: 1 });
  });

  it('does not notify dispatch when MongoDB acceptance fails', async () => {
    await enablePromptDispatch();
    const notify = vi.spyOn(reconciler, 'notify');
    vi.spyOn(inspections, 'create').mockRejectedValueOnce(new Error('private database detail'));
    const response = await submit();
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('private database detail');
    expect(notify).not.toHaveBeenCalled();
    expect(await inspections.countDocuments()).toBe(0);
  });

  it('sends durable 202 before a blocked prompt attempt, then recovers a lost Redis connection through reconciliation', async () => {
    await enablePromptDispatch();
    const entered = barrier();
    const release = barrier();
    const original = queue.dispatch.bind(queue);
    const dispatch = vi.spyOn(queue, 'dispatch').mockImplementationOnce(async (...args) => {
      entered.resolve(); await release.promise; return original(...args);
    });
    try {
      const submission = await accepted(); // Must resolve while the scheduling barrier is still closed.
      expect(await inspections.findById(submission.id).lean().orFail()).toMatchObject({ status: 'queued', attemptCount: 0 });
      await entered.promise;
      queue.redis.disconnect(); release.resolve();
      await reconciler.reconcile();
      expect(await metrics.registry.metrics()).toContain('vip_dispatch_total{outcome="error",source="prompt"} 1');
      expect((await inspections.findById(submission.id).lean().orFail()).status).toBe('queued');
      await queue.redis.connect();
      const instance = await consumer();
      const completed = waitForState(instance.worker, submission.id, 'completed');
      await reconciler.reconcile();
      expect((await completed).attemptCount).toBe(1);
      expect(dispatch).toHaveBeenCalled();
    } finally { release.resolve(); }
  });

  it('preserves 202 with Redis already unavailable and repairs it after the dependency returns', async () => {
    await enablePromptDispatch();
    queue.redis.disconnect();
    const submission = await accepted();
    await reconciler.reconcile();
    expect((await inspections.findById(submission.id).lean().orFail()).status).toBe('queued');
    await queue.redis.connect();
    const instance = await consumer();
    const completed = waitForState(instance.worker, submission.id, 'completed');
    await reconciler.reconcile();
    expect((await completed).attemptCount).toBe(1);
  });

  it('bounds a real Redis command stalled during prompt dispatch, then reconciles after replies resume', async () => {
    const sockets = new Set<Socket>();
    const ping = barrier();
    let blackhole = false;
    const target = new URL(redisUrl);
    const proxy = createServer(socket => {
      const upstream = connect(Number(target.port || 6379), target.hostname);
      for (const stream of [socket, upstream]) {
        sockets.add(stream); stream.on('error', () => {});
      }
      socket.on('close', () => { upstream.destroy(); });
      upstream.on('close', () => { socket.destroy(); });
      socket.on('data', bytes => {
        if (blackhole && bytes.toString().toLowerCase().includes('ping')) ping.resolve();
        upstream.write(bytes);
      });
      upstream.on('data', bytes => { if (!blackhole) socket.write(bytes); });
    });
    await new Promise<void>(done => { proxy.listen(0, '127.0.0.1', done); });
    const local = new URL(redisUrl); local.hostname = '127.0.0.1'; local.port = String((proxy.address() as AddressInfo).port);
    const producer = new InspectionQueue(local.toString(), logger, `inspections-test-${randomUUID()}`, policy);
    const prompt = new InspectionReconciler(inspections, producer, logger, policy, metrics);
    let instance: Awaited<ReturnType<typeof consumer>> | undefined;
    try {
      await producer.queue.waitUntilReady();
      const timeout = barrier();
      const healthPing = vi.spyOn(producer.redis, 'ping');
      const dispatch = producer.dispatch.bind(producer);
      const observed: unknown[] = [];
      vi.spyOn(producer, 'dispatch').mockImplementation(async (...args) => {
        try { return await dispatch(...args); }
        catch (error) { observed.push(error); timeout.resolve(); throw error; }
      });
      await app.close();
      app = buildApp({ assets: { model: assets, storage }, inspections: { assets, inspections },
        notifyAccepted: id => { prompt.notify(id); } });
      blackhole = true;
      const submission = await accepted();
      await ping.promise; await timeout.promise; // Actual ioredis command deadline, no assumed delay.
      // healthy() deliberately maps the low-level timeout to unavailable.
      await expect(healthPing.mock.results[0]?.value).rejects.toThrow('Command timed out');
      expect(String(observed[0])).toContain('REDIS_UNAVAILABLE');
      expect((await inspections.findById(submission.id).lean().orFail()).status).toBe('queued');
      blackhole = false;
      // A discarded RESP reply leaves the stream out of sync. Restore the
      // transport, not just forwarding, as with a real broken TCP connection.
      const reconnected = once(producer.redis, 'ready', { signal: AbortSignal.timeout(5000) });
      for (const socket of sockets) socket.destroy();
      await reconnected;
      instance = startInspectionWorker(redisUrl, dependencies(), producer.queue.name);
      await instance.worker.waitUntilReady();
      const completed = waitForState(instance.worker, submission.id, 'completed');
      await prompt.reconcile();
      expect((await completed).attemptCount).toBe(1);
    } finally {
      blackhole = false;
      try {
        await instance?.close(); await prompt.close();
        await producer.queue.obliterate({ force: true });
      } finally {
        try { await producer.close(); }
        finally {
          for (const socket of sockets) socket.destroy();
          await new Promise<void>((done, reject) => { proxy.close(error => error ? reject(error) : done()); });
        }
      }
    }
  });

  it('promptly schedules a manual retry while preserving the failed predecessor', async () => {
    const previous = await accepted();
    await inspections.updateOne({ _id: previous.id }, { $set: { status: 'failed', completedAt: new Date(),
      failure: { code: 'INFERENCE_FAILED', message: 'Simulated inference failed.' } } });
    const original = await inspections.findById(previous.id).lean().orFail();
    await enablePromptDispatch();
    const instance = await consumer();
    const responses = await Promise.all(Array.from({ length: 4 }, () => app.inject({ method: 'POST',
      url: `${previous.url}/retry`, headers: { 'idempotency-key': 'prompt-retry' } })));
    expect(responses.map(response => response.statusCode)).toEqual([202, 202, 202, 202]);
    expect(new Set(responses.map(response => response.json().id)).size).toBe(1);
    const record = await waitForState(instance.worker, responses[0]!.json().id, 'completed');
    expect(record.retriedFrom?.toString()).toBe(previous.id);
    expect(record.attemptCount).toBe(1);
    expect(await inspections.findById(previous.id).lean().orFail()).toEqual(original);
  });

  it('arbitrates prompt dispatch and an independent concurrent recovery scan using generation job IDs and worker claims', async () => {
    await enablePromptDispatch();
    const entered = barrier();
    const release = barrier();
    const original = queue.dispatch.bind(queue);
    vi.spyOn(queue, 'dispatch').mockImplementationOnce(async (...args) => {
      entered.resolve(); await release.promise; return original(...args);
    });
    const other = new InspectionReconciler(inspections, queue, logger, policy);
    try {
      const submission = await accepted(); await entered.promise;
      reconciler.notify(submission.id); reconciler.notify(submission.id);
      // This independent pass schedules the same generation before the blocked hint.
      await other.reconcile();
      release.resolve(); await reconciler.reconcile();
      expect(await queue.queue.getJobCounts('waiting')).toEqual({ waiting: 1, paused: 0 });
      const instance = await consumer();
      const record = await waitForState(instance.worker, submission.id, 'completed');
      await createInspectionProcessor(dependencies())({ id: 'redelivery', data: payload(submission.id) });
      expect(record.attemptCount).toBe(1);
      expect(await inspections.findById(submission.id).lean().orFail()).toEqual(record);
    } finally { release.resolve(); await other.close(); }
  });

  it('durably accepts, executes, and retrieves a simulated result with safe metadata', async () => {
    const submission = await accepted();
    expect(submission.status).toBe('queued');
    const instance = await consumer();
    const completed = waitForState(instance.worker, submission.id, 'completed');
    await reconciler.reconcile();
    const record = await completed;
    expect(record.attemptCount).toBe(1);
    expect(record.requested).toMatchObject(MOCK_CONFIGURATION);
    expect(isInferenceResult(record.result)).toBe(true);
    expect(record.result).toMatchObject({ ...MOCK_CONFIGURATION, contractVersion: 'v1', taxonomyVersion: 'mock-v1', simulated: true });
    const response = await app.inject({ method: 'GET', url: submission.url });
    expect(response.statusCode).toBe(200);
    expect(Value.Check(InspectionResponseSchema, response.json())).toBe(true);
    expect(response.json().result.detections).toHaveLength(1);
    expect(response.body).not.toMatch(/requestKey|requestFingerprint|attemptId|leaseExpiresAt|storageKey|stack/);
    const job = await queue.queue.getJob(jobId(payload(submission.id)));
    expect(job?.data).toEqual(payload(submission.id));
    await createInspectionProcessor(dependencies())({ id: jobId(payload(submission.id)), data: payload(submission.id) });
    const observations = await metrics.registry.metrics();
    expect(observations).toContain('vip_inspection_attempts_started_total 1');
    expect(observations).toContain('vip_inspection_terminals_total{status="completed"} 1');
    expect(observations).toContain('vip_inspection_deliveries_ignored_total{reason="unclaimed"} 1');
  });

  it('completes a valid zero-detection curated image', async () => {
    const empty = await upload(await readFile(new URL('../../../fixtures/inspections/empty.png', import.meta.url)));
    expect(empty.sha256).toBe(MOCK_FIXTURES.empty);
    const submission = await accepted('empty', empty.id);
    const instance = await consumer();
    const completed = waitForState(instance.worker, submission.id, 'completed');
    await reconciler.reconcile();
    expect((await completed).result.detections).toEqual([]);
  });

  it.each([
    ['machined-panel', 'machinedPanel', 1200, 800, 3],
    ['clean-panel', 'cleanPanel', 1200, 800, 0],
    ['edge-component', 'edgeComponent', 800, 1100, 1],
  ] as const)('preserves canonical portfolio fixture %s through ingestion and real queue execution', async (name, key, width, height, count) => {
    const uploaded = await upload(await readFile(new URL(`../../../fixtures/inspections/${name}.png`, import.meta.url)));
    expect(uploaded).toMatchObject({ width, height, sha256: MOCK_FIXTURES[key] });
    const submission = await accepted(name, uploaded.id);
    const instance = await consumer();
    const completed = waitForState(instance.worker, submission.id, 'completed');
    await reconciler.reconcile();
    expect((await completed).result.detections).toHaveLength(count);
  });

  it('validates asset identifiers, provider configuration, and required idempotency keys', async () => {
    expect((await submit('bad', 'not-an-id')).statusCode).toBe(400);
    expect((await submit('absent', '000000000000000000000000')).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/v1/inspections', payload: { assetId: asset.id } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v1/inspections', headers: { 'idempotency-key': 'missing-asset' }, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v1/inspections', headers: { 'idempotency-key': 'bad-model' },
      payload: { assetId: asset.id, provider: { ...MOCK_CONFIGURATION, modelVersion: 'unknown' } } })).statusCode).toBe(400);
    expect(await inspections.countDocuments()).toBe(0);
  });

  it('distinguishes invalid and nonexistent inspection IDs', async () => {
    const invalid = await app.inject({ method: 'GET', url: '/api/v1/inspections/invalid' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('INVALID_INSPECTION_ID');
    expect((await app.inject({ method: 'GET', url: '/api/v1/inspections/000000000000000000000000' })).statusCode).toBe(404);
  });

  it('replays semantic duplicates and rejects conflicting reuse', async () => {
    const first = await accepted('same');
    const same = await submit('same', asset.id.toUpperCase(), MOCK_CONFIGURATION);
    expect(same.statusCode).toBe(202);
    expect(same.json().id).toBe(first.id);
    const other = await upload(await readFile(new URL('../../../fixtures/inspections/empty.png', import.meta.url)));
    const conflict = await submit('same', other.id);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await inspections.countDocuments()).toBe(1);
  });

  it('uses a unique index to serialize concurrent duplicates; different keys create distinct inspections', async () => {
    const responses = await Promise.all(Array.from({ length: 8 }, () => submit('concurrent')));
    expect(responses.map(response => response.statusCode)).toEqual(Array(8).fill(202));
    expect(new Set(responses.map(response => response.json().id)).size).toBe(1);
    const second = await accepted('another');
    expect(second.id).not.toBe(responses[0]?.json().id);
    expect(await inspections.countDocuments()).toBe(2);
    const indexes = await inspections.collection.indexes();
    expect(indexes.find(index => index.name === 'requestScope_1_requestKey_1')?.unique).toBe(true);
  });

  it('recovers dispatch failure after acceptance and admits requests while Redis is unavailable', async () => {
    const beforeOutage = await accepted('before-redis-outage');
    queue.redis.disconnect();
    await expect(sampleQueue(queue, inspections)).rejects.toThrow('OPERATION_UNAVAILABLE');
    const submission = await accepted();
    await reconciler.reconcile();
    expect((await inspections.findById(submission.id).lean().orFail()).status).toBe('queued');
    const ready = await app.inject({ method: 'GET', url: '/api/v1/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().dependencies.redis).toBe('unavailable');
    await queue.redis.connect();
    const instance = await consumer();
    const completed = waitForState(instance.worker, submission.id, 'completed');
    const priorCompleted = waitForState(instance.worker, beforeOutage.id, 'completed');
    await reconciler.reconcile();
    expect((await completed).attemptCount).toBe(1);
    expect((await priorCompleted).attemptCount).toBe(1);
  });

  it('automatically reconnects after a server-induced Redis connection interruption', async () => {
    const control = redisConnection(redisUrl, false);
    control.on('error', () => {});
    if (control.status !== 'ready') await once(control, 'ready', { signal: AbortSignal.timeout(5000) });
    try {
      const id = await queue.redis.call('CLIENT', 'ID');
      const ready = once(queue.redis, 'ready', { signal: AbortSignal.timeout(5000) });
      await control.call('CLIENT', 'KILL', 'ID', String(id));
      await ready;
      expect(await queue.healthy()).toBe(true);
      const submission = await accepted();
      const instance = await consumer();
      const completed = waitForState(instance.worker, submission.id, 'completed');
      await reconciler.reconcile(); await completed;
    } finally { control.disconnect(); }
  });

  it('commits one result during a worker Redis socket outage and acknowledges after reconnection', async () => {
    const sockets = new Set<Socket>();
    const target = new URL(redisUrl); let blocked = false;
    const proxy = createServer(socket => {
      sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => { sockets.delete(socket); });
      if (blocked) { socket.destroy(); return; }
      const upstream = connect(Number(target.port || 6379), target.hostname);
      sockets.add(upstream); upstream.on('error', () => { socket.destroy(); });
      socket.on('close', () => { upstream.destroy(); });
      upstream.on('close', () => { sockets.delete(upstream); socket.destroy(); });
      socket.pipe(upstream).pipe(socket);
    });
    await new Promise<void>(done => { proxy.listen(0, '127.0.0.1', done); });
    const local = new URL(redisUrl); local.hostname = '127.0.0.1'; local.port = String((proxy.address() as AddressInfo).port);
    let enter!: () => void; let release!: () => void; let committed!: () => void;
    const entered = new Promise<void>(done => { enter = done; });
    const gate = new Promise<void>(done => { release = done; });
    const persisted = new Promise<void>(done => { committed = done; });
    const update = inspections.collection.updateOne.bind(inspections.collection);
    vi.spyOn(inspections.collection, 'updateOne').mockImplementation(async (...args) => {
      const result = await update(...args);
      if (!Array.isArray(args[1]) && args[1].$set?.status === 'completed') committed();
      return result;
    });
    const instance = startInspectionWorker(local.href, dependencies({ async infer(image, signal) {
      enter(); await gate; return new MockInferenceProvider().infer(image, signal);
    } }), queue.queue.name);
    try {
      await instance.worker.waitUntilReady();
      const submission = await accepted();
      const acknowledged = once(instance.worker, 'completed', { signal: AbortSignal.timeout(10_000) });
      await reconciler.reconcile(); await entered;
      blocked = true; for (const socket of sockets) socket.destroy();
      await vi.waitFor(() => { expect(instance.isConnected()).toBe(false); });
      release(); await persisted;
      const original = await inspections.findById(submission.id).lean().orFail();
      expect(original).toMatchObject({ status: 'completed', attemptCount: 1 });
      blocked = false; await acknowledged;
      await vi.waitFor(() => { expect(instance.isConnected()).toBe(true); });
      expect(await inspections.findById(submission.id).lean().orFail()).toEqual(original);
    } finally {
      release(); blocked = false; await instance.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((done, reject) => { proxy.close(error => error ? reject(error) : done()); });
    }
  });

  it('can close producer and worker connections before Redis becomes available', async () => {
    const unavailable = 'redis://127.0.0.1:1';
    const producer = new InspectionQueue(unavailable, logger, `inspections-test-${randomUUID()}`, policy);
    const stopped = startInspectionWorker(unavailable, dependencies(), producer.queue.name);
    await stopped.close();
    await producer.close();
  });

  it('closes cleanly after a failed initial connection attempt', async () => {
    const producer = new InspectionQueue('redis://127.0.0.1:1', logger, `inspections-test-${randomUUID()}`, policy);
    await new Promise<void>(done => { producer.redis.once('close', () => { done(); }); });
    await producer.close();
  });

  it('dispatches after Redis is unavailable during initial producer startup', async () => {
    const sockets = new Set<Socket>();
    let blocked = true;
    const target = new URL(redisUrl);
    const proxy = createServer(socket => {
      sockets.add(socket); socket.on('error', () => {});
      if (blocked) { socket.destroy(); return; }
      const upstream = connect(Number(target.port || 6379), target.hostname);
      sockets.add(upstream); upstream.on('error', () => { socket.destroy(); });
      socket.on('close', () => { upstream.destroy(); });
      upstream.on('close', () => { socket.destroy(); });
      socket.pipe(upstream).pipe(socket);
    });
    await new Promise<void>(done => { proxy.listen(0, '127.0.0.1', done); });
    const local = new URL(redisUrl); local.hostname = '127.0.0.1'; local.port = String((proxy.address() as AddressInfo).port);
    const producer = new InspectionQueue(local.toString(), logger, `inspections-test-${randomUUID()}`, policy);
    try {
      await new Promise<void>(done => { producer.redis.once('close', () => { done(); }); });
      blocked = false;
      await producer.queue.waitUntilReady();
      const submission = await accepted();
      expect(await producer.dispatch(payload(submission.id), new Date(0))).toBe('added');
      expect(await producer.queue.getJob(jobId(payload(submission.id)))).toBeDefined();
      await producer.queue.obliterate({ force: true });
    } finally {
      await producer.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((done, reject) => { proxy.close(error => { if (error) reject(error); else done(); }); });
    }
  });

  it('retries a transient provider failure and completes on the second application attempt', async () => {
    const mock = new MockInferenceProvider();
    const infer = vi.fn<InferenceProvider['infer']>().mockRejectedValueOnce(new InferenceError('PROVIDER_UNAVAILABLE', true))
      .mockImplementation((image, signal) => mock.infer(image, signal));
    const submission = await accepted();
    const instance = await consumer({ infer });
    const completed = waitForState(instance.worker, submission.id, 'completed');
    await reconciler.reconcile();
    expect((await completed).attemptCount).toBe(2);
    expect(infer).toHaveBeenCalledTimes(2);
    const observations = await metrics.registry.metrics();
    expect(observations).toContain('vip_inspection_attempts_started_total 2');
    expect(observations).toContain('vip_inspection_failures_total{kind="retry",code="PROVIDER_UNAVAILABLE"} 1');
    expect(observations).toContain('vip_inspection_terminals_total{status="completed"} 1');
  });

  it.each(['permanent', 'invalid-output', 'wrong-model', 'outside-image'] as const)('terminates %s failures without retrying', async mode => {
    const infer = vi.fn<InferenceProvider['infer']>(async (image, signal) => {
      if (mode === 'permanent') throw new Error('private provider stack and path');
      if (mode === 'invalid-output') return { invalid: true };
      const result = await new MockInferenceProvider().infer(image, signal);
      if (mode === 'outside-image') { result.detections[0]!.boundingBox.x = 1; return result; }
      return { ...result, modelVersion: 'wrong' };
    });
    const submission = await accepted();
    const instance = await consumer({ infer });
    const failed = waitForState(instance.worker, submission.id, 'failed');
    await reconciler.reconcile();
    expect((await failed).attemptCount).toBe(1);
    expect(infer).toHaveBeenCalledTimes(1);
    const response = await app.inject({ method: 'GET', url: submission.url });
    expect(Value.Check(InspectionResponseSchema, response.json())).toBe(true);
    expect(response.json().failure.code).toBe(mode === 'permanent' ? 'INFERENCE_FAILED' : 'INVALID_INFERENCE_RESULT');
    expect(response.body).not.toContain('private');
  });

  it.each(['storage-key', 'checksum'] as const)('rejects invalid persisted asset %s without invoking inference', async mode => {
    const record = await assets.findById(asset.id).lean().orFail();
    await assets.collection.updateOne({ _id: record._id }, { $set: mode === 'storage-key'
      ? { storageKey: '../private-file' } : { sha256: '0'.repeat(64) } });
    const infer = vi.fn<InferenceProvider['infer']>();
    const submission = await accepted();
    const instance = await consumer({ infer });
    const failed = waitForState(instance.worker, submission.id, 'failed');
    await reconciler.reconcile();
    const failure = await failed;
    expect(failure.failure?.code).toBe('INVALID_ASSET');
    expect(failure.attemptCount).toBe(1);
    expect(infer).not.toHaveBeenCalled();
  });

  it('times out unresponsive providers with a persistent bounded retry budget', async () => {
    const infer = vi.fn<InferenceProvider['infer']>(() => new Promise(() => {}));
    const submission = await accepted();
    const instance = startInspectionWorker(redisUrl, { ...dependencies({ infer }), policy: { ...policy, attemptTimeoutMs: 20 } }, queue.queue.name);
    consumers.push(instance.close); await instance.worker.waitUntilReady();
    const failed = waitForState(instance.worker, submission.id, 'failed');
    await reconciler.reconcile();
    const record = await failed;
    expect(record.attemptCount).toBe(3);
    expect(record.failure?.code).toBe('PROVIDER_TIMEOUT');
    expect(infer).toHaveBeenCalledTimes(3);
    const observations = await metrics.registry.metrics();
    expect(observations).toContain('vip_inspection_attempts_started_total 3');
    expect(observations).toContain('vip_inspection_terminals_total{status="failed"} 1');
    expect(observations).toContain('vip_provider_duration_seconds_count{outcome="cancelled"} 3');
    await createInspectionProcessor(dependencies({ infer }))({ id: 'duplicate', data: payload(submission.id) });
    await reconciler.reconcile();
    expect(infer).toHaveBeenCalledTimes(3);
  });

  it('ignores duplicate deliveries both during processing and after completion', async () => {
    let enter!: () => void; let release!: () => void;
    const entered = new Promise<void>(done => { enter = done; });
    const gate = new Promise<void>(done => { release = done; });
    const infer = vi.fn<InferenceProvider['infer']>(async (image, signal) => { enter(); await gate; return new MockInferenceProvider().infer(image, signal); });
    const submission = await accepted();
    const instance = await consumer({ infer });
    const completed = waitForState(instance.worker, submission.id, 'completed');
    await reconciler.reconcile(); await entered;
    const during = await inspections.findById(submission.id).lean().orFail();
    expect(during.status).toBe('processing'); expect(during.attemptId).toBeTruthy();
    const duplicate = createInspectionProcessor(dependencies({ infer }));
    await duplicate({ id: 'duplicate', data: payload(submission.id) });
    release();
    const original = await completed;
    await duplicate({ id: 'redelivery', data: payload(submission.id) });
    const current = await inspections.findById(submission.id).lean().orFail();
    expect(current.result).toEqual(original.result);
    expect(current.completedAt).toEqual(original.completedAt);
    expect(current.attemptCount).toBe(1); expect(infer).toHaveBeenCalledTimes(1);
  });

  it('repairs an interrupted lease and prevents the old attempt from overwriting its successor', async () => {
    let enter!: () => void; let release!: () => void;
    const entered = new Promise<void>(done => { enter = done; }); const gate = new Promise<void>(done => { release = done; });
    const oldProvider: InferenceProvider = { async infer(image, signal) {
      enter(); await gate;
      const value = await new MockInferenceProvider().infer(image, signal);
      value.detections[0]!.confidence = 0.01; return value;
    } };
    const submission = await accepted();
    const oldProcessor = createInspectionProcessor({ ...dependencies(oldProvider), policy: { ...policy, attemptTimeoutMs: 10_000 } });
    const old = oldProcessor({ id: 'interrupted', data: payload(submission.id) });
    await entered;
    await inspections.updateOne({ _id: submission.id }, { $set: { leaseExpiresAt: new Date(0) } });
    await reconciler.reconcile();
    const repaired = await inspections.findById(submission.id).lean().orFail();
    expect(repaired).toMatchObject({ status: 'queued', dispatchGeneration: 1, attemptCount: 1 });
    await inspections.updateOne({ _id: submission.id }, { $set: { nextAttemptAt: new Date(0) } });
    await createInspectionProcessor(dependencies())({ id: 'successor', data: payload(submission.id, 1) });
    release(); await old;
    const completed = await inspections.findById(submission.id).lean().orFail();
    expect(completed.status).toBe('completed'); expect(completed.attemptCount).toBe(2);
    expect(completed.result.detections[0].confidence).toBe(0.94);
    const observations = await metrics.registry.metrics();
    expect(observations).toContain('vip_inspection_attempts_finished_total{outcome="stale"} 1');
    expect(observations).toContain('vip_inspection_terminals_total{status="completed"} 1');
  });

  it.each(['result', 'failure'] as const)('fences a delayed %s write when its lease expires before Mongo evaluates it', async mode => {
    const submission = await accepted();
    const originalUpdate = inspections.collection.updateOne.bind(inspections.collection);
    let snapshot: InspectionRecord | undefined;
    vi.spyOn(inspections.collection, 'updateOne').mockImplementation(async (...args) => {
      if (!snapshot && !Array.isArray(args[1]) && ['completed', 'failed'].includes(String(args[1].$set?.status))) {
        snapshot = await inspections.findById(submission.id).lean().orFail();
        expect(snapshot.status).toBe('processing');
        expect(snapshot.leaseExpiresAt).toBeDefined();
        // Delay the already-created filter, as a stalled command or selection
        // retry can do. No reconciler changes ownership on the test's behalf.
        await delay(Math.max(0, snapshot.leaseExpiresAt!.getTime() - Date.now()) + 25);
      }
      return originalUpdate(...args);
    });
    const provider: InferenceProvider = mode === 'result' ? new MockInferenceProvider() : {
      async infer() { throw new InferenceError('INFERENCE_FAILED', false); },
    };
    const processor = createInspectionProcessor({ ...dependencies(provider),
      policy: { ...policy, leaseMs: 500, attemptTimeoutMs: 250 } });
    await processor({ id: 'delayed-write', data: payload(submission.id) });
    expect(snapshot).toBeDefined();
    expect(snapshot!.leaseExpiresAt!.getTime()).toBeLessThan(Date.now());
    expect(await inspections.findById(submission.id).lean().orFail()).toEqual(snapshot);
    expect(await metrics.registry.metrics()).toContain('vip_inspection_attempts_finished_total{outcome="stale"} 1');
  });

  it('preserves a committed result when delivery fails before BullMQ acknowledgement', async () => {
    const submission = await accepted();
    const processor = createInspectionProcessor(dependencies());
    const redis = redisConnection(redisUrl, true); redis.on('error', () => {});
    let deliveries = 0;
    const worker = new Worker<InspectionJob>(queue.queue.name, async job => {
      await processor(job);
      if (++deliveries === 1) throw new Error('simulated interruption after result commit');
    }, { connection: redis as ConnectionOptions, concurrency: 1 });
    worker.on('error', () => {});
    consumers.push(async () => { try { await worker.close(); } finally { redis.disconnect(); } });
    await worker.waitUntilReady();
    const acknowledged = once(worker, 'completed', { signal: AbortSignal.timeout(10000) });
    await reconciler.reconcile(); await acknowledged;
    expect(deliveries).toBe(2);
    const record = await inspections.findById(submission.id).lean().orFail();
    expect(record.status).toBe('completed'); expect(record.attemptCount).toBe(1);
    expect(record.result.detections[0].confidence).toBe(0.94);
  });

  it('fails abandoned work at the maximum budget instead of resetting attempts on redispatch', async () => {
    const submission = await accepted();
    await inspections.collection.updateOne({ _id: (await inspections.findById(submission.id).orFail())._id },
      { $set: { status: 'processing', attemptCount: 3, attemptId: 'abandoned', leaseExpiresAt: new Date(0) } });
    await reconciler.reconcile(); await reconciler.reconcile();
    const record = await inspections.findById(submission.id).lean().orFail();
    expect(record).toMatchObject({ status: 'failed', attemptCount: 3 });
    expect(record.failure?.code).toBe('ATTEMPTS_EXHAUSTED');
  });

  it.each(['mock', 'trained'] as const)('preserves committed %s inference when Mongo result acknowledgement is lost', async mode => {
    if (mode === 'trained') {
      await app.close();
      app = buildApp({ assets: { model: assets, storage }, inspections: { assets, inspections, trainedEnabled: true }, dispatchQueue: queue });
      asset = await upload(await readFile(new URL('../../../fixtures/pcb/5810_t_007.jpg', import.meta.url)), 'image/jpeg');
    }
    const response = mode === 'mock' ? await submit('lost-result-ack') : await app.inject({
      method: 'POST', url: '/api/v1/inspections', headers: { 'idempotency-key': 'lost-result-ack' },
      payload: { assetId: asset.id, provider: PCB_CONFIGURATION, candidatePatch: true },
    });
    expect(response.statusCode, response.body).toBe(202);
    const submission = response.json<InspectionAccepted>();
    const mockInfer = vi.fn<InferenceProvider['infer']>((image, signal) => new MockInferenceProvider().infer(image, signal));
    // A contract fixture isolates durable trained dispatch; it is not a live model measurement.
    const trainedInfer = vi.fn<InferenceProvider['infer']>(async () => ({
      contractVersion: 'v1', ...PCB_CONFIGURATION, backend: 'trained', simulated: false, durationMs: 3,
      providerTimingMs: { decodePreprocess: 0.5, modelInference: 1, responsePostprocess: 0.5, requestTotal: 2 },
      detections: [{ id: 'lost-ack-prediction', classId: 'mouse_bite', label: 'mouse_bite', confidence: 0.8,
        boundingBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } }],
    }));
    const processor = createInspectionProcessor({ ...dependencies({ infer: mockInfer }),
      providers: { 'visual-inspection-dl': { infer: trainedInfer } } });
    const originalUpdate = inspections.collection.updateOne.bind(inspections.collection);
    let committedBeforeLostAcknowledgement = false;
    vi.spyOn(inspections.collection, 'updateOne').mockImplementation(async (...args) => {
      const result = await originalUpdate(...args);
      if (!committedBeforeLostAcknowledgement && !Array.isArray(args[1]) && args[1].$set?.status === 'completed') {
        expect(result.modifiedCount).toBe(1);
        committedBeforeLostAcknowledgement = true;
        throw new Error('Mongo result committed but acknowledgement was lost');
      }
      return result;
    });
    await expect(processor({ id: 'lost-result-ack', data: payload(submission.id) })).rejects.toThrow('DATABASE_UNAVAILABLE');
    expect(committedBeforeLostAcknowledgement).toBe(true);
    const committed = await inspections.findById(submission.id).lean().orFail();
    expect(committed).toMatchObject({ status: 'completed', attemptCount: 1, dispatchGeneration: 0,
      requested: mode === 'mock' ? MOCK_CONFIGURATION : PCB_CONFIGURATION });
    expect(isInferenceResult(committed.result)).toBe(true);
    expect(committed.result.simulated).toBe(mode === 'mock');
    expect(committed.failure).toBeUndefined();
    expect(committed.attemptId).toBeUndefined();
    expect(committed.leaseExpiresAt).toBeUndefined();
    await processor({ id: 'redelivery-after-lost-result-ack', data: payload(submission.id) });
    await reconciler.reconcile();
    expect(await inspections.findById(submission.id).lean().orFail()).toEqual(committed);
    expect(await inspections.countDocuments()).toBe(1);
    expect(mockInfer).toHaveBeenCalledTimes(mode === 'mock' ? 1 : 0);
    expect(trainedInfer).toHaveBeenCalledTimes(mode === 'trained' ? 1 : 0);
    expect((await app.inject({ method: 'GET', url: submission.url })).json()).toMatchObject({
      status: 'completed', result: committed.result, attemptCount: 1,
    });
  });

  it('recovers a failure after inference but before result persistence', async () => {
    const update = inspections.collection.updateOne.bind(inspections.collection);
    let injected = false;
    vi.spyOn(inspections.collection, 'updateOne').mockImplementation(async (...args) => {
      if (!injected && !Array.isArray(args[1]) && args[1].$set?.status === 'completed') {
        injected = true; throw new Error('simulated lost database connection before result write');
      }
      return update(...args);
    });
    const submission = await accepted();
    const processor = createInspectionProcessor(dependencies());
    await expect(processor({ id: 'lost-write', data: payload(submission.id) })).rejects.toThrow('DATABASE_UNAVAILABLE');
    expect((await inspections.findById(submission.id).lean().orFail()).status).toBe('processing');
    await inspections.updateOne({ _id: submission.id }, { $set: { leaseExpiresAt: new Date(0) } });
    await reconciler.reconcile();
    const instance = await consumer();
    const completed = waitForState(instance.worker, submission.id, 'completed');
    await completed;
    expect((await inspections.findById(submission.id).lean().orFail()).attemptCount).toBe(2);
  });

  it('resumes queued work after a graceful worker shutdown and restart', async () => {
    let enter!: () => void;
    const entered = new Promise<void>(done => { enter = done; });
    const original = await consumer({ infer() { enter(); return new Promise(() => {}); } });
    const submission = await accepted();
    await reconciler.reconcile(); await entered;
    await original.close();
    const record = await inspections.findById(submission.id).lean().orFail();
    expect(record.status).toBe('queued');
    expect(record.failure?.code).toBe('EXECUTION_INTERRUPTED');
    const replacement = await consumer();
    const completed = waitForState(replacement.worker, submission.id, 'completed');
    expect((await completed).attemptCount).toBe(2);
  });

  it('repairs a completed queue delivery that left the business record queued', async () => {
    const submission = await accepted();
    await inspections.updateOne({ _id: submission.id }, { $set: { nextAttemptAt: new Date('2099-01-01') } });
    const instance = await consumer();
    const skipped = once(instance.worker, 'completed', { signal: AbortSignal.timeout(5000) });
    await queue.queue.add('inspect', payload(submission.id), { jobId: jobId(payload(submission.id)) });
    await skipped;
    expect((await inspections.findById(submission.id).lean().orFail()).attemptCount).toBe(0);
    await inspections.updateOne({ _id: submission.id }, { $set: { nextAttemptAt: new Date(0) } });
    await reconciler.reconcile();
    expect((await inspections.findById(submission.id).lean().orFail()).dispatchGeneration).toBe(1);
    const completed = waitForState(instance.worker, submission.id, 'completed');
    await reconciler.reconcile();
    expect((await completed).attemptCount).toBe(1);
  });

  it('preserves failed records and deduplicates manual retry lineage', async () => {
    const submission = await accepted('shared-key');
    const instance = await consumer({ async infer() { throw new InferenceError('INFERENCE_FAILED', false); } });
    const failed = waitForState(instance.worker, submission.id, 'failed');
    await reconciler.reconcile(); await failed;
    const url = `${submission.url}/retry`;
    const requests = await Promise.all(Array.from({ length: 4 }, () => app.inject({ method: 'POST', url, headers: { 'idempotency-key': 'shared-key' } })));
    expect(requests.map(response => response.statusCode)).toEqual([202, 202, 202, 202]);
    expect(new Set(requests.map(response => response.json().id)).size).toBe(1);
    const child = await inspections.findById(requests[0]?.json().id).lean().orFail();
    expect(child).toMatchObject({ status: 'queued', attemptCount: 0 });
    expect(child.retriedFrom?.toString()).toBe(submission.id);
    expect((await inspections.findById(submission.id).lean().orFail()).status).toBe('failed');
    expect(await inspections.countDocuments()).toBe(2);
    const invalidRetry = await app.inject({ method: 'POST', url: `/api/v1/inspections/${child._id}/retry`, headers: { 'idempotency-key': 'another-retry' } });
    expect(invalidRetry.statusCode).toBe(409);
    const conflict = await app.inject({ method: 'POST', url: `/api/v1/inspections/${child._id}/retry`, headers: { 'idempotency-key': 'shared-key' } });
    expect(conflict.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('restarts reconciliation from MongoDB intent and rotates bounded scans fairly', async () => {
    const records = await Promise.all([accepted('first'), accepted('second'), accepted('third')]);
    await inspections.updateMany({}, { $set: { updatedAt: new Date(0) } });
    const restarted = new InspectionReconciler(inspections, queue, logger, { ...policy, batchSize: 1 });
    await restarted.reconcile(); await restarted.reconcile(); await restarted.reconcile();
    for (const record of records) expect(await queue.queue.getJob(jobId(payload(record.id)))).toBeDefined();
    await restarted.close();
  });

  it.each(['before-inference', 'after-inference', 'after-persistence'])(
    'recovers an abruptly terminated child worker at %s', async phase => {
      const submission = await accepted();
      const child = fork(new URL('./helpers/interrupted-worker.mjs', import.meta.url), [], {
        execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env,
          VIP_INTERRUPTION_TEST: JSON.stringify({ phase, database: databaseName, queue: queue.queue.name,
            directory, mongodbUri: process.env.MONGODB_TEST_URI ?? 'mongodb://127.0.0.1:27017', redisUrl }) },
      });
      let stderr = '';
      child.stderr?.on('data', value => { stderr += String(value); });
      const exit = once(child, 'exit', { signal: AbortSignal.timeout(10_000) });
      try {
        const reached = once(child, 'message', { signal: AbortSignal.timeout(8000) });
        await reconciler.reconcile();
        expect((await reached)[0], stderr).toEqual({ phase });
        child.kill('SIGKILL'); // Only the process created by this test.
        await exit;
        const before = await inspections.findById(submission.id).lean().orFail();
        expect(before.attemptCount).toBe(1);
        if (phase === 'after-persistence') {
          expect(before.status).toBe('completed');
          await createInspectionProcessor(dependencies())({ id: 'replay', data: payload(submission.id) });
          expect(await inspections.findById(submission.id).lean().orFail()).toEqual(before);
        } else {
          expect(before.status).toBe('processing');
          expect(before.result).toBeUndefined();
          // Wait for the actual recorded lease boundary, not an assumed worker
          // scheduling delay. BullMQ's old lock need not expire: repair uses a
          // new generation, protected by MongoDB ownership.
          await delay(Math.max(0, before.leaseExpiresAt!.getTime() - Date.now() + 1));
          await reconciler.reconcile();
          const repaired = await inspections.findById(submission.id).lean().orFail();
          expect(repaired).toMatchObject({ status: 'queued', attemptCount: 1, dispatchGeneration: 1 });
          const replacement = await consumer();
          expect((await waitForState(replacement.worker, submission.id, 'completed')).attemptCount).toBe(2);
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exit.catch(() => {});
      }
    });

  it('serializes expired-lease recovery across independent concurrent reconcilers', async () => {
    const submission = await accepted();
    await inspections.updateOne({ _id: submission.id }, { $set: {
      status: 'processing', attemptCount: 1, attemptId: 'abandoned', leaseExpiresAt: new Date(0),
    } });
    const other = new InspectionReconciler(inspections, queue, logger, policy);
    try {
      await Promise.all([reconciler.reconcile(), other.reconcile(), reconciler.reconcile()]);
      expect(await inspections.findById(submission.id).lean().orFail()).toMatchObject({
        status: 'queued', dispatchGeneration: 1, attemptCount: 1,
      });
      const replacement = await consumer();
      expect((await waitForState(replacement.worker, submission.id, 'completed')).attemptCount).toBe(2);
    } finally { await other.close(); }
  });
});
