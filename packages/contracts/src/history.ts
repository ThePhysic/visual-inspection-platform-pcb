import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { InspectionFailureSchema, InspectionStatusSchema, MAX_DETECTIONS, ProviderConfigurationSchema } from './inspections.js';

export const DEFAULT_HISTORY_PAGE_SIZE = 20;
export const MAX_HISTORY_PAGE_SIZE = 50;
export type InspectionStatus = Static<typeof InspectionStatusSchema>;
export const HistoryQuerySchema = Type.Object({
  // Query parameters remain strings: the API deliberately disables coercion.
  limit: Type.Optional(Type.String({ pattern: '^([1-9]|[1-4][0-9]|50)$' })),
  status: Type.Optional(InspectionStatusSchema),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512, pattern: '^[A-Za-z0-9_-]+$' })),
}, { additionalProperties: false });
export type HistoryQuery = Static<typeof HistoryQuerySchema>;
const id = Type.String({ pattern: '^[a-f0-9]{24}$' });
const timestamp = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' });
const common = {
  id, assetId: id, createdAt: timestamp, updatedAt: timestamp,
  previewUrl: Type.String({ pattern: '^/api/v1/assets/[a-f0-9]{24}/content$' }),
  retriedFrom: Type.Optional(id),
  requested: Type.Optional(ProviderConfigurationSchema),
};
export const InspectionSummarySchema = Type.Union([
  Type.Object({ ...common, status: Type.Union([Type.Literal('queued'), Type.Literal('processing')]),
    hasReview: Type.Literal(false) }, { additionalProperties: false }),
  Type.Object({ ...common, status: Type.Literal('completed'),
    detectionCount: Type.Integer({ minimum: 0, maximum: MAX_DETECTIONS }), hasReview: Type.Boolean(),
    reviewRevision: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  }, { additionalProperties: false }),
  Type.Object({ ...common, status: Type.Literal('failed'), hasReview: Type.Literal(false), failure: InspectionFailureSchema },
    { additionalProperties: false }),
]);
export const InspectionHistoryResponseSchema = Type.Object({
  items: Type.Array(InspectionSummarySchema, { maxItems: MAX_HISTORY_PAGE_SIZE }),
  hasMore: Type.Boolean(), nextCursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512, pattern: '^[A-Za-z0-9_-]+$' })),
}, { additionalProperties: false });
export type InspectionSummary = Static<typeof InspectionSummarySchema>;
export type InspectionHistoryResponse = Static<typeof InspectionHistoryResponseSchema>;
export function isInspectionHistoryResponse(value: unknown): value is InspectionHistoryResponse {
  if (!Value.Check(InspectionHistoryResponseSchema, value) || value.hasMore !== Boolean(value.nextCursor)
    || (value.hasMore && value.items.length === 0)) return false;
  const ids = new Set<string>();
  return value.items.every(item => {
    if (ids.has(item.id) || item.previewUrl !== `/api/v1/assets/${item.assetId}/content`
      || (item.status === 'completed' && item.hasReview !== (item.reviewRevision !== undefined))) return false;
    ids.add(item.id); return true;
  });
}
