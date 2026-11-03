import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { MOCK_CONFIGURATION, PCB_CONFIGURATION, type ProviderConfiguration } from '@vip/contracts';
import { createInspectionProcessor, type ExecutionDependencies } from '../src/execution.js';
import { MockInferenceProvider, type InferenceProvider } from '../src/provider.js';
import { translatePcbPrediction } from '../src/pcb-provider.js';

function fixture(requested: ProviderConfiguration = PCB_CONFIGURATION, candidatePatch = true) {
  const bytes = Buffer.from('worker dispatch protocol fixture');
  const image = { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), width: 300, height: 300, mimeType: 'image/png' as const };
  const record = { _id: 'a'.repeat(24), assetId: 'b'.repeat(24), status: 'processing', requested, candidatePatch,
    requestId: 'test-request', attemptCount: 1, maxAttempts: 3, createdAt: new Date() };
  const updateOne = vi.fn(() => ({ exec: async () => ({ modifiedCount: 1 }) }));
  const inspections = { findOneAndUpdate: vi.fn(() => ({ lean: () => ({ exec: async () => record }) })), updateOne };
  const assets = { findById: vi.fn(() => ({ lean: () => ({ exec: async () => ({ ...image,
    byteLength: bytes.byteLength, storageKey: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png' }) }) })) };
  const storage = { openContent: vi.fn(async () => Readable.from([bytes])) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const mock = { infer: vi.fn<InferenceProvider['infer']>((asset, signal) => new MockInferenceProvider().infer(asset, signal)) };
  const dependencies = { inspections, assets, storage, provider: mock, logger } as unknown as ExecutionDependencies;
  const job = { id: 'test-job', data: { payloadVersion: 'v1' as const, inspectionId: record._id, generation: 0 } };
  const realResult = translatePcbPrediction({ schema_version: '1', provider: 'visual-inspection-dl', backend: 'trained', simulated: false,
    model_version: PCB_CONFIGURATION.modelVersion, taxonomy_version: PCB_CONFIGURATION.taxonomyVersion,
    artifact_digest: PCB_CONFIGURATION.artifactDigest, image: { width: 300, height: 300 }, coordinate_system: 'xyxy_pixels_original_image',
    confidence_threshold: 0.2, nms_threshold: 0.55, invalid_predictions_rejected: 0, detections: [],
    timing_ms: { decode_preprocess: 1, model_inference: 2, response_postprocess: 1, request_total: 4 } }, image, 5);
  return { dependencies, mock, job, updateOne, logger, realResult };
}

describe('immutable requested-provider dispatch', () => {
  it('dispatches a real inspection exclusively to the real provider and commits its original result under ownership fencing', async () => {
    const state = fixture();
    const infer = vi.fn<InferenceProvider['infer']>().mockResolvedValue(state.realResult);
    await createInspectionProcessor({ ...state.dependencies, providers: { 'visual-inspection-dl': { infer } } })(state.job);
    expect(infer).toHaveBeenCalledTimes(1); expect(state.mock.infer).not.toHaveBeenCalled();
    expect(state.updateOne).toHaveBeenCalledWith(expect.objectContaining({ status: 'processing', attemptId: expect.any(String),
      dispatchGeneration: 0, result: { $exists: false }, leaseExpiresAt: { $gt: expect.any(Date) } }), expect.objectContaining({
      $set: expect.objectContaining({ status: 'completed', result: state.realResult }),
    }), { runValidators: true });
  });
  it('uses the original mock provider for existing inspections', async () => {
    const state = fixture(MOCK_CONFIGURATION);
    const real = { infer: vi.fn<InferenceProvider['infer']>().mockResolvedValue(state.realResult) };
    await createInspectionProcessor({ ...state.dependencies, providers: { 'visual-inspection-dl': real } })(state.job);
    expect(state.mock.infer).toHaveBeenCalledTimes(1); expect(real.infer).not.toHaveBeenCalled();
  });
  it('schedules a bounded retry when the requested real provider is unavailable without calling mock', async () => {
    const state = fixture();
    await expect(createInspectionProcessor(state.dependencies)(state.job)).rejects.toThrow('PROVIDER_UNAVAILABLE');
    expect(state.mock.infer).not.toHaveBeenCalled();
    expect(state.updateOne).toHaveBeenCalledWith(expect.objectContaining({ attemptId: expect.any(String) }), expect.objectContaining({
      $set: expect.objectContaining({ status: 'queued', failure: expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE' }) }),
    }));
  });
  it('terminally rejects real work without candidate-patch admission', async () => {
    const state = fixture(PCB_CONFIGURATION, false);
    const infer = vi.fn<InferenceProvider['infer']>().mockResolvedValue(state.realResult);
    await expect(createInspectionProcessor({ ...state.dependencies, providers: { 'visual-inspection-dl': { infer } } })(state.job)).rejects.toThrow('INVALID_ASSET');
    expect(state.mock.infer).not.toHaveBeenCalled(); expect(infer).not.toHaveBeenCalled();
    expect(state.updateOne).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      $set: expect.objectContaining({ status: 'failed', failure: expect.objectContaining({ code: 'INVALID_ASSET' }) }),
    }));
  });
  it('rejects a mock response from a real-provider adapter instead of relabeling it', async () => {
    const state = fixture();
    const fake = await new MockInferenceProvider().infer({ bytes: Buffer.from('fixture'), sha256: '0'.repeat(64), width: 300,
      height: 300, mimeType: 'image/png' }, new AbortController().signal);
    await expect(createInspectionProcessor({ ...state.dependencies,
      providers: { 'visual-inspection-dl': { infer: async () => fake } },
    })(state.job)).rejects.toThrow('INVALID_INFERENCE_RESULT');
    expect(state.mock.infer).not.toHaveBeenCalled();
    expect(state.updateOne).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      $set: expect.objectContaining({ status: 'failed', failure: expect.objectContaining({ code: 'INVALID_INFERENCE_RESULT' }) }),
    }));
  });
});
