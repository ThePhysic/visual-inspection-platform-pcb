import { createHash } from 'node:crypto';
import { MOCK_CONFIGURATION, MOCK_LABELS, type InferenceResult, type InspectionFailure } from '@vip/contracts';

export interface CanonicalImage {
  bytes: Uint8Array;
  sha256: string;
  mimeType: 'image/jpeg' | 'image/png';
  width: number;
  height: number;
}

export interface InferenceProvider {
  infer(image: CanonicalImage, signal: AbortSignal): Promise<unknown>;
}

export class InferenceError extends Error {
  constructor(public readonly code: InspectionFailure['code'], public readonly retryable: boolean,
    public readonly providerOutcome?: 'busy' | 'timeout' | 'unavailable' | 'invalid_response' | 'invalid_image' | 'request_rejected') {
    super(code);
    this.name = 'InferenceError';
  }
}

// Filled with checksums of the documented, canonical synthetic demo fixtures.
export const MOCK_FIXTURES = {
  panel: '9b28b8449555da30966b470b427c4286a7fcca8980754d2953861f9c31c5119c',
  empty: '4a09cda5ec3277cffac23a1dbbdcf646fc904ad159f55cfe4ff7ad3fcc6e979d',
  machinedPanel: '3742c0d92581fab163671ec34b267f27b4c4097b94bb459adb4285bb4cf328a3',
  cleanPanel: '5db9cbe881289d08905a6cbb4338228751fc5ce69bd899df27c9af3b4d420f77',
  edgeComponent: 'cc8c6adb5b9ee5a7f2cb5b0ed96cb0d0a7ffe38259187035435b1eae6a4accd9',
};

// Hand-authored regions for original illustrations, deliberately imperfect for
// human-review demonstrations. Existing fixtures and arbitrary-image fallback
// keep their original output. These are not learned predictions or ground truth.
const portfolioDetections: Record<string, Array<Omit<InferenceResult['detections'][number], 'id'>>> = {
  [MOCK_FIXTURES.machinedPanel]: [
    { ...MOCK_LABELS[1], confidence: 0.86, boundingBox: { x: 430 / 1200, y: 300 / 800, width: 290 / 1200, height: 125 / 800 } },
    { ...MOCK_LABELS[1], confidence: 0.91, boundingBox: { x: 1000 / 1200, y: 390 / 800, width: 90 / 1200, height: 130 / 800 } },
    { ...MOCK_LABELS[0], confidence: 0.62, boundingBox: { x: 185 / 1200, y: 145 / 800, width: 70 / 1200, height: 70 / 800 } },
  ],
  [MOCK_FIXTURES.cleanPanel]: [],
  [MOCK_FIXTURES.edgeComponent]: [
    { ...MOCK_LABELS[1], confidence: 0.89, boundingBox: { x: 550 / 800, y: 430 / 1100, width: 95 / 800, height: 150 / 1100 } },
  ],
};

export class MockInferenceProvider implements InferenceProvider {
  async infer(image: CanonicalImage, signal: AbortSignal): Promise<InferenceResult> {
    signal.throwIfAborted();
    const sha256 = createHash('sha256').update(image.bytes).digest('hex');
    const seed = createHash('sha256').update(image.bytes).update(MOCK_CONFIGURATION.modelVersion).digest();
    const count = sha256 === MOCK_FIXTURES.empty ? 0 : sha256 === MOCK_FIXTURES.panel ? 1 : seed[0]! % 3;
    return {
      contractVersion: 'v1', ...MOCK_CONFIGURATION, taxonomyVersion: 'mock-v1', simulated: true,
      // The mock does not claim a measured model runtime. Worker wall time is
      // recorded separately on the inspection, outside deterministic predictions.
      durationMs: 0,
      detections: portfolioDetections[sha256]?.map((detection, index) => ({
        ...detection, boundingBox: { ...detection.boundingBox }, id: `mock-v1-${sha256.slice(0, 16)}-${index}`,
      })) ?? Array.from({ length: count }, (_, index) => ({
        id: `mock-v1-${sha256.slice(0, 16)}-${index}`,
        ...MOCK_LABELS[index % MOCK_LABELS.length]!,
        confidence: sha256 === MOCK_FIXTURES.panel ? 0.94 : (75 + seed[index + 1]! % 20) / 100,
        boundingBox: sha256 === MOCK_FIXTURES.panel
          ? { x: 12 / 64, y: 16 / 64, width: 20 / 64, height: 12 / 64 }
          : { x: (5 + seed[index + 4]! % 50) / 100, y: (5 + seed[index + 6]! % 50) / 100, width: 0.2, height: 0.2 },
      })),
    };
  }
}
