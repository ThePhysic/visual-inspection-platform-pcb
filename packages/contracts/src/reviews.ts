import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { BoundingBoxSchema, MAX_DETECTIONS, NORMALIZED_GEOMETRY_EPSILON, MOCK_LABELS, PCB_LABELS, labelsForTaxonomy } from './annotations.js';
import { isInferenceResult, type InferenceResult } from './inspections.js';

export const REVIEW_TAXONOMY_VERSION = 'mock-v1';
export const SAVE_OPERATION_PATTERN = '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$';
const integer = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const base = {
  id: Type.String({ minLength: 1, maxLength: 128 }),
  classId: Type.Enum([...MOCK_LABELS, ...PCB_LABELS].map(label => label.classId)),
  boundingBox: BoundingBoxSchema,
};
export const ReviewAnnotationSchema = Type.Union([
  Type.Object({ ...base, origin: Type.Literal('prediction'),
    predictionId: Type.String({ minLength: 1, maxLength: 80 }),
    disposition: Type.Union([Type.Literal('accepted'), Type.Literal('rejected')]),
  }, { additionalProperties: false }),
  Type.Object({ ...base, origin: Type.Literal('manual'), disposition: Type.Literal('accepted'),
    id: Type.String({ pattern: `^manual:${SAVE_OPERATION_PATTERN.slice(1)}` }),
  }, { additionalProperties: false }),
]);
const snapshot = {
  contractVersion: Type.Literal('v1'), taxonomyVersion: Type.Union([Type.Literal(REVIEW_TAXONOMY_VERSION), Type.Literal('pcb-ind-v4-1')]),
  annotations: Type.Array(ReviewAnnotationSchema, { maxItems: MAX_DETECTIONS }),
};
export const PersistedReviewSchema = Type.Object({ ...snapshot,
  revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  savedAt: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' }),
}, { additionalProperties: false });
export const SaveReviewRequestSchema = Type.Object({ ...snapshot,
  expectedRevision: integer, expectedWriteSequence: integer,
  operationId: Type.String({ pattern: SAVE_OPERATION_PATTERN }),
}, { additionalProperties: false });
export const SavedReviewResponseSchema = Type.Object({
  operationId: Type.String({ pattern: SAVE_OPERATION_PATTERN }),
  operationRevision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  writeSequence: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), review: PersistedReviewSchema,
  outcome: Type.Union([Type.Literal('saved'), Type.Literal('unchanged'), Type.Literal('replayed'), Type.Literal('superseded')]),
}, { additionalProperties: false });
const errorFields = { message: Type.String(), requestId: Type.String() };
export const ReviewValidationErrorResponseSchema = Type.Object({ error: Type.Object({ ...errorFields,
  code: Type.Union([Type.Literal('INVALID_REVIEW'), Type.Literal('INVALID_INSPECTION_ID'), Type.Literal('INVALID_REQUEST')]),
}, { additionalProperties: false }) }, { additionalProperties: false });
export const ReviewConflictResponseSchema = Type.Object({ error: Type.Object({ ...errorFields,
  code: Type.Union([Type.Literal('REVIEW_REVISION_CONFLICT'), Type.Literal('REVIEW_OPERATION_CONFLICT'), Type.Literal('INSPECTION_NOT_COMPLETED')]),
}, { additionalProperties: false }) }, { additionalProperties: false });
export type ReviewAnnotation = Static<typeof ReviewAnnotationSchema>;
export type PersistedReview = Static<typeof PersistedReviewSchema>;
export type SaveReviewRequest = Static<typeof SaveReviewRequestSchema>;
export type SavedReviewResponse = Static<typeof SavedReviewResponseSchema>;

// Structural validation alone cannot enforce box boundaries or prediction coverage.
export function validReviewAnnotations(annotations: readonly ReviewAnnotation[], result: InferenceResult): boolean {
  if (!isInferenceResult(result) || annotations.length > MAX_DETECTIONS) return false;
  const labels = labelsForTaxonomy(result.taxonomyVersion);
  if (!labels) return false;
  const ids = new Set<string>();
  const references = new Set<string>();
  const predictions = new Set(result.detections.map(prediction => prediction.id));
  for (const annotation of annotations) {
    if (!Value.Check(ReviewAnnotationSchema, annotation) || ids.has(annotation.id)
      || !labels.some(label => label.classId === annotation.classId)) return false;
    ids.add(annotation.id);
    const { x, y, width, height } = annotation.boundingBox;
    if (![x, y, width, height].every(Number.isFinite)
      || x + width > 1 + NORMALIZED_GEOMETRY_EPSILON || y + height > 1 + NORMALIZED_GEOMETRY_EPSILON) return false;
    if (annotation.origin === 'prediction') {
      if (annotation.id !== `prediction:${annotation.predictionId}` || !predictions.has(annotation.predictionId)
        || references.has(annotation.predictionId)) return false;
      references.add(annotation.predictionId);
    }
  }
  return references.size === predictions.size;
}
export function isPersistedReview(value: unknown): value is PersistedReview {
  if (!Value.Check(PersistedReviewSchema, value)) return false;
  const labels = labelsForTaxonomy(value.taxonomyVersion);
  if (!labels) return false;
  const ids = new Set<string>();
  return value.annotations.every(annotation => {
    const { x, y, width, height } = annotation.boundingBox;
    if (ids.has(annotation.id) || !labels.some(label => label.classId === annotation.classId)
      || ![x, y, width, height].every(Number.isFinite)
      || x + width > 1 + NORMALIZED_GEOMETRY_EPSILON || y + height > 1 + NORMALIZED_GEOMETRY_EPSILON) return false;
    ids.add(annotation.id);
    return true;
  });
}

export function isReviewForResult(value: unknown, result: unknown): value is PersistedReview {
  return isInferenceResult(result) && isPersistedReview(value) && value.taxonomyVersion === result.taxonomyVersion
    && validReviewAnnotations(value.annotations, result);
}
// Order is presentation-only. Fixed property order makes semantic equality and hashes stable.
export function canonicalReviewAnnotations(annotations: readonly ReviewAnnotation[]) {
  return [...annotations].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(annotation => ({
    id: annotation.id, origin: annotation.origin,
    ...(annotation.origin === 'prediction' ? { predictionId: annotation.predictionId } : {}),
    classId: annotation.classId, disposition: annotation.disposition,
    boundingBox: { x: annotation.boundingBox.x, y: annotation.boundingBox.y,
      width: annotation.boundingBox.width, height: annotation.boundingBox.height },
  }));
}
