import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { PCB_CONFIGURATION, MOCK_CONFIGURATION, type InferenceResult } from '@vip/contracts';
import { acceptInspection, retryInspection, inspectionResponse, type InspectionDependencies } from '../src/acceptance.js';
import { createInspectionModel } from '../src/inspection-model.js';

const assetId = '0123456789abcdef01234567';
const trainedResult: InferenceResult = { contractVersion: 'v1', ...PCB_CONFIGURATION, backend: 'trained', simulated: false,
  durationMs: 1, providerTimingMs: { decodePreprocess: 0, modelInference: 1, responsePostprocess: 0, requestTotal: 1 }, detections: [] };

function fixture(dimensions = { width: 300, height: 300 }) {
  const records: Array<Record<string, unknown>> = [];
  const query = (value: unknown) => ({ lean: () => ({ exec: async () => value }), select: () => ({ lean: () => ({ exec: async () => value }) }) });
  const inspections = {
    findOne: vi.fn((filter: Record<string, unknown>) => query(records.find(record => record.requestScope === filter.requestScope && record.requestKey === filter.requestKey))),
    findById: vi.fn((id: string) => query(records.find(record => record._id === id))),
    create: vi.fn(async (data: Record<string, unknown>) => {
      const record = { _id: assetId, ...data }; records.push(record); return { toObject: () => record };
    }),
  };
  const assets = { exists: vi.fn(async () => true), findById: vi.fn(() => query({ _id: assetId, ...dimensions })) };
  const dependencies = { inspections, assets, trainedEnabled: true } as unknown as InspectionDependencies;
  return { dependencies, inspections, assets, records };
}

describe('immutable trained inspection acceptance', () => {
  it('stores every pinned provider field and attestation while retaining legacy mock fingerprints', async () => {
    const { dependencies, inspections } = fixture();
    await acceptInspection(dependencies, { assetId, key: 'mock', requestId: 'r1' });
    const legacyHash = createHash('sha256').update(JSON.stringify({ assetId, configuration: MOCK_CONFIGURATION })).digest('hex');
    expect(inspections.create).toHaveBeenLastCalledWith(expect.objectContaining({ requested: MOCK_CONFIGURATION, requestFingerprint: legacyHash }));
    await acceptInspection(dependencies, { assetId, provider: PCB_CONFIGURATION, candidatePatch: true, key: 'trained', requestId: 'r2' });
    expect(inspections.create).toHaveBeenLastCalledWith(expect.objectContaining({ requested: PCB_CONFIGURATION, candidatePatch: true }));
  });
  it('replays accepted intent even if the trained integration becomes disabled', async () => {
    const { dependencies, inspections } = fixture();
    const request = { assetId, provider: PCB_CONFIGURATION, candidatePatch: true as const, key: 'same', requestId: 'first' };
    const first = await acceptInspection(dependencies, request);
    dependencies.trainedEnabled = false;
    expect(await acceptInspection(dependencies, { ...request, requestId: 'second' })).toEqual(first);
    expect(inspections.create).toHaveBeenCalledTimes(1);
  });
  it('rejects provider or candidate attestation changes on a reused key', async () => {
    const { dependencies, inspections } = fixture();
    await acceptInspection(dependencies, { assetId, provider: PCB_CONFIGURATION, candidatePatch: true, key: 'same', requestId: 'r' });
    await expect(acceptInspection(dependencies, { assetId, key: 'same', requestId: 'r' })).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_CONFLICT' });
    await expect(acceptInspection(dependencies, { assetId, provider: PCB_CONFIGURATION, key: 'same', requestId: 'r' })).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_CONFLICT' });
    expect(inspections.create).toHaveBeenCalledTimes(1);
  });
  it('requires explicit enablement and candidate identification before creating real intent', async () => {
    const { dependencies, inspections } = fixture();
    dependencies.trainedEnabled = false;
    await expect(acceptInspection(dependencies, { assetId, provider: PCB_CONFIGURATION, candidatePatch: true, key: 'disabled', requestId: 'r' })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    dependencies.trainedEnabled = true;
    await expect(acceptInspection(dependencies, { assetId, provider: PCB_CONFIGURATION, key: 'unidentified', requestId: 'r' })).rejects.toMatchObject({ code: 'INVALID_ASSET' });
    expect(inspections.create).not.toHaveBeenCalled();
  });
  it.each([{ width: 600, height: 300 }, { width: 300, height: 301 }, { width: 4000, height: 3000 }])('rejects out-of-domain stored dimensions %j', async dimensions => {
    const { dependencies, inspections } = fixture(dimensions);
    await expect(acceptInspection(dependencies, { assetId, provider: PCB_CONFIGURATION, candidatePatch: true, key: 'real', requestId: 'r' })).rejects.toMatchObject({ code: 'INVALID_ASSET' });
    expect(inspections.create).not.toHaveBeenCalled();
    await expect(acceptInspection(dependencies, { assetId, key: 'mock', requestId: 'r' })).resolves.toBeDefined();
  });
  it('retains original provider and admission in a linked manual retry during an outage', async () => {
    const { dependencies, records, inspections } = fixture();
    records.push({ _id: 'a'.repeat(24), assetId, status: 'failed', requested: PCB_CONFIGURATION, candidatePatch: true });
    dependencies.trainedEnabled = false;
    await retryInspection(dependencies, { inspectionId: 'a'.repeat(24), key: 'retry', requestId: 'r' });
    expect(inspections.create).toHaveBeenCalledWith(expect.objectContaining({ requested: PCB_CONFIGURATION, candidatePatch: true, retriedFrom: 'a'.repeat(24) }));
  });
});

describe('Mongo inspection validation without a database connection', () => {
  it('accepts old mock records and pinned real records but rejects forged combinations', async () => {
    const connection = mongoose.createConnection();
    const Model = createInspectionModel(connection);
    const fields = { assetId, requestScope: 'test', requestKey: 'one', requestFingerprint: 'hash', requestId: 'r' };
    try {
      await expect(new Model({ ...fields, requested: MOCK_CONFIGURATION }).validate()).resolves.toBeUndefined();
      await expect(new Model({ ...fields, requested: PCB_CONFIGURATION, candidatePatch: true, result: trainedResult }).validate()).resolves.toBeUndefined();
      for (const requested of [{ ...PCB_CONFIGURATION, artifactDigest: 'a'.repeat(64) },
        { providerId: 'mock', modelId: PCB_CONFIGURATION.modelId, modelVersion: '1.0.0' }]) {
        await expect(new Model({ ...fields, requested, candidatePatch: true }).validate()).rejects.toBeDefined();
      }
      await expect(new Model({ ...fields, requested: PCB_CONFIGURATION }).validate()).rejects.toBeDefined();
      await expect(new Model({ ...fields, requested: MOCK_CONFIGURATION, result: trainedResult }).validate()).rejects.toBeDefined();
      await expect(new Model({ ...fields, requested: PCB_CONFIGURATION, candidatePatch: true, result: trainedResult,
        review: { contractVersion: 'v1', taxonomyVersion: 'mock-v1', revision: 1, savedAt: '2026-11-02T00:00:00.000Z', annotations: [] } }).validate()).rejects.toBeDefined();
    } finally { await connection.close(); }
  });
  it('refuses to serve a result saved under the wrong immutable request identity', () => {
    expect(() => inspectionResponse({ status: 'completed', requested: MOCK_CONFIGURATION, result: trainedResult } as never)).toThrow();
  });
});
