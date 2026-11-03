import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { PCB_CONFIGURATION, isInferenceResult } from '@vip/contracts';
import { PcbInferenceProvider, checkTrainedModelReadiness, readInferenceConfig, translatePcbPrediction } from '../src/pcb-provider.js';
import { type CanonicalImage } from '../src/provider.js';

// Hand-authored protocol fixture matching inspection_dl.schemas.Prediction.
// It tests translation only and is never represented as trained-model evidence.
function prediction() {
  return {
    schema_version: '1', provider: 'visual-inspection-dl', backend: 'trained', simulated: false,
    model_version: PCB_CONFIGURATION.modelVersion, taxonomy_version: PCB_CONFIGURATION.taxonomyVersion,
    artifact_digest: PCB_CONFIGURATION.artifactDigest, image: { width: 300, height: 300 },
    coordinate_system: 'xyxy_pixels_original_image', confidence_threshold: 0.2, nms_threshold: 0.55,
    invalid_predictions_rejected: 0,
    detections: [{ class_id: 1, label: 'mouse_bite', confidence: 0.87,
      box: { x_min: 1.123456789, y_min: 23.456789012, x_max: 299.987654321, y_max: 300 } }],
    timing_ms: { decode_preprocess: 2.3, model_inference: 54.1, response_postprocess: 0.4, request_total: 57.2 },
  };
}
function image(): CanonicalImage {
  const bytes = Buffer.from('protocol test image body; decoding belongs to Python');
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), width: 300, height: 300, mimeType: 'image/png' };
}
const closeServers: (() => Promise<void>)[] = [];
async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>(done => { server.listen(0, '127.0.0.1', done); });
  closeServers.push(() => new Promise<void>((done, reject) => {
    server.close(error => { if (error) reject(error); else done(); }); server.closeAllConnections();
  }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
function json(response: ServerResponse, payload: unknown, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(payload));
}
afterEach(async () => { for (const close of closeServers.splice(0)) await close(); });

describe('pinned Python-to-platform translation', () => {
  it('preserves precision, score, model provenance and distinct provider timing', () => {
    const value = prediction();
    const result = translatePcbPrediction(value, image(), 63.456);
    expect(isInferenceResult(result)).toBe(true);
    expect(result).toMatchObject({ ...PCB_CONFIGURATION, simulated: false, backend: 'trained', durationMs: 63.456,
      providerTimingMs: { decodePreprocess: 2.3, modelInference: 54.1, responsePostprocess: 0.4, requestTotal: 57.2 } });
    expect(result.detections[0]).toMatchObject({ classId: 'mouse_bite', label: 'mouse_bite', confidence: 0.87,
      boundingBox: { x: 1.123456789 / 300, y: 23.456789012 / 300,
        width: (299.987654321 - 1.123456789) / 300, height: (300 - 23.456789012) / 300 } });
  });
  it.each([[40, 80], [80, 40], [300, 300]])('uses canonical oriented dimensions %ix%i including complete edges', (width, height) => {
    const value = prediction(); value.image = { width, height };
    value.detections[0]!.box = { x_min: 0, y_min: 0, x_max: width, y_max: height };
    const result = translatePcbPrediction(value, { ...image(), width, height }, 1);
    expect(result.detections[0]?.boundingBox).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });
  it('accepts empty predictions and stabilizes ordering and bounded unique identifiers', () => {
    const empty = prediction(); empty.detections = [];
    expect(translatePcbPrediction(empty, image(), 1).detections).toEqual([]);
    const value = prediction();
    value.detections.push({ ...value.detections[0]!, confidence: 0.94 });
    value.detections.push(structuredClone(value.detections[0]!));
    const first = translatePcbPrediction(value, image(), 1).detections;
    const second = translatePcbPrediction({ ...value, detections: [...value.detections].reverse() }, image(), 9).detections;
    expect(first).toEqual(second);
    expect(new Set(first.map(item => item.id)).size).toBe(3);
    expect(first.every(item => item.id.length <= 80)).toBe(true);
  });
  it.each([
    ['dimension', (p: ReturnType<typeof prediction>) => { p.image.width = 301; }],
    ['digest', (p: ReturnType<typeof prediction>) => { p.artifact_digest = '0'.repeat(64) as typeof p.artifact_digest; }],
    ['model', (p: ReturnType<typeof prediction>) => { p.model_version = 'future' as typeof p.model_version; }],
    ['taxonomy', (p: ReturnType<typeof prediction>) => { p.taxonomy_version = 'future' as typeof p.taxonomy_version; }],
    ['provider', (p: ReturnType<typeof prediction>) => { p.provider = 'other'; }],
    ['fixture', (p: ReturnType<typeof prediction>) => { p.backend = 'fixture'; p.simulated = true; }],
    ['unknown class', (p: ReturnType<typeof prediction>) => { p.detections[0]!.class_id = 9; }],
    ['label mismatch', (p: ReturnType<typeof prediction>) => { p.detections[0]!.label = 'scratch'; }],
    ['threshold', (p: ReturnType<typeof prediction>) => { p.confidence_threshold = 0.1; }],
    ['NMS', (p: ReturnType<typeof prediction>) => { p.nms_threshold = 0.8; }],
    ['below threshold', (p: ReturnType<typeof prediction>) => { p.detections[0]!.confidence = 0.1; }],
    ['NaN', (p: ReturnType<typeof prediction>) => { p.detections[0]!.box.x_min = NaN; }],
    ['Infinity', (p: ReturnType<typeof prediction>) => { p.detections[0]!.confidence = Infinity; }],
    ['timing Infinity', (p: ReturnType<typeof prediction>) => { p.timing_ms.request_total = Infinity; }],
    ['negative', (p: ReturnType<typeof prediction>) => { p.detections[0]!.box.x_min = -1; }],
    ['outside', (p: ReturnType<typeof prediction>) => { p.detections[0]!.box.x_max = 300.001; }],
    ['inverted', (p: ReturnType<typeof prediction>) => { p.detections[0]!.box.x_min = 300; }],
    ['zero area', (p: ReturnType<typeof prediction>) => { p.detections[0]!.box.y_min = 300; }],
    ['too many', (p: ReturnType<typeof prediction>) => { p.detections = Array.from({ length: 101 }, () => p.detections[0]!); }],
  ])('rejects incompatible %s payloads terminally', (_name, mutate) => {
    const value = prediction(); mutate(value);
    expect(() => translatePcbPrediction(value, image(), 1)).toThrow('INVALID_INFERENCE_RESULT');
  });
  it('rejects unknown fields rather than silently changing the versioned response contract', () => {
    expect(() => translatePcbPrediction({ ...prediction(), surprise: true }, image(), 1)).toThrow('INVALID_INFERENCE_RESULT');
  });
});

describe('bounded real HTTP adapter', () => {
  it('sends exact raw canonical bytes, MIME and pinned threshold over HTTP', async () => {
    let seen: Buffer | undefined;
    const asset = image();
    const url = await serve((request, response) => {
      expect(request.method).toBe('POST'); expect(request.url).toBe('/v1/predict?threshold=0.2');
      expect(request.headers['content-type']).toBe('image/png');
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      request.on('end', () => { seen = Buffer.concat(chunks); json(response, prediction()); });
    });
    expect((await new PcbInferenceProvider({ url }).infer(asset, new AbortController().signal)).simulated).toBe(false);
    expect(seen).toEqual(asset.bytes);
  });
  it.each([400, 413, 415, 422, 404])('classifies HTTP %i as terminal', async status => {
    const url = await serve((_request, response) => { json(response, { error: { code: 'permanent' } }, status); });
    await expect(new PcbInferenceProvider({ url }).infer(image(), new AbortController().signal)).rejects.toMatchObject({ retryable: false });
  });
  it.each([408, 429, 500, 502, 503, 504])('classifies HTTP %i as retryable without client retry loops', async status => {
    let calls = 0;
    const url = await serve((_request, response) => { calls++; json(response, { error: { code: 'inference_busy' } }, status); });
    await expect(new PcbInferenceProvider({ url }).infer(image(), new AbortController().signal)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE', retryable: true, ...(status === 503 ? { providerOutcome: 'busy' } : {}),
    });
    expect(calls).toBe(1);
  });
  it('bounds elapsed time and propagates caller cancellation', async () => {
    const url = await serve(() => {});
    await expect(new PcbInferenceProvider({ url, timeoutMs: 30 }).infer(image(), new AbortController().signal)).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT', retryable: true,
    });
    const abort = new AbortController();
    const pending = new PcbInferenceProvider({ url }).infer(image(), abort.signal);
    abort.abort(new Error('caller cancelled'));
    await expect(pending).rejects.toThrow('caller cancelled');
  });
  it('classifies an actual refused TCP connection as retryable without invoking a fallback', async () => {
    const url = await serve(() => {});
    await closeServers.pop()!(); // Keep the allocated origin, but remove its listener.
    await expect(new PcbInferenceProvider({ url }).infer(image(), new AbortController().signal)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE', retryable: true, providerOutcome: 'unavailable',
    });
  });
  it.each(['complete malformed JSON', 'interrupted TCP response'] as const)(
    'distinguishes a %s body from a provider contract failure', async kind => {
      const url = await serve((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json',
          ...(kind === 'interrupted TCP response' ? { 'Content-Length': '1000' } : {}) });
        response.flushHeaders(); response.write('{"schema_version":');
        if (kind === 'interrupted TCP response') setTimeout(() => { response.destroy(); }, 10);
        else response.end();
      });
      await expect(new PcbInferenceProvider({ url }).infer(image(), new AbortController().signal)).rejects.toMatchObject(
        kind === 'interrupted TCP response'
          ? { code: 'PROVIDER_UNAVAILABLE', retryable: true, providerOutcome: 'unavailable' }
          : { code: 'INVALID_INFERENCE_RESULT', retryable: false, providerOutcome: 'invalid_response' },
      );
    },
  );
  it.each(['malformed', 'excessive', 'streamed excessive', 'wrong media type'])('rejects %s successful responses terminally', async kind => {
    const url = await serve((_request, response) => {
      if (kind === 'malformed') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{'); }
      else if (kind === 'excessive') { response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 300000 }); response.end('x'); }
      else if (kind === 'streamed excessive') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('x'.repeat(270000)); response.end(); }
      else { response.writeHead(200, { 'Content-Type': 'text/plain' }); response.end('{}'); }
    });
    await expect(new PcbInferenceProvider({ url }).infer(image(), new AbortController().signal)).rejects.toMatchObject({
      code: 'INVALID_INFERENCE_RESULT', retryable: false,
    });
  });
  it('rejects unverified bytes and unsupported dimensions before calling the service', async () => {
    const url = await serve(() => { throw new Error('must not call'); });
    for (const asset of [{ ...image(), width: 1000 }, { ...image(), sha256: '0'.repeat(64) }]) {
      await expect(new PcbInferenceProvider({ url }).infer(asset, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_ASSET', retryable: false });
    }
  });
});

describe('trained readiness and fail-closed configuration', () => {
  it('requires explicit enabling and a safe service origin', () => {
    expect(readInferenceConfig({})).toEqual({ enabled: false, timeoutMs: 8000 });
    expect(readInferenceConfig({ PCB_INFERENCE_ENABLED: 'true', PCB_INFERENCE_URL: 'http://inference:8000/' }))
      .toEqual({ enabled: true, url: 'http://inference:8000', timeoutMs: 8000 });
    expect(() => readInferenceConfig({ PCB_INFERENCE_ENABLED: 'true' })).toThrow('PCB_INFERENCE_URL is required');
    expect(() => readInferenceConfig({ PCB_INFERENCE_ENABLED: 'yes' })).toThrow('must be true or false');
    for (const url of ['file:///tmp/model', 'http://user:secret@host', 'http://host/path', 'http://host?secret=yes']) {
      expect(() => readInferenceConfig({ PCB_INFERENCE_ENABLED: 'true', PCB_INFERENCE_URL: url })).toThrow('HTTP origin');
    }
  });
  it.each(['valid', 'fixture', 'wrong digest', 'wrong classes', 'unready'])('checks loaded backend and complete release identity: %s', async kind => {
    const url = await serve((request, response) => {
      if (request.url === '/ready') {
        json(response, { ready: kind !== 'unready', backend: kind === 'fixture' ? 'fixture' : 'trained',
          simulated: kind === 'fixture', model_version: PCB_CONFIGURATION.modelVersion }); return;
      }
      json(response, { schema_version: '1', backend: 'trained', simulated: false,
        model_version: PCB_CONFIGURATION.modelVersion, taxonomy_version: PCB_CONFIGURATION.taxonomyVersion,
        artifact_digest: kind === 'wrong digest' ? '0'.repeat(64) : PCB_CONFIGURATION.artifactDigest,
        architecture: 'ssdlite320_mobilenet_v3_large', preprocessing: 'ssdlite320_rgb_unit_v1',
        coordinate_system: 'xyxy_pixels_original_image', confidence_threshold: 0.2, nms_threshold: 0.55, max_detections: 100,
        classes: ['mouse_bite', 'missing_copper', 'scratch', 'spurious_copper', 'copper_burr', 'stain', 'short', 'open']
          .map((name, index) => ({ id: index + 1, name: kind === 'wrong classes' && index === 0 ? 'other' : name })),
      });
    });
    expect(await checkTrainedModelReadiness(url)).toBe(kind === 'valid');
  });
});
