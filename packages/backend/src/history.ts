import { Types } from 'mongoose';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { DEFAULT_HISTORY_PAGE_SIZE, HistoryQuerySchema, InspectionStatusSchema, isInspectionHistoryResponse,
  type HistoryQuery, type InspectionHistoryResponse, type ProviderConfiguration } from '@vip/contracts';
import { type InspectionModel } from './inspection-model.js';
import { ApiError, databaseFailure } from './errors.js';

const CursorSchema = Type.Object({
  version: Type.Literal(1), createdAt: Type.String({ maxLength: 24 }), id: Type.String({ pattern: '^[a-f0-9]{24}$' }),
  status: Type.Union([InspectionStatusSchema, Type.Null()]),
}, { additionalProperties: false });
type Cursor = Static<typeof CursorSchema>;
function invalidCursor(): never { throw new ApiError(400, 'INVALID_CURSOR', 'This history cursor is invalid or belongs to another filter. Restart history browsing.'); }
function decodeCursor(value: string, status: HistoryQuery['status']): Cursor {
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) invalidCursor();
    const cursor: unknown = JSON.parse(bytes.toString('utf8'));
    if (!Value.Check(CursorSchema, cursor) || cursor.status !== (status ?? null)
      || new Date(cursor.createdAt).toISOString() !== cursor.createdAt) invalidCursor();
    return cursor;
  } catch { return invalidCursor(); }
}
export async function inspectionHistory(model: InspectionModel, query: HistoryQuery): Promise<InspectionHistoryResponse> {
  if (!Value.Check(HistoryQuerySchema, query)) throw new ApiError(400, 'INVALID_HISTORY_QUERY', 'History parameters are invalid.');
  const limit = Number(query.limit ?? DEFAULT_HISTORY_PAGE_SIZE);
  const cursor = query.cursor ? decodeCursor(query.cursor, query.status) : undefined;
  const match = {
    ...(query.status ? { status: query.status } : {}),
    ...(cursor ? { $or: [
      { createdAt: { $lt: new Date(cursor.createdAt) } },
      { createdAt: new Date(cursor.createdAt), _id: { $lt: new Types.ObjectId(cursor.id) } },
    ] } : {}),
  };
  try {
    // Count arrays in MongoDB; never transfer predictions or review snapshots to
    // the API process. Filtering, sorting, and limiting precede projection.
    const records = await model.aggregate<{
      _id: Types.ObjectId; assetId: Types.ObjectId; createdAt: Date; updatedAt: Date;
      status: string; retriedFrom?: Types.ObjectId; detectionCount?: number;
      reviewRevision?: number; failure?: unknown; requested?: ProviderConfiguration;
    }>([
      { $match: match }, { $sort: { createdAt: -1, _id: -1 } }, { $limit: limit + 1 },
      { $project: { _id: 1, assetId: 1, createdAt: 1, updatedAt: 1, status: 1, retriedFrom: 1, requested: 1,
        reviewRevision: '$review.revision',
        detectionCount: { $cond: [{ $eq: ['$status', 'completed'] }, { $size: '$result.detections' }, '$$REMOVE'] },
        failure: { $cond: [{ $eq: ['$status', 'failed'] }, { code: '$failure.code', message: '$failure.message' }, '$$REMOVE'] },
      } },
    ]).option({ maxTimeMS: 3000 }).exec();
    const items = records.slice(0, limit).map(record => ({
      id: record._id.toString(), assetId: record.assetId.toString(), status: record.status,
      createdAt: record.createdAt.toISOString(), updatedAt: record.updatedAt.toISOString(),
      previewUrl: `/api/v1/assets/${record.assetId.toString()}/content`,
      hasReview: record.status === 'completed' && record.reviewRevision !== undefined,
      ...(record.requested ? { requested: record.requested } : {}),
      ...(record.retriedFrom ? { retriedFrom: record.retriedFrom.toString() } : {}),
      ...(record.status === 'completed' ? { detectionCount: record.detectionCount,
        ...(record.reviewRevision !== undefined ? { reviewRevision: record.reviewRevision } : {}) } : {}),
      ...(record.status === 'failed' ? { failure: record.failure } : {}),
    }));
    const last = records[limit - 1];
    const hasMore = records.length > limit;
    const response = { items, hasMore, ...(hasMore && last ? { nextCursor: Buffer.from(JSON.stringify({
      version: 1, createdAt: last.createdAt.toISOString(), id: last._id.toString(), status: query.status ?? null,
    } satisfies Cursor)).toString('base64url') } : {}) };
    if (!isInspectionHistoryResponse(response)) throw databaseFailure();
    return response;
  } catch (cause) {
    if (cause instanceof ApiError) throw cause;
    throw databaseFailure(cause);
  }
}
