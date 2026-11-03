import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { compatibility } from './verify-release.mjs';
import { observeQueuedFailure } from './observe-retry.mjs';

/** Hold the real service's normal admission lock with an incomplete, valid upload. */
export async function holdRealModelBusy(compose) {
  const token = randomUUID().replaceAll('-', '');
  const marker = `VIP_REAL_MODEL_BUSY_${token}`;
  const gate = `/tmp/vip-real-busy-${token}/release`;
  const fixture = await readFile(new URL('../../fixtures/pcb/5810_t_007.jpg', import.meta.url));
  let resolveReady; let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const script = `
import assert from 'node:assert/strict';
import http from 'node:http';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { canonicalizeImage } from './dist/images.js';
import { translatePcbPrediction } from '@vip/backend';
import { PCB_CONFIGURATION } from '@vip/contracts';
const directory = '/tmp/vip-real-busy-${token}';
const gate = ${JSON.stringify(gate)};
await mkdir(directory, { mode: 0o700 });
let request;
let watchdog;
let finished;
try {
  await writeFile(directory + '/source.jpg', Buffer.from(${JSON.stringify(fixture.toString('base64'))}, 'base64'));
  const metadata = await canonicalizeImage(directory + '/source.jpg', directory + '/canonical.jpg');
  const bytes = await readFile(directory + '/canonical.jpg');
  const started = performance.now();
  finished = new Promise((resolve, reject) => {
    request = http.request('http://inference:8000/v1/predict?threshold=0.2', { method: 'POST', agent: false,
      headers: { 'Content-Type': metadata.mimeType, 'Content-Length': bytes.byteLength, Connection: 'close' } }, response => {
      let size = 0; const chunks = [];
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 262144) { response.destroy(); reject(new Error('Busy holder response exceeded its bound')); }
        else chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('end', () => {
        try {
          assert.equal(response.statusCode, 200);
          const payload = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
          const result = translatePcbPrediction(payload, metadata, performance.now() - started);
          assert.equal(result.artifactDigest, PCB_CONFIGURATION.artifactDigest);
          resolve({ status: response.statusCode, backend: result.backend, simulated: result.simulated,
            artifactDigest: result.artifactDigest, heldUploadThroughResponseMs: performance.now() - started });
        } catch (error) { reject(error); }
      });
    });
    request.once('error', reject);
    request.flushHeaders();
    request.write(bytes.subarray(0, 1));
  });
  // Always observe a connection failure even before the host reaches release.
  void finished.catch(() => {});
  watchdog = setTimeout(() => { request.destroy(new Error('Busy holder exceeded its 25 second bound')); }, 25_000);
  const probeDeadline = Date.now() + 4000;
  let observedBusy = false;
  while (Date.now() < probeDeadline) {
    const probe = await fetch('http://inference:8000/v1/predict?threshold=0.2', {
      method: 'POST', headers: { 'Content-Type': metadata.mimeType }, body: bytes,
      signal: AbortSignal.timeout(2000),
    });
    const text = await probe.text(); assert.ok(text.length <= 4096, 'Unexpected busy probe payload bound');
    const payload = JSON.parse(text);
    if (probe.status === 503 && payload.error?.code === 'inference_busy') { observedBusy = true; break; }
    assert.equal(probe.status, 200, 'Unexpected service outcome while waiting for the held upload');
    await pause(20);
  }
  assert.ok(observedBusy, 'The actual model must report typed inference_busy before the application submission');
  console.log(${JSON.stringify(marker)});
  const releaseDeadline = Date.now() + 20_000;
  let released = false;
  while (Date.now() < releaseDeadline) {
    try { await access(gate); released = true; break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await pause(25);
  }
  assert.ok(released, 'The host must release the held upload before the service body deadline');
  request.end(bytes.subarray(1));
  const result = await finished;
  console.log(JSON.stringify({ ...result, typedBusyObserved: true }));
} finally {
  clearTimeout(watchdog);
  request?.destroy();
  await finished?.catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
`;
  const running = compose(['exec', '-T', '-w', '/app/apps/api', 'api', 'node', '--input-type=module', '-'], {
    input: script, timeout: 35_000,
    onOutput(output) { if (output.split('\n').some(line => line.trim() === marker)) resolveReady(); },
  });
  void running.then(() => { rejectReady(new Error('Busy holder exited before application observation')); }, rejectReady);
  let releasing;
  const release = () => {
    releasing ??= (async () => {
      await compose(['exec', '-T', 'api', 'node', '-e', "require('node:fs').writeFileSync(process.argv[1], 'release')", gate], { timeout: 5000 });
      const output = await running;
      const result = JSON.parse(output.trim().split('\n').at(-1));
      assert.equal(result.status, 200); assert.equal(result.simulated, false);
      assert.equal(result.backend, 'trained'); assert.equal(result.artifactDigest, compatibility.artifactDigest);
      return result;
    })();
    return releasing;
  };
  const close = async () => { await release().catch(() => {}); await running.catch(() => {}); };
  try { await ready; return { release, close }; }
  catch (error) { await close(); throw error; }
}

export async function runRealBusyApplicationRetry({ test, submit, getInspection, completed, assetId }) {
  const holder = await holdRealModelBusy(test.compose);
  try {
    const accepted = await submit(assetId);
    const retry = await observeQueuedFailure(test.compose, accepted.id, 'PROVIDER_UNAVAILABLE', 8000);
    const publicRecord = await getInspection(accepted.id);
    assert.equal(publicRecord.result, undefined);
    assert.notEqual(publicRecord.status, 'failed', 'Busy work must retain the remaining finite application budget');
    const heldRequest = await holder.release();
    const recovered = await completed(accepted.id);
    assert.ok(recovered.attemptCount >= 2 && recovered.attemptCount <= 3);
    assert.deepEqual(recovered.requested, retry.requested);
    assert.equal(recovered.result.simulated, false);
    assert.equal(recovered.result.artifactDigest, compatibility.artifactDigest);
    const events = (await test.compose(['logs', '--no-color', '--no-log-prefix', 'worker'])).split('\n')
      .flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const busyAttempt = events.find(event => event.inspectionId === accepted.id && event.providerOutcome === 'busy'
      && event.failureCode === 'PROVIDER_UNAVAILABLE');
    assert.ok(busyAttempt, 'A correlated worker event must prove typed busy classification, not another unavailable condition');
    return { inspectionId: recovered.id, observedBusyAttempt: retry.attemptCount, recoveredAttemptCount: recovered.attemptCount,
      failureCode: retry.failure.code, providerOutcome: busyAttempt.providerOutcome, noResultBeforeRecovery: true,
      failureObservation: 'Private durable MongoDB projection; queued public DTOs intentionally omit failure details.',
      pinnedProviderPreserved: true, heldRequest,
      scope: 'A bounded incomplete genuine JPEG upload holds normal Python admission. Typed inference_busy traverses the real worker HTTP adapter, consumes an application attempt, then recovers through the existing backoff. This fault case is excluded from performance samples.' };
  } finally { await holder.close(); }
}
