import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

export const INSPECTIONS_PATH = '/api/v1/inspections';
import { BoundingBoxSchema, MAX_DETECTIONS, NORMALIZED_GEOMETRY_EPSILON, labelsForTaxonomy } from './annotations.js';
import { PersistedReviewSchema } from './reviews.js';
export { BoundingBoxSchema, MAX_DETECTIONS, NORMALIZED_GEOMETRY_EPSILON, MOCK_LABELS, PCB_LABELS, TAXONOMIES, labelsForTaxonomy, type TaxonomyVersion } from './annotations.js';
export const MOCK_CONFIGURATION = {
  providerId: 'mock', modelId: 'mock-detector', modelVersion: '1.0.0',
} as const;
export const PCB_CONFIGURATION = {
  providerId: 'visual-inspection-dl', modelId: 'pcb-ind-ssdlite', modelVersion: 'pcb-ind-ssdlite-v1',
  taxonomyVersion: 'pcb-ind-v4-1',
  artifactDigest: '9037234654bcc190f6f5dd8cda07e70a119ba19b139b2b99118f4d9f27d7e05e',
  confidenceThreshold: 0.20,
} as const;

const mockConfiguration = {
  providerId: Type.Literal('mock'), modelId: Type.Literal('mock-detector'), modelVersion: Type.Literal('1.0.0'),
};
const pcbConfiguration = {
  providerId: Type.Literal(PCB_CONFIGURATION.providerId), modelId: Type.Literal(PCB_CONFIGURATION.modelId),
  modelVersion: Type.Literal(PCB_CONFIGURATION.modelVersion), taxonomyVersion: Type.Literal(PCB_CONFIGURATION.taxonomyVersion),
  artifactDigest: Type.Literal(PCB_CONFIGURATION.artifactDigest), confidenceThreshold: Type.Literal(PCB_CONFIGURATION.confidenceThreshold),
};
export const ProviderConfigurationSchema = Type.Union([
  Type.Object(mockConfiguration, { additionalProperties: false }),
  Type.Object(pcbConfiguration, { additionalProperties: false }),
]);
export type ProviderConfiguration = Static<typeof ProviderConfigurationSchema>;
export function isProviderConfiguration(value: unknown): value is ProviderConfiguration {
  return Value.Check(ProviderConfigurationSchema, value);
}


export const DetectionSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 80 }),
  classId: Type.String({ minLength: 1, maxLength: 80 }),
  label: Type.String({ minLength: 1, maxLength: 128 }),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  boundingBox: BoundingBoxSchema,
}, { additionalProperties: false });

const resultFields = {
  contractVersion: Type.Literal('v1'),
  durationMs: Type.Number({ minimum: 0 }),
  detections: Type.Array(DetectionSchema, { maxItems: MAX_DETECTIONS }),
};
export const ProviderTimingSchema = Type.Object({
  decodePreprocess: Type.Number({ minimum: 0 }), modelInference: Type.Number({ minimum: 0 }),
  responsePostprocess: Type.Number({ minimum: 0 }), requestTotal: Type.Number({ minimum: 0 }),
}, { additionalProperties: false });
export const InferenceResultSchema = Type.Union([
  Type.Object({ ...resultFields, ...mockConfiguration,
    taxonomyVersion: Type.Literal('mock-v1'), simulated: Type.Literal(true),
  }, { additionalProperties: false }),
  Type.Object({ ...resultFields, ...pcbConfiguration, backend: Type.Literal('trained'), simulated: Type.Literal(false),
    detections: Type.Array(DetectionSchema, { maxItems: 100 }), providerTimingMs: ProviderTimingSchema,
  }, { additionalProperties: false }),
]);
export type InferenceResult = Static<typeof InferenceResultSchema>;

export function isInferenceResult(value: unknown): value is InferenceResult {
  if (!Value.Check(InferenceResultSchema, value) || !Number.isFinite(value.durationMs)) return false;
  const labels = labelsForTaxonomy(value.taxonomyVersion);
  if (!labels || (value.providerId === PCB_CONFIGURATION.providerId
    && !Object.values(value.providerTimingMs).every(Number.isFinite))) return false;
  const identifiers = new Set<string>();
  for (const detection of value.detections) {
    const { x, y, width, height } = detection.boundingBox;
    if (![x, y, width, height, detection.confidence].every(Number.isFinite)
      || x + width > 1 + NORMALIZED_GEOMETRY_EPSILON || y + height > 1 + NORMALIZED_GEOMETRY_EPSILON || identifiers.has(detection.id)
      || !labels.some(label => label.classId === detection.classId && label.label === detection.label)
      || (value.providerId === PCB_CONFIGURATION.providerId && detection.confidence < PCB_CONFIGURATION.confidenceThreshold)) return false;
    identifiers.add(detection.id);
  }
  return true;
}

export function isResultForConfiguration(value: unknown, requested: unknown): value is InferenceResult {
  if (!isProviderConfiguration(requested) || !isInferenceResult(value)) return false;
  return value.providerId === requested.providerId && value.modelId === requested.modelId
    && value.modelVersion === requested.modelVersion
    && (requested.providerId === 'mock' || (value.providerId === PCB_CONFIGURATION.providerId
      && value.artifactDigest === requested.artifactDigest && value.taxonomyVersion === requested.taxonomyVersion
      && value.confidenceThreshold === requested.confidenceThreshold));
}

export const INFERENCE_MODES_PATH = '/api/v1/inference-modes';
export const InferenceModesResponseSchema = Type.Object({
  trained: Type.Object({ enabled: Type.Boolean(), available: Type.Boolean(),
    reason: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  }, { additionalProperties: false }),
}, { additionalProperties: false });
export const InferenceModesSchema = InferenceModesResponseSchema;
export type InferenceModesResponse = Static<typeof InferenceModesResponseSchema>;
export type InferenceModes = InferenceModesResponse;

const objectId = Type.String({ pattern: '^[a-fA-F0-9]{24}$' });
const timestamp = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' });
export const InspectionParamsSchema = Type.Object({ id: objectId }, { additionalProperties: false });
export const InspectionRequestSchema = Type.Object({
  assetId: objectId,
  provider: Type.Optional(ProviderConfigurationSchema),
  candidatePatch: Type.Optional(Type.Literal(true)),
}, { additionalProperties: false });
export const IdempotencyHeadersSchema = Type.Object({
  'idempotency-key': Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._-]+$' }),
});
export const InspectionStatusSchema = Type.Union([
  Type.Literal('queued'), Type.Literal('processing'), Type.Literal('completed'), Type.Literal('failed'),
]);
export const InspectionFailureSchema = Type.Object({
  code: Type.Union([
    Type.Literal('PROVIDER_UNAVAILABLE'), Type.Literal('PROVIDER_TIMEOUT'), Type.Literal('INFERENCE_FAILED'),
    Type.Literal('INVALID_INFERENCE_RESULT'), Type.Literal('INVALID_ASSET'), Type.Literal('ASSET_UNAVAILABLE'),
    Type.Literal('ATTEMPTS_EXHAUSTED'), Type.Literal('EXECUTION_INTERRUPTED'),
    Type.Literal('INVALID_INSPECTION'), Type.Literal('DATABASE_UNAVAILABLE'),
  ]),
  message: Type.String({ minLength: 1, maxLength: 200 }),
}, { additionalProperties: false });
export type InspectionFailure = Static<typeof InspectionFailureSchema>;

export const InspectionAcceptedSchema = Type.Object({
  id: objectId, status: InspectionStatusSchema, createdAt: timestamp,
  url: Type.String({ pattern: '^/api/v1/inspections/[a-f0-9]{24}$' }),
}, { additionalProperties: false });
export type InspectionAccepted = Static<typeof InspectionAcceptedSchema>;

const common = {
  id: objectId, assetId: objectId, createdAt: timestamp, updatedAt: timestamp,
  requested: ProviderConfigurationSchema,
  candidatePatch: Type.Optional(Type.Literal(true)),
  attemptCount: Type.Integer({ minimum: 0, maximum: 3 }),
  maxAttempts: Type.Integer({ minimum: 1, maximum: 3 }),
  retriedFrom: Type.Optional(objectId),
  processingStartedAt: Type.Optional(timestamp),
};
export const InspectionResponseSchema = Type.Union([
  Type.Object({ ...common, status: Type.Literal('queued'), nextAttemptAt: timestamp }, { additionalProperties: false }),
  Type.Object({ ...common, status: Type.Literal('processing') }, { additionalProperties: false }),
  Type.Object({ ...common, status: Type.Literal('completed'), completedAt: timestamp,
    processingDurationMs: Type.Number({ minimum: 0 }), result: InferenceResultSchema,
    review: Type.Optional(PersistedReviewSchema), reviewWriteSequence: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })) }, { additionalProperties: false }),
  Type.Object({ ...common, status: Type.Literal('failed'), completedAt: timestamp,
    latestRetryId: Type.Optional(objectId),
    failure: InspectionFailureSchema }, { additionalProperties: false }),
]);
export type InspectionResponse = Static<typeof InspectionResponseSchema>;

export const InspectionJobSchema = Type.Object({
  payloadVersion: Type.Literal('v1'), inspectionId: objectId,
  generation: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });
export type InspectionJob = Static<typeof InspectionJobSchema>;
