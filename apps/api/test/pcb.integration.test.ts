import { randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectDatabase, createAssetModel, createInspectionModel, LocalImageStorage } from '@vip/backend';
import {
  PCB_CONFIGURATION, PCB_LABELS, MOCK_CONFIGURATION,
  type InferenceResult, type SaveReviewRequest, type SavedReviewResponse,
} from '@vip/contracts';
import { buildApp } from '../src/app.js';

// These are contract fixtures. They test persistence and review, not trained inference accuracy.
const trainedResult: InferenceResult = { contractVersion: 'v1', ...PCB_CONFIGURATION, backend: 'trained', simulated: false,
  durationMs: 80.2, providerTimingMs: { decodePreprocess: 2, modelInference: 60, responsePostprocess: 1, requestTotal: 63 },
  detections: PCB_LABELS.map((label, index) => ({ ...label, id: `pcb-contract-${index}`, confidence: 0.93,
    boundingBox: { x: index / 100, y: index / 100, width: 0.1, height: 0.2 } })),
};

describe('PCB admission and eight-class review with real MongoDB', () => {
  const databaseName = `vip_pcb_contract_test_${randomUUID().replaceAll('-', '')}`;
  let connection: Awaited<ReturnType<typeof connectDatabase>>;
  let assets: ReturnType<typeof createAssetModel>;
  let inspections: ReturnType<typeof createInspectionModel>;
  let app: ReturnType<typeof buildApp>;
  let assetId: string;
  let storage: LocalImageStorage;
  let storageDirectory: string;
  let patch: Buffer;

  function startApp(enabled = true) {
    return buildApp({ assets: { model: assets, storage }, inspections: { assets, inspections, trainedEnabled: enabled },
      trainedInference: { enabled, available: () => false } });
  }
  async function connect() {
    connection = await connectDatabase(process.env.MONGODB_TEST_URI ?? 'mongodb://127.0.0.1:27017', databaseName);
    assets = createAssetModel(connection); inspections = createInspectionModel(connection);
    await Promise.all([assets.createIndexes(), inspections.createIndexes()]);
  }
  beforeAll(async () => {
    await connect();
    storageDirectory = await mkdtemp(join(tmpdir(), 'vip-pcb-contract-test-'));
    storage = new LocalImageStorage(storageDirectory); await storage.initialize();
    patch = await readFile(new URL('../../../fixtures/pcb/5810_t_007.jpg', import.meta.url));
  });
  beforeEach(async () => {
    await Promise.all([assets.deleteMany({}), inspections.deleteMany({})]);
    app = startApp();
    assetId = await upload(patch, 'image/jpeg');
  });
  afterEach(async () => { await app.close(); });
  afterAll(async () => {
    if (!connection) return;
    if (connection.name !== databaseName || !databaseName.startsWith('vip_pcb_contract_test_')) throw new Error('Unsafe PCB test cleanup');
    await connection.dropDatabase(); await connection.close();
    if (storageDirectory) {
      if (!resolve(storageDirectory).startsWith(`${resolve(tmpdir())}${sep}vip-pcb-contract-test-`)) throw new Error('Unsafe PCB storage cleanup');
      await rm(storageDirectory, { recursive: true, force: true });
    }
  });
  async function upload(bytes: Buffer, mimeType: 'image/png' | 'image/jpeg') {
    const boundary = 'pcb-contract-fixture';
    const response = await app.inject({ method: 'POST', url: '/api/v1/assets',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="patch.${mimeType === 'image/jpeg' ? 'jpg' : 'png'}"\r\nContent-Type: ${mimeType}\r\n\r\n`),
        bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().id as string;
  }
  function submit(key = 'pcb-submit', changes: Record<string, unknown> = {}) {
    return app.inject({ method: 'POST', url: '/api/v1/inspections', headers: { 'idempotency-key': key },
      payload: { assetId, provider: PCB_CONFIGURATION, candidatePatch: true, ...changes } });
  }
  async function completed() {
    const record = await inspections.create({ assetId, requested: PCB_CONFIGURATION, candidatePatch: true,
      requestScope: 'fixture', requestKey: randomUUID(), requestFingerprint: 'contract-fixture', requestId: 'pcb-contract-test',
      status: 'completed', result: trainedResult, completedAt: new Date(), processingDurationMs: 90 });
    return record._id.toString();
  }
  function request(): SaveReviewRequest {
    return { contractVersion: 'v1', taxonomyVersion: 'pcb-ind-v4-1', operationId: randomUUID(), expectedRevision: 0, expectedWriteSequence: 0,
      annotations: trainedResult.detections.map(prediction => ({ id: `prediction:${prediction.id}`, origin: 'prediction',
        predictionId: prediction.id, classId: prediction.classId as typeof PCB_LABELS[number]['classId'],
        disposition: 'accepted', boundingBox: { ...prediction.boundingBox } })),
    };
  }
  function put(id: string, body: SaveReviewRequest) {
    return app.inject({ method: 'PUT', url: `/api/v1/inspections/${id}/review`, payload: body });
  }
  function read(id: string) { return app.inject({ method: 'GET', url: `/api/v1/inspections/${id}` }); }

  it('deduplicates durable real intent despite unavailable model readiness and conflicts with provider changes', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/inference-modes' })).json()).toMatchObject({ trained: { enabled: true, available: false } });
    const responses = await Promise.all(Array.from({ length: 8 }, () => submit('concurrent')));
    expect(responses.map(response => response.statusCode)).toEqual(Array(8).fill(202));
    expect(new Set(responses.map(response => response.json().id)).size).toBe(1);
    expect(await inspections.countDocuments()).toBe(1);
    const record = await inspections.findById(responses[0]!.json().id).lean().orFail();
    expect(record).toMatchObject({ status: 'queued', attemptCount: 0, requested: PCB_CONFIGURATION, candidatePatch: true });
    const conflicting = await submit('concurrent', { provider: MOCK_CONFIGURATION });
    expect(conflicting.statusCode).toBe(409); expect(conflicting.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
  });
  it('requires candidate-patch attestation and 300×300 canonical dimensions without narrowing mock admission', async () => {
    const missing = await app.inject({ method: 'POST', url: '/api/v1/inspections', headers: { 'idempotency-key': 'missing' },
      payload: { assetId, provider: PCB_CONFIGURATION } });
    expect(missing.statusCode).toBe(400); expect(missing.json().error.code).toBe('INVALID_ASSET');
    assetId = await upload(await readFile(new URL('../../../fixtures/inspections/panel.png', import.meta.url)), 'image/png');
    const board = await submit('full-board');
    expect(board.statusCode).toBe(400); expect(board.json().error.code).toBe('INVALID_ASSET');
    expect(await inspections.countDocuments()).toBe(0);
    const mock = await submit('mock', { provider: MOCK_CONFIGURATION });
    expect(mock.statusCode, mock.body).toBe(202);
  });
  it('replays accepted real intent after disabling integration and retains provenance on linked retry', async () => {
    const accepted = await submit('previously-accepted');
    expect(accepted.statusCode).toBe(202);
    const id = accepted.json().id as string;
    await app.close(); app = startApp(false);
    const repeated = await submit('previously-accepted');
    expect(repeated.statusCode).toBe(202); expect(repeated.json().id).toBe(id);
    expect((await submit('new-disabled')).statusCode).toBe(503);
    await inspections.updateOne({ _id: id }, { $set: { status: 'failed', completedAt: new Date(),
      failure: { code: 'PROVIDER_UNAVAILABLE', message: 'The inference provider is temporarily unavailable.' } } });
    const retry = await app.inject({ method: 'POST', url: `/api/v1/inspections/${id}/retry`, headers: { 'idempotency-key': 'manual-retry' } });
    expect(retry.statusCode, retry.body).toBe(202);
    const child = await inspections.findById(retry.json().id).lean().orFail();
    expect(child).toMatchObject({ requested: PCB_CONFIGURATION, candidatePatch: true });
    expect(child.retriedFrom!.toString()).toBe(id);
    expect((await read(id)).json().latestRetryId).toBe(child._id.toString());
  });
  it('saves edits across all eight classes, reopens from history after restart, and keeps predictions immutable', async () => {
    const id = await completed();
    const body = request();
    body.annotations[0]!.disposition = 'rejected';
    body.annotations[1]!.classId = 'open';
    body.annotations[2]!.boundingBox = { x: 0.2, y: 0.3, width: 0.4, height: 0.5 };
    body.annotations.push({ id: `manual:${randomUUID()}`, origin: 'manual', disposition: 'accepted', classId: 'short',
      boundingBox: { x: 0, y: 0, width: 0.1, height: 0.1 } });
    const response = await put(id, body);
    expect(response.statusCode, response.body).toBe(200);
    const saved = response.json<SavedReviewResponse>();
    expect(saved.review).toMatchObject({ revision: 1, taxonomyVersion: 'pcb-ind-v4-1', annotations: body.annotations });
    expect(saved.review.annotations.at(-1)).not.toHaveProperty('confidence');
    await app.close(); await connection.close(); await connect(); app = startApp(false);
    const reopened = await read(id);
    expect(reopened.statusCode, reopened.body).toBe(200);
    expect(reopened.json().review).toEqual(saved.review); expect(reopened.json().result).toEqual(trainedResult);
    const history = await app.inject({ method: 'GET', url: '/api/v1/inspections' });
    expect(history.statusCode, history.body).toBe(200);
    expect(history.json().items).toContainEqual(expect.objectContaining({ id, requested: PCB_CONFIGURATION, hasReview: true, reviewRevision: 1 }));
    const removedManual = { ...body, operationId: randomUUID(), expectedRevision: 1, expectedWriteSequence: 1,
      annotations: body.annotations.filter(annotation => annotation.origin !== 'manual') };
    expect((await put(id, removedManual)).statusCode).toBe(200);
    expect((await read(id)).json().result).toEqual(trainedResult);
  });
  it('preserves revision conflicts and idempotent save receipts for trained reviews', async () => {
    const id = await completed(); const a = request(), b = request(); b.annotations[0]!.disposition = 'rejected';
    const responses = await Promise.all([put(id, a), put(id, b)]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 409]);
    const winningRequest = responses[0]!.statusCode === 200 ? a : b;
    const repeated = await put(id, winningRequest);
    expect(repeated.statusCode, repeated.body).toBe(200);
    expect(repeated.json()).toMatchObject({ outcome: 'replayed', operationRevision: 1, writeSequence: 1,
      review: { revision: 1, taxonomyVersion: 'pcb-ind-v4-1' } });
    const conflictingOperation = structuredClone(winningRequest); conflictingOperation.annotations[1]!.classId = 'scratch';
    expect((await put(id, conflictingOperation)).json().error.code).toBe('REVIEW_OPERATION_CONFLICT');
    expect((await read(id)).json().result).toEqual(trainedResult);
  });
  it('rejects saved-review taxonomy substitution and mock vocabulary without partially changing records', async () => {
    const id = await completed();
    const wrongTaxonomy = request(); wrongTaxonomy.taxonomyVersion = 'mock-v1';
    expect((await put(id, wrongTaxonomy)).statusCode).toBe(400);
    const mixed = request(); mixed.annotations[0]!.classId = 'surface-mark';
    expect((await put(id, mixed)).statusCode).toBe(400);
    const malformed = request(); malformed.annotations.pop();
    expect((await put(id, malformed)).statusCode).toBe(400);
    expect((await read(id)).json()).toMatchObject({ result: trainedResult });
    expect((await read(id)).json()).not.toHaveProperty('review');
  });
});
