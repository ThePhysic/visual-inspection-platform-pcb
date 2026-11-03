import { createHash } from 'node:crypto';
import { Value } from 'typebox/value';
import {
  SaveReviewRequestSchema, canonicalReviewAnnotations, isResultForConfiguration, isReviewForResult,
  validReviewAnnotations, type SaveReviewRequest, type PersistedReview, type SavedReviewResponse,
} from '@vip/contracts';
import { type InspectionModel, type InspectionRecord } from './inspection-model.js';
import { ApiError } from './errors.js';

export const REVIEW_RECEIPT_LIMIT = 32;
function conflict(): never { throw new ApiError(409, 'REVIEW_REVISION_CONFLICT', 'A newer review exists. Load the latest saved review before saving.'); }
function currentReview(record: InspectionRecord): PersistedReview | undefined {
  if (record.status !== 'completed') throw new ApiError(409, 'INSPECTION_NOT_COMPLETED', 'Only completed inspections can be reviewed.');
  if (!isResultForConfiguration(record.result, record.requested) || (record.review !== undefined
    && !isReviewForResult(record.review, record.result))) {
    throw new ApiError(503, 'DATABASE_FAILURE', 'The inspection is unavailable for review.');
  }
  return record.review as PersistedReview | undefined;
}
function replay(record: InspectionRecord, request: SaveReviewRequest, fingerprint: string): SavedReviewResponse | undefined {
  const receipt = record.reviewControl?.operations?.find(operation => operation.operationId === request.operationId);
  if (!receipt) return;
  if (receipt.fingerprint !== fingerprint) throw new ApiError(409, 'REVIEW_OPERATION_CONFLICT', 'This save operation was already used with different content.');
  const review = currentReview(record);
  if (!review) throw new ApiError(503, 'DATABASE_FAILURE', 'The saved review is unavailable.');
  return { operationId: request.operationId, operationRevision: receipt.revision,
    writeSequence: record.reviewControl?.sequence ?? 0, review,
    outcome: review.revision > receipt.revision ? 'superseded' : 'replayed' };
}
export async function saveReview(model: InspectionModel, inspectionId: string, request: SaveReviewRequest): Promise<SavedReviewResponse> {
  if (!Value.Check(SaveReviewRequestSchema, request)) throw new ApiError(400, 'INVALID_REVIEW', 'The review payload is invalid.');
  try {
    const record = await model.findById(inspectionId).lean().exec();
    if (!record) throw new ApiError(404, 'INSPECTION_NOT_FOUND', 'Inspection not found.');
    const previous = currentReview(record);
    if (request.taxonomyVersion !== record.result.taxonomyVersion || !validReviewAnnotations(request.annotations, record.result)) {
      throw new ApiError(400, 'INVALID_REVIEW', 'Review annotations must use the supported taxonomy, valid boxes, and exactly one disposition per original prediction.');
    }
    const annotations = canonicalReviewAnnotations(request.annotations);
    const fingerprint = createHash('sha256').update(JSON.stringify({
      contractVersion: request.contractVersion, taxonomyVersion: request.taxonomyVersion,
      expectedRevision: request.expectedRevision, expectedWriteSequence: request.expectedWriteSequence, annotations,
    })).digest('hex');
    const repeated = replay(record, request, fingerprint);
    if (repeated) return repeated;
    if ((previous?.revision ?? 0) !== request.expectedRevision || (record.reviewControl?.sequence ?? 0) !== request.expectedWriteSequence) conflict();
    const unchanged = previous && JSON.stringify(canonicalReviewAnnotations(previous.annotations)) === JSON.stringify(annotations);
    const now = new Date();
    const review: PersistedReview = unchanged ? previous : {
      contractVersion: 'v1', taxonomyVersion: request.taxonomyVersion, revision: (previous?.revision ?? 0) + 1,
      savedAt: now.toISOString(), annotations: request.annotations,
    };
    if (!Number.isSafeInteger(review.revision) || request.expectedWriteSequence === Number.MAX_SAFE_INTEGER) conflict();
    const updated = await model.findOneAndUpdate({
      _id: record._id, status: 'completed',
      ...(request.expectedRevision === 0 ? { review: { $exists: false } } : { 'review.revision': request.expectedRevision }),
      ...(request.expectedWriteSequence === 0
        ? { $or: [{ reviewControl: { $exists: false } }, { 'reviewControl.sequence': 0 }] }
        : { 'reviewControl.sequence': request.expectedWriteSequence }),
      'reviewControl.operations.operationId': { $ne: request.operationId },
    }, {
      $set: { ...(unchanged ? {} : { review }), updatedAt: now },
      $inc: { 'reviewControl.sequence': 1 },
      $push: { 'reviewControl.operations': { $each: [{ operationId: request.operationId, fingerprint,
        revision: review.revision, writeSequence: request.expectedWriteSequence + 1 }], $slice: -REVIEW_RECEIPT_LIMIT } },
    }, { returnDocument: 'after', runValidators: true }).lean().exec();
    if (!updated) {
      const winner = await model.findById(inspectionId).lean().exec();
      if (!winner) throw new ApiError(404, 'INSPECTION_NOT_FOUND', 'Inspection not found.');
      const duplicate = replay(winner, request, fingerprint);
      if (duplicate) return duplicate;
      conflict();
    }
    return { operationId: request.operationId, operationRevision: review.revision,
      writeSequence: updated.reviewControl?.sequence ?? 0, review, outcome: unchanged ? 'unchanged' : 'saved' };
  } catch (cause) {
    if (cause instanceof ApiError) throw cause;
    throw new ApiError(503, 'DATABASE_FAILURE', 'Review persistence is temporarily unavailable.', { cause });
  }
}
