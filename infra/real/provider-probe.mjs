import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

/**
 * Run before application/browser workloads so firstRequest is the first predict
 * after model readiness. Bundle/process loading is a separate startup boundary.
 * compose(args,{input}) must return stdout and reject unsuccessful commands.
 */
export async function runProviderProbe(compose) {
  const fixture = await readFile(new URL('../../fixtures/pcb/5810_t_007.jpg', import.meta.url));
  const script = `
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalizeImage } from './dist/images.js';
import { translatePcbPrediction, checkTrainedModelReadiness } from '@vip/backend';
import { PCB_CONFIGURATION } from '@vip/contracts';

assert.equal(await checkTrainedModelReadiness('http://inference:8000'), true, 'Pinned trained model must be ready');
const directory = await mkdtemp(join(tmpdir(), 'vip-pcb-probe-'));
try {
  const input = join(directory, 'input.jpg');
  const canonical = join(directory, 'canonical.jpg');
  await writeFile(input, Buffer.from(${JSON.stringify(fixture.toString('base64'))}, 'base64'));
  const metadata = await canonicalizeImage(input, canonical);
  assert.equal(metadata.width, 300); assert.equal(metadata.height, 300);
  const bytes = await readFile(canonical);
  const image = { ...metadata, bytes };
  async function predict() {
    const start = performance.now();
    const response = await fetch('http://inference:8000/v1/predict?threshold=0.2', {
      method: 'POST', headers: { 'Content-Type': metadata.mimeType }, body: bytes, signal: AbortSignal.timeout(8000),
    });
    assert.equal(response.headers.get('content-type')?.split(';', 1)[0], 'application/json');
    const reader = response.body.getReader();
    let size = 0; const chunks = [];
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 262144) { await reader.cancel(); throw new Error('Excessive provider response'); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    const payload = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    return { status: response.status, httpMs: performance.now() - start, payload };
  }
  const first = await predict();
  assert.equal(first.status, 200);
  const translated = translatePcbPrediction(first.payload, image, first.httpMs);
  assert.equal(translated.artifactDigest, PCB_CONFIGURATION.artifactDigest);
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => predict()));
  const success = concurrent.filter(item => item.status === 200);
  const busy = concurrent.filter(item => item.status === 503 && item.payload.error?.code === 'inference_busy');
  assert.ok(success.length >= 1, 'Concurrent batch must include an actual trained response');
  assert.ok(busy.length >= 1, 'Concurrent batch must exercise the actual inference_busy response');
  assert.equal(success.length + busy.length, 8, 'Unexpected provider response in concurrency probe');
  for (const item of success) translatePcbPrediction(item.payload, image, item.httpMs);
  console.log(JSON.stringify({
    response: first.payload, translated, canonicalImage: metadata,
    firstRequest: { httpMs: first.httpMs, scope: 'First predict after readiness; raw image transfer through JSON decode; excludes bundle/process startup and application queue' },
    busy: { concurrency: 8, total: concurrent.length, success: success.length, busy: busy.length,
      outcomes: concurrent.map(item => ({ status: item.status, code: item.payload.error?.code ?? 'trained', httpMs: item.httpMs })) },
  }));
} finally {
  await rm(directory, { recursive: true, force: true });
}
`;
  const output = await compose(['exec', '-T', '-w', '/app/apps/api', 'api', 'node', '--input-type=module', '-'], { input: script });
  const report = JSON.parse(output.trim());
  assert.equal(report.response.backend, 'trained');
  assert.equal(report.response.simulated, false);
  assert.ok(report.busy.busy > 0);
  const destination = new URL('../../docs/real-inference/', import.meta.url);
  await mkdir(destination, { recursive: true });
  await writeFile(new URL('python-response.json', destination), `${JSON.stringify(report.response, null, 2)}\n`);
  await writeFile(new URL('python-response-image.json', destination), `${JSON.stringify({
    source: 'fixtures/pcb/5810_t_007.jpg', canonicalization: 'Actual API canonicalizeImage JPEG settings',
    provenance: 'PCB-IND v4 training-set serving fixture, not holdout evidence', ...report.canonicalImage,
  }, null, 2)}\n`);
  return report;
}
