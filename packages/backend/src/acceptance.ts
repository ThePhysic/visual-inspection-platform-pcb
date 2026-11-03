import { createHash } from 'node:crypto';
import { Value } from 'typebox/value';
import {
  MOCK_CONFIGURATION, PCB_CONFIGURATION, INSPECTIONS_PATH, InspectionResponseSchema, isProviderConfiguration,
  isResultForConfiguration, isReviewForResult,
  type ProviderConfiguration, type InspectionResponse, type InspectionAccepted,
} from '@vip/contracts';
import { type InspectionModel, type InspectionRecord } from './inspection-model.js';
import { type AssetModel } from './database.js';
import { ApiError, databaseFailure } from './errors.js';

export interface InspectionDependencies { inspections: InspectionModel; assets: AssetModel; trainedEnabled?: boolean }

function fingerprint(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function existing(model: InspectionModel, scope: string, key: string, hash: string) {
  const record = await model.findOne({ requestScope: scope, requestKey: key }).lean().exec();
  if (record && record.requestFingerprint !== hash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'The idempotency key was used for a different request.');
  return record;
}

async function accept(
  dependencies: InspectionDependencies, scope: string, key: string, hash: string, requestId: string,
  prepare: () => Promise<{ assetId: string; requested: ProviderConfiguration; candidatePatch?: true; retriedFrom?: string }>,
) {
  try {
    const found = await existing(dependencies.inspections, scope, key, hash);
    if (found) return found;
    const data = await prepare();
    if (!await dependencies.assets.exists({ _id: data.assetId })) throw new ApiError(404, 'ASSET_NOT_FOUND', 'Asset not found.');
    try {
      const record = await dependencies.inspections.create({ ...data,
        requestScope: scope, requestKey: key, requestFingerprint: hash, requestId,
      });
      return record.toObject();
    } catch (cause) {
      if (cause instanceof Error && 'code' in cause && cause.code === 11000) {
        const winner = await existing(dependencies.inspections, scope, key, hash);
        if (winner) return winner;
      }
      throw cause;
    }
  } catch (cause) {
    if (cause instanceof ApiError) throw cause;
    throw databaseFailure(cause);
  }
}

export function acceptInspection(dependencies: InspectionDependencies, request: {
  assetId: string; provider?: ProviderConfiguration; candidatePatch?: true; key: string; requestId: string;
}) {
  const assetId = request.assetId.toLowerCase();
  const requested = request.provider ?? MOCK_CONFIGURATION;
  if (!isProviderConfiguration(requested)) throw new ApiError(400, 'INVALID_REQUEST', 'The selected inference configuration is unsupported.');
  // Reconstruct properties in a fixed order. Explicit defaults and omitted
  // defaults are the same semantic request; JSON field order is irrelevant.
  const configuration = requested.providerId === 'mock' ? { ...MOCK_CONFIGURATION } : { ...PCB_CONFIGURATION };
  const trained = configuration.providerId === PCB_CONFIGURATION.providerId;
  return accept(dependencies, 'inspection:create', request.key,
    fingerprint({ assetId, configuration, ...(trained ? { candidatePatch: request.candidatePatch === true } : {}) }), request.requestId,
    async () => {
      if (trained) {
        if (!dependencies.trainedEnabled) throw new ApiError(503, 'PROVIDER_UNAVAILABLE', 'Trained PCB inference is not enabled. Choose the simulated demo or enable the optional integration.');
        if (request.candidatePatch !== true) throw new ApiError(400, 'INVALID_ASSET', 'Trained inference requires an explicitly identified 300×300 PCB candidate patch.');
        const asset = await dependencies.assets.findById(assetId).select({ width: 1, height: 1 }).lean().exec();
        if (!asset) throw new ApiError(404, 'ASSET_NOT_FOUND', 'Asset not found.');
        if (asset.width !== 300 || asset.height !== 300) throw new ApiError(400, 'INVALID_ASSET', 'Trained inference supports only 300×300 PCB candidate patches; full-board inspection is unsupported.');
      }
      return { assetId, requested: configuration, ...(trained ? { candidatePatch: true as const } : {}) };
    });
}

export function retryInspection(dependencies: InspectionDependencies, request: {
  inspectionId: string; key: string; requestId: string;
}) {
  const inspectionId = request.inspectionId.toLowerCase();
  return accept(dependencies, 'inspection:retry', request.key,
    fingerprint({ inspectionId }), request.requestId, async () => {
      const previous = await dependencies.inspections.findById(inspectionId).lean().exec();
      if (!previous) throw new ApiError(404, 'INSPECTION_NOT_FOUND', 'Inspection not found.');
      if (previous.status !== 'failed') throw new ApiError(409, 'INSPECTION_NOT_FAILED', 'Only failed inspections may be retried.');
      if (!isProviderConfiguration(previous.requested)) throw new ApiError(503, 'DATABASE_FAILURE', 'The original inspection configuration is unavailable.');
      if (previous.requested.providerId === PCB_CONFIGURATION.providerId && previous.candidatePatch !== true) {
        throw new ApiError(503, 'DATABASE_FAILURE', 'The original candidate-patch admission is unavailable.');
      }
      return { assetId: previous.assetId.toString(), requested: previous.requested,
        ...(previous.candidatePatch === true ? { candidatePatch: true as const } : {}), retriedFrom: inspectionId };
    });
}

export function acceptedResponse(record: InspectionRecord): InspectionAccepted {
  const id = record._id.toString();
  return { id, status: record.status, createdAt: record.createdAt.toISOString(), url: `${INSPECTIONS_PATH}/${id}` };
}

export function inspectionResponse(record: InspectionRecord): InspectionResponse {
  if (record.status === 'completed' && !isResultForConfiguration(record.result, record.requested)) throw databaseFailure();
  if (record.review !== undefined && !isReviewForResult(record.review, record.result)) throw databaseFailure();
  const response = {
    id: record._id.toString(), assetId: record.assetId.toString(), status: record.status,
    createdAt: record.createdAt.toISOString(), updatedAt: record.updatedAt.toISOString(),
    requested: record.requested,
    ...(record.candidatePatch === true ? { candidatePatch: true } : {}),
    attemptCount: record.attemptCount, maxAttempts: record.maxAttempts,
    ...(record.retriedFrom ? { retriedFrom: record.retriedFrom.toString() } : {}),
    ...(record.processingStartedAt ? { processingStartedAt: record.processingStartedAt.toISOString() } : {}),
    ...(record.status === 'queued' ? { nextAttemptAt: record.nextAttemptAt.toISOString() } : {}),
    ...(record.status === 'completed' || record.status === 'failed' ? { completedAt: record.completedAt?.toISOString() } : {}),
    ...(record.status === 'completed' ? { result: record.result, processingDurationMs: record.processingDurationMs,
      reviewWriteSequence: record.reviewControl?.sequence ?? 0, ...(record.review ? { review: record.review } : {}) } : {}),
    ...(record.status === 'failed' ? { failure: record.failure } : {}),
  };
  if (!Value.Check(InspectionResponseSchema, response)) throw databaseFailure();
  return response;
}
