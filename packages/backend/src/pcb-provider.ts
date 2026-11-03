import { createHash } from 'node:crypto';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { PCB_CONFIGURATION, PCB_LABELS, isResultForConfiguration, type InferenceResult } from '@vip/contracts';
import { InferenceError, type CanonicalImage, type InferenceProvider } from './provider.js';

const MAX_RESPONSE_BYTES = 256 * 1024;
const finiteMilliseconds = Type.Number({ minimum: 0 });
const timingSchema = Type.Object({
  decode_preprocess: finiteMilliseconds, model_inference: finiteMilliseconds,
  response_postprocess: finiteMilliseconds, request_total: finiteMilliseconds,
}, { additionalProperties: false });
const responseSchema = Type.Object({
  schema_version: Type.Literal('1'), provider: Type.Literal('visual-inspection-dl'),
  backend: Type.Literal('trained'), simulated: Type.Literal(false),
  model_version: Type.Literal(PCB_CONFIGURATION.modelVersion),
  taxonomy_version: Type.Literal(PCB_CONFIGURATION.taxonomyVersion),
  artifact_digest: Type.Literal(PCB_CONFIGURATION.artifactDigest),
  image: Type.Object({ width: Type.Integer({ minimum: 1 }), height: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }),
  coordinate_system: Type.Literal('xyxy_pixels_original_image'),
  confidence_threshold: Type.Literal(PCB_CONFIGURATION.confidenceThreshold), nms_threshold: Type.Literal(0.55),
  invalid_predictions_rejected: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  detections: Type.Array(Type.Object({
    class_id: Type.Integer({ minimum: 1, maximum: 8 }), label: Type.String({ minLength: 1, maxLength: 128 }),
    confidence: Type.Number({ minimum: 0.2, maximum: 1 }),
    box: Type.Object({ x_min: Type.Number({ minimum: 0 }), y_min: Type.Number({ minimum: 0 }),
      x_max: Type.Number({ exclusiveMinimum: 0 }), y_max: Type.Number({ exclusiveMinimum: 0 }) }, { additionalProperties: false }),
  }, { additionalProperties: false }), { maxItems: 100 }),
  timing_ms: timingSchema,
}, { additionalProperties: false });

function invalidResponse(): never { throw new InferenceError('INVALID_INFERENCE_RESULT', false, 'invalid_response'); }

// This translation uses the canonical oriented raster, never the model's 320px
// internal tensor. Keeping it independent permits testing non-square geometry.
export function translatePcbPrediction(value: unknown, image: Pick<CanonicalImage, 'width' | 'height' | 'sha256'>,
  durationMs: number): InferenceResult {
  if (!Value.Check(responseSchema, value) || value.image.width !== image.width || value.image.height !== image.height
    || !Number.isFinite(durationMs) || durationMs < 0 || !Object.values(value.timing_ms).every(Number.isFinite)
    || !Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1
    || !/^[a-f0-9]{64}$/.test(image.sha256)) invalidResponse();
  const detections = value.detections.map(detection => {
    const label = PCB_LABELS[detection.class_id - 1];
    const { x_min, y_min, x_max, y_max } = detection.box;
    if (!label || label.label !== detection.label || ![x_min, y_min, x_max, y_max, detection.confidence].every(Number.isFinite)
      || x_min >= x_max || y_min >= y_max || x_max > image.width || y_max > image.height) invalidResponse();
    return { classId: label.classId, label: label.label, confidence: detection.confidence,
      boundingBox: { x: x_min / image.width, y: y_min / image.height,
        width: (x_max - x_min) / image.width, height: (y_max - y_min) / image.height } };
  });
  // Canonical ordering makes IDs stable even if equal provider detections arrive
  // in a different array order. The index distinguishes identical detections.
  detections.sort((a, b) => a.classId.localeCompare(b.classId, 'en') || b.confidence - a.confidence
    || a.boundingBox.x - b.boundingBox.x || a.boundingBox.y - b.boundingBox.y
    || a.boundingBox.width - b.boundingBox.width || a.boundingBox.height - b.boundingBox.height);
  const result: InferenceResult = {
    contractVersion: 'v1', providerId: PCB_CONFIGURATION.providerId, modelId: PCB_CONFIGURATION.modelId,
    modelVersion: PCB_CONFIGURATION.modelVersion, taxonomyVersion: PCB_CONFIGURATION.taxonomyVersion,
    simulated: false, backend: 'trained', artifactDigest: PCB_CONFIGURATION.artifactDigest,
    confidenceThreshold: PCB_CONFIGURATION.confidenceThreshold, durationMs,
    providerTimingMs: { decodePreprocess: value.timing_ms.decode_preprocess, modelInference: value.timing_ms.model_inference,
      responsePostprocess: value.timing_ms.response_postprocess, requestTotal: value.timing_ms.request_total },
    detections: detections.map((detection, index) => ({ ...detection,
      id: `pcb-v1-${createHash('sha256').update(image.sha256).update(JSON.stringify(detection)).digest('hex').slice(0, 32)}-${index}` })),
  };
  if (!isResultForConfiguration(result, PCB_CONFIGURATION)) invalidResponse();
  return result;
}

async function readJson(response: Response, maximumBytes = MAX_RESPONSE_BYTES): Promise<unknown> {
  if (response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    await response.body?.cancel(); invalidResponse();
  }
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) {
    await response.body?.cancel(); invalidResponse();
  }
  if (!response.body) invalidResponse();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) { await reader.cancel(); invalidResponse(); }
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown; }
    catch { invalidResponse(); }
  } finally { reader.releaseLock(); }
}

function serviceUrl(value: string) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password
      || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error();
    return url;
  } catch { throw new Error('PCB_INFERENCE_URL must be an HTTP origin without credentials, query, or path.'); }
}

export function readInferenceConfig(env: NodeJS.ProcessEnv) {
  if (env.PCB_INFERENCE_ENABLED !== undefined && !['true', 'false'].includes(env.PCB_INFERENCE_ENABLED)) {
    throw new Error('PCB_INFERENCE_ENABLED must be true or false.');
  }
  const enabled = env.PCB_INFERENCE_ENABLED === 'true';
  if (enabled && !env.PCB_INFERENCE_URL) throw new Error('PCB_INFERENCE_URL is required when trained inference is enabled.');
  const url = env.PCB_INFERENCE_URL ? serviceUrl(env.PCB_INFERENCE_URL).origin : undefined;
  const timeoutMs = 8000;
  return { enabled, ...(url ? { url } : {}), timeoutMs };
}

export class PcbInferenceProvider implements InferenceProvider {
  private readonly url: URL;
  private readonly timeoutMs: number;
  constructor(configuration: { url: string; timeoutMs?: number }) {
    this.url = serviceUrl(configuration.url);
    this.timeoutMs = configuration.timeoutMs ?? 8000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 8000) {
      throw new Error('Trained HTTP timeout must be between 1 and 8000 milliseconds.');
    }
  }
  async infer(image: CanonicalImage, signal: AbortSignal): Promise<InferenceResult> {
    signal.throwIfAborted();
    if (image.width !== 300 || image.height !== 300 || image.bytes.byteLength < 1 || image.bytes.byteLength > 8 * 1024 * 1024
      || !['image/jpeg', 'image/png'].includes(image.mimeType)
      || createHash('sha256').update(image.bytes).digest('hex') !== image.sha256) throw new InferenceError('INVALID_ASSET', false, 'invalid_image');
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    const started = performance.now();
    try {
      const endpoint = new URL('/v1/predict', this.url);
      endpoint.searchParams.set('threshold', String(PCB_CONFIGURATION.confidenceThreshold));
      const response = await fetch(endpoint, { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': image.mimeType, Accept: 'application/json' },
        body: Buffer.from(image.bytes), signal: combined });
      if (!response.ok) {
        let busy = false;
        if (response.status === 503) {
          try {
            const error = await readJson(response, 4096);
            busy = typeof error === 'object' && error !== null && 'error' in error
              && typeof error.error === 'object' && error.error !== null && 'code' in error.error && error.error.code === 'inference_busy';
          } catch { /* Error payloads are optional; only bounded status/code is used. */ }
        } else await response.body?.cancel();
        if (response.status >= 500 || [408, 429].includes(response.status)) {
          throw new InferenceError('PROVIDER_UNAVAILABLE', true, busy ? 'busy' : 'unavailable');
        }
        if ([400, 413, 415].includes(response.status)) throw new InferenceError('INVALID_ASSET', false, 'invalid_image');
        throw new InferenceError('INFERENCE_FAILED', false, 'request_rejected');
      }
      const payload = await readJson(response);
      return translatePcbPrediction(payload, image, Math.max(0, performance.now() - started));
    } catch (cause) {
      if (signal.aborted) throw signal.reason;
      if (timeout.aborted) throw new InferenceError('PROVIDER_TIMEOUT', true, 'timeout');
      if (cause instanceof InferenceError) throw cause;
      throw new InferenceError('PROVIDER_UNAVAILABLE', true, 'unavailable');
    }
  }
}

// Availability is separate from worker health and durable admission. An outage
// hides trained selection but never discards an already accepted inspection.
export async function checkTrainedModelReadiness(url: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const origin = serviceUrl(url);
    const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(2000)]) : AbortSignal.timeout(2000);
    const readyResponse = await fetch(new URL('/ready', origin), { signal: bounded, redirect: 'error' });
    if (!readyResponse.ok) { await readyResponse.body?.cancel(); return false; }
    const ready = await readJson(readyResponse, 4096);
    if (typeof ready !== 'object' || ready === null || !('ready' in ready) || ready.ready !== true
      || !('backend' in ready) || ready.backend !== 'trained' || !('simulated' in ready) || ready.simulated !== false
      || !('model_version' in ready) || ready.model_version !== PCB_CONFIGURATION.modelVersion) return false;
    const modelResponse = await fetch(new URL('/v1/model', origin), { signal: bounded, redirect: 'error' });
    if (!modelResponse.ok) { await modelResponse.body?.cancel(); return false; }
    const model = await readJson(modelResponse);
    if (typeof model !== 'object' || model === null) return false;
    const data = model as Record<string, unknown>;
    return data.schema_version === '1' && data.backend === 'trained' && data.simulated === false
      && data.model_version === PCB_CONFIGURATION.modelVersion && data.taxonomy_version === PCB_CONFIGURATION.taxonomyVersion
      && data.artifact_digest === PCB_CONFIGURATION.artifactDigest && data.architecture === 'ssdlite320_mobilenet_v3_large'
      && data.preprocessing === 'ssdlite320_rgb_unit_v1' && data.coordinate_system === 'xyxy_pixels_original_image'
      && data.confidence_threshold === PCB_CONFIGURATION.confidenceThreshold && data.nms_threshold === 0.55 && data.max_detections === 100
      && Array.isArray(data.classes) && data.classes.length === PCB_LABELS.length
      && data.classes.every((item: unknown, index: number) => typeof item === 'object' && item !== null
        && 'id' in item && item.id === index + 1 && 'name' in item && item.name === PCB_LABELS[index]?.label);
  } catch { return false; }
}
