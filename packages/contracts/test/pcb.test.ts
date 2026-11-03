import { describe, expect, it } from 'vitest';
import { Value } from 'typebox/value';
import {
  PCB_CONFIGURATION, PCB_LABELS, MOCK_CONFIGURATION, InferenceResultSchema, ProviderConfigurationSchema,
  InspectionRequestSchema, isInferenceResult, isResultForConfiguration, isReviewForResult, isPersistedReview,
  labelsForTaxonomy, validReviewAnnotations, type InferenceResult, type PersistedReview, type ReviewAnnotation,
} from '../src/index.js';

function result(): InferenceResult {
  return { contractVersion: 'v1', ...PCB_CONFIGURATION, backend: 'trained', simulated: false, durationMs: 73.29,
    providerTimingMs: { decodePreprocess: 2, modelInference: 50, responsePostprocess: 1, requestTotal: 53 },
    detections: PCB_LABELS.map((label, index) => ({ ...label, id: `pcb-${index}`, confidence: 0.2 + index / 10,
      boundingBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } })),
  };
}
function annotations(): ReviewAnnotation[] {
  return result().detections.map(prediction => ({ id: `prediction:${prediction.id}`, origin: 'prediction',
    predictionId: prediction.id, classId: prediction.classId as typeof PCB_LABELS[number]['classId'],
    disposition: 'accepted', boundingBox: { ...prediction.boundingBox } }));
}
function review(): PersistedReview {
  return { contractVersion: 'v1', taxonomyVersion: 'pcb-ind-v4-1', revision: 1,
    savedAt: '2026-11-02T00:00:00.000Z', annotations: annotations() };
}

describe('pinned trained-model contracts', () => {
  it('accepts all eight classes, exact configured provenance and an empty successful result', () => {
    expect(Value.Check(InferenceResultSchema, result())).toBe(true);
    expect(isInferenceResult(result())).toBe(true);
    expect(isResultForConfiguration(result(), PCB_CONFIGURATION)).toBe(true);
    expect(isInferenceResult({ ...result(), detections: [] })).toBe(true);
    expect(labelsForTaxonomy('pcb-ind-v4-1')).toEqual(PCB_LABELS);
    expect(labelsForTaxonomy('toString')).toBeUndefined();
    expect(labelsForTaxonomy('future-taxonomy')).toBeUndefined();
  });
  it.each([
    { providerId: 'mock' }, { modelId: 'other' }, { modelVersion: 'pcb-ind-ssdlite-v2' },
    { taxonomyVersion: 'mock-v1' }, { artifactDigest: '0'.repeat(64) },
    { backend: 'fixture' }, { simulated: true }, { confidenceThreshold: 0.19 },
    { providerTimingMs: { decodePreprocess: 0, modelInference: Infinity, responsePostprocess: 0, requestTotal: 0 } },
  ])('rejects incompatible or non-finite provenance %j', change => {
    expect(isInferenceResult({ ...result(), ...change })).toBe(false);
  });
  it('rejects cross-provider matching, unpinned configurations, and missing provenance', () => {
    expect(isResultForConfiguration(result(), MOCK_CONFIGURATION)).toBe(false);
    expect(isResultForConfiguration(result(), { ...PCB_CONFIGURATION, artifactDigest: 'a'.repeat(64) })).toBe(false);
    expect(Value.Check(ProviderConfigurationSchema, { ...MOCK_CONFIGURATION, artifactDigest: PCB_CONFIGURATION.artifactDigest })).toBe(false);
    const missing = { ...result() } as Record<string, unknown>; delete missing.artifactDigest;
    expect(isInferenceResult(missing)).toBe(false);
    expect(Value.Check(InspectionRequestSchema, { assetId: 'a'.repeat(24), provider: PCB_CONFIGURATION, candidatePatch: true })).toBe(true);
    expect(Value.Check(InspectionRequestSchema, { assetId: 'a'.repeat(24), provider: PCB_CONFIGURATION, candidatePatch: false })).toBe(false);
  });
  it('rejects invalid class identity, labels and scores below the pinned threshold', () => {
    for (const change of [{ classId: 'surface-mark' }, { classId: '1' }, { label: 'Mouse bite' }, { confidence: 0.199 }]) {
      const copy = result(); Object.assign(copy.detections[0]!, change);
      expect(isInferenceResult(copy)).toBe(false);
    }
  });
  it('keeps the trained result bound at 100, with stable unique identifiers required', () => {
    const copy = result(); const detection = copy.detections[0]!;
    copy.detections = Array.from({ length: 100 }, (_, index) => ({ ...detection, id: `p-${index}` }));
    expect(isInferenceResult(copy)).toBe(true);
    copy.detections.push({ ...detection, id: 'p-100' });
    expect(Value.Check(InferenceResultSchema, copy)).toBe(false);
    expect(isInferenceResult(copy)).toBe(false);
    copy.detections = [detection, detection]; expect(isInferenceResult(copy)).toBe(false);
  });
  it('allows only arithmetic edge tolerance without rounding persisted coordinates', () => {
    const copy = result(); copy.detections[0]!.boundingBox = { x: 0.9, y: 0, width: 0.10000000000000012, height: 1 };
    expect(isInferenceResult(copy)).toBe(true);
    expect(copy.detections[0]!.boundingBox.width).toBe(0.10000000000000012);
    copy.detections[0]!.boundingBox.width = 0.1000000001;
    expect(isInferenceResult(copy)).toBe(false);
  });
});

describe('reviews remain bound to their original model taxonomy', () => {
  it('supports eight-class review operations while preserving all original references', () => {
    const saved = review();
    saved.annotations[0]!.disposition = 'rejected';
    saved.annotations[1]!.classId = 'open';
    saved.annotations[2]!.boundingBox = { x: 0, y: 0, width: 1, height: 1 };
    saved.annotations.push({ id: 'manual:a1234567-1234-4123-8123-123456789abc', origin: 'manual',
      disposition: 'accepted', classId: 'short', boundingBox: { x: 0.2, y: 0.2, width: 0.1, height: 0.1 } });
    expect(isReviewForResult(saved, result())).toBe(true);
    expect(saved.annotations.at(-1)).not.toHaveProperty('confidence');
    expect(result().detections[1]!.classId).toBe('missing_copper');
  });
  it('rejects taxonomy substitution, mixed vocabularies, missing predictions and invented references', () => {
    expect(isReviewForResult({ ...review(), taxonomyVersion: 'mock-v1' }, result())).toBe(false);
    const saved = review(); saved.annotations[0]!.classId = 'surface-mark';
    expect(isPersistedReview(saved)).toBe(false);
    expect(validReviewAnnotations(saved.annotations, result())).toBe(false);
    expect(validReviewAnnotations(annotations().slice(1), result())).toBe(false);
    const invented = annotations(); Object.assign(invented[0]!, { predictionId: 'absent', id: 'prediction:absent' });
    expect(validReviewAnnotations(invented, result())).toBe(false);
  });
  it('rejects duplicate references, forged confidence and non-finite review coordinates', () => {
    expect(validReviewAnnotations([...annotations(), annotations()[0]!], result())).toBe(false);
    const withScore = annotations(); Object.assign(withScore[0]!, { confidence: 0.99 });
    expect(validReviewAnnotations(withScore, result())).toBe(false);
    const invalidBox = review(); invalidBox.annotations[0]!.boundingBox.y = NaN;
    expect(isReviewForResult(invalidBox, result())).toBe(false);
  });
});
