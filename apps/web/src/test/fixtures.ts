import { MOCK_CONFIGURATION, PCB_CONFIGURATION, PCB_LABELS, type AssetResponse, type InferenceResult, type InspectionResponse } from '@vip/contracts';

export const assetId = '0123456789abcdef01234567';
export const inspectionId = 'abcdef0123456789abcdef01';
export const timestamp = '2026-10-20T00:00:00.000Z';
export const asset: AssetResponse = {
  id: assetId, mimeType: 'image/png', width: 640, height: 320, byteLength: 1024,
  sha256: 'a'.repeat(64), source: 'browser', createdAt: timestamp, contentUrl: `/api/v1/assets/${assetId}/content`,
};
export const result: InferenceResult = {
  contractVersion: 'v1', ...MOCK_CONFIGURATION, taxonomyVersion: 'mock-v1', simulated: true, durationMs: 0,
  detections: [
    { id: 'prediction-1', classId: 'surface-mark', label: 'Surface mark', confidence: 0.94,
      boundingBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } },
    { id: 'prediction-2', classId: 'edge-defect', label: 'Edge defect', confidence: 0.85,
      boundingBox: { x: 0.5, y: 0.1, width: 0.2, height: 0.25 } },
  ],
};
export const pcbResult: InferenceResult = {
  contractVersion: 'v1', ...PCB_CONFIGURATION, backend: 'trained', simulated: false, durationMs: 80,
  providerTimingMs: { decodePreprocess: 1, modelInference: 54, responsePostprocess: 2, requestTotal: 60 },
  detections: PCB_LABELS.map((entry, index) => ({ ...entry, id: `pcb-${index + 1}`, confidence: 0.8,
    boundingBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } })),
};
const common = { id: inspectionId, assetId, createdAt: timestamp, updatedAt: timestamp,
  requested: MOCK_CONFIGURATION, attemptCount: 1, maxAttempts: 3 };
export const queued: InspectionResponse = { ...common, status: 'queued', nextAttemptAt: timestamp };
export const processing: InspectionResponse = { ...common, status: 'processing', processingStartedAt: timestamp };
export const completed: Extract<InspectionResponse, { status: 'completed' }> = { ...common, status: 'completed', processingStartedAt: timestamp,
  completedAt: timestamp, processingDurationMs: 12, result };
export const pcbCompleted: Extract<InspectionResponse, { status: 'completed' }> = { ...completed, requested: PCB_CONFIGURATION, result: pcbResult };
export const failed: InspectionResponse = { ...common, status: 'failed', completedAt: timestamp,
  failure: { code: 'INFERENCE_FAILED', message: 'Inference failed.' } };
export const accepted = { id: inspectionId, status: 'queued', createdAt: timestamp, url: `/api/v1/inspections/${inspectionId}` };
export function apiError(code: string, status: number) {
  return Response.json({ error: { code, message: 'Do not show arbitrary server details', requestId: 'test' } }, { status });
}
