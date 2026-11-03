import {
  HEALTH_PATH, ASSETS_PATH, INSPECTIONS_PATH, isHealthResponse, isResultForConfiguration,
  AssetResponseSchema, InspectionAcceptedSchema, InspectionResponseSchema, ApiErrorResponseSchema,
  type HealthResponse, type AssetResponse, type InspectionAccepted, type InspectionResponse,
  SavedReviewResponseSchema, isPersistedReview, validReviewAnnotations, type SaveReviewRequest, type SavedReviewResponse,
  isInspectionHistoryResponse, type HistoryQuery, type InspectionHistoryResponse,
  InferenceModesResponseSchema, type InferenceModesResponse, type ProviderConfiguration,
} from '@vip/contracts';
import { Value } from 'typebox/value';

const errorMessages: Record<string, string> = {
  INVALID_CURSOR: 'This history page is no longer usable. Restart history browsing.',
  INVALID_HISTORY_QUERY: 'The history parameters are invalid. Restart history browsing.',
  INSPECTION_NOT_FAILED: 'This inspection is no longer eligible for retry. Refresh its status.',
  INVALID_REVIEW: 'The review is invalid. Check the annotations before trying again.',
  REVIEW_REVISION_CONFLICT: 'A newer review exists. Your local changes have been retained.',
  REVIEW_OPERATION_CONFLICT: 'This save operation conflicts with an earlier request. Load the latest review before continuing.',
  INSPECTION_NOT_COMPLETED: 'Only completed inspections can be reviewed.',
  CORRUPT_IMAGE: 'This image could not be decoded. Choose a valid JPEG or PNG.',
  UNSUPPORTED_IMAGE_TYPE: 'This image format is not supported. Choose a JPEG or PNG.',
  MULTIFRAME_IMAGE: 'Animated and multipage images are not supported.',
  UPLOAD_TOO_LARGE: 'The image exceeds the 10 MiB upload limit.',
  IMAGE_DIMENSIONS_EXCEEDED: 'The image exceeds the 20 megapixel limit.',
  ASSET_NOT_FOUND: 'The uploaded image could not be found. Select and upload the image again.',
  INSPECTION_NOT_FOUND: 'This inspection could not be found. Check the link or start a new inspection.',
  IDEMPOTENCY_CONFLICT: 'This submission conflicts with an earlier request. Select the image again to start a new submission.',
  INGESTION_BUSY: 'Image uploading is busy. Please try again.',
  TRAINED_MODE_UNAVAILABLE: 'The trained PCB model is unavailable. Check model availability and try again.',
  INVALID_CANDIDATE_PATCH: 'Trained mode requires an explicitly identified 300 × 300 PCB candidate patch. Choose a supported patch or use the simulated demo.',
};

export class ApiClientError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status?: number, readonly code?: string) { super(message); }
}

async function requestJson(path: string, expectedStatus: number, options: RequestInit = {}, timeout = 10_000): Promise<unknown> {
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
  try {
    const response = await fetch(path, { ...options, signal, headers: { Accept: 'application/json', ...options.headers } });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const code = Value.Check(ApiErrorResponseSchema, body) ? body.error.code : '';
      throw new ApiClientError(errorMessages[code] ?? (response.status >= 500
        ? 'The service is temporarily unavailable. Please try again.' : 'The request was rejected. Check your image or link.'),
      response.status >= 500 || response.status === 408 || response.status === 429, response.status, code);
    }
    if (response.status !== expectedStatus || body === undefined) throw new ApiClientError('The service returned an incompatible response. Please try again.', true);
    return body;
  } catch (error) {
    if (error instanceof ApiClientError) throw error;
    throw new ApiClientError('Could not reach the service. Check your connection and try again.', true);
  }
}

function incompatible(): never { throw new ApiClientError('The service returned an incompatible response. Please try again.', true); }

export async function uploadAsset(file: File, signal: AbortSignal): Promise<AssetResponse> {
  const form = new FormData();
  form.append('image', file);
  form.append('source', 'browser');
  const body = await requestJson(ASSETS_PATH, 201, { method: 'POST', body: form, signal }, 45_000);
  if (!Value.Check(AssetResponseSchema, body)) incompatible();
  return body;
}

export async function submitInspection(assetId: string, key: string, signal: AbortSignal,
  provider?: ProviderConfiguration, candidatePatch?: true): Promise<InspectionAccepted> {
  const body = await requestJson(INSPECTIONS_PATH, 202, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ assetId, ...(provider ? { provider } : {}), ...(candidatePatch ? { candidatePatch } : {}) }), signal,
  });
  if (!Value.Check(InspectionAcceptedSchema, body) || body.url !== `${INSPECTIONS_PATH}/${body.id}`) incompatible();
  return body;
}

export async function fetchInferenceModes(signal: AbortSignal): Promise<InferenceModesResponse> {
  const body = await requestJson('/api/v1/inference-modes', 200, { signal }, 5000);
  if (!Value.Check(InferenceModesResponseSchema, body) || (body.trained.available && !body.trained.enabled)) incompatible();
  return body;
}

export async function fetchInspection(id: string, signal: AbortSignal): Promise<InspectionResponse> {
  const body = await requestJson(`${INSPECTIONS_PATH}/${id}`, 200, { signal });
  if (!Value.Check(InspectionResponseSchema, body) || body.id !== id.toLowerCase()
    || (body.status === 'completed' && (!isResultForConfiguration(body.result, body.requested) || (body.review !== undefined
      && (!isPersistedReview(body.review) || body.review.taxonomyVersion !== body.result.taxonomyVersion
        || !validReviewAnnotations(body.review.annotations, body.result)))))) incompatible();
  return body;
}

export async function fetchAsset(id: string, signal: AbortSignal): Promise<AssetResponse> {
  const body = await requestJson(`${ASSETS_PATH}/${id}`, 200, { signal });
  if (!Value.Check(AssetResponseSchema, body) || body.id !== id.toLowerCase()
    || body.contentUrl !== `${ASSETS_PATH}/${body.id}/content`) incompatible();
  return body;
}

export async function fetchHealth(signal: AbortSignal): Promise<HealthResponse> {
  const response = await fetch(HEALTH_PATH, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`Health check failed (HTTP ${response.status}).`);
  }

  const body: unknown = await response.json();
  if (!isHealthResponse(body)) {
    throw new Error('The API returned an incompatible health response.');
  }

  return body;
}

export async function saveReview(id: string, request: SaveReviewRequest, signal: AbortSignal): Promise<SavedReviewResponse> {
  const body = await requestJson(`${INSPECTIONS_PATH}/${id}/review`, 200, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal,
  });
  if (!Value.Check(SavedReviewResponseSchema, body) || body.operationId !== request.operationId
    || body.operationRevision < 1 || body.operationRevision > body.review.revision) incompatible();
  return body;
}

export async function fetchHistory(query: HistoryQuery, signal: AbortSignal): Promise<InspectionHistoryResponse> {
  const parameters = new URLSearchParams();
  if (query.status) parameters.set('status', query.status);
  if (query.cursor) parameters.set('cursor', query.cursor);
  if (query.limit) parameters.set('limit', query.limit);
  const body = await requestJson(`${INSPECTIONS_PATH}?${parameters.toString()}`, 200, { signal });
  if (!isInspectionHistoryResponse(body) || (query.status && body.items.some(item => item.status !== query.status))) incompatible();
  return body;
}

export async function retryInspection(id: string, key: string, signal: AbortSignal): Promise<InspectionAccepted> {
  try {
    const body = await requestJson(`${INSPECTIONS_PATH}/${id}/retry`, 202, {
      method: 'POST', headers: { 'Idempotency-Key': key }, signal,
    });
    if (!Value.Check(InspectionAcceptedSchema, body) || body.url !== `${INSPECTIONS_PATH}/${body.id}` || body.id === id) incompatible();
    return body;
  } catch (cause) {
    if (cause instanceof ApiClientError && cause.code === 'IDEMPOTENCY_CONFLICT') {
      throw new ApiClientError('This retry conflicts with an earlier request. Reopen the failed inspection before starting another retry.', false, 409, cause.code);
    }
    throw cause;
  }
}
