import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { platform, release, cpus, totalmem } from 'node:os';
import { setTimeout as pause } from 'node:timers/promises';
import { command, pnpmCommand, root } from '../docker/disposable.mjs';
import { compatibility, verifyRelease } from './verify-release.mjs';
import { runProviderProbe } from './provider-probe.mjs';
import { realEnvironment, waitForFreshHealthyService } from './environment.mjs';
import { runRealBusyApplicationRetry } from './busy-probe.mjs';
import { runSlowModelRecovery } from './slow-probe.mjs';

const flags = new Set(process.argv.slice(2));
assert.ok([...flags].every(flag => ['--ci-mongodb', '--keep'].includes(flag)), 'Use optional --ci-mongodb / --keep');
const verifiedRelease = await verifyRelease(); // Pin/source/digests checked before Docker mutation.
const provider = { providerId: 'visual-inspection-dl', modelId: 'pcb-ind-ssdlite', modelVersion: compatibility.release,
  taxonomyVersion: compatibility.taxonomy, artifactDigest: compatibility.artifactDigest, confidenceThreshold: compatibility.threshold };
const test = await realEnvironment({ ciMongoCompatibility: flags.has('--ci-mongodb'), dlDirectory: verifiedRelease.dlRoot });
const directory = resolve(root, 'docs/real-inference');
await mkdir(directory, { recursive: true });
const report = { schemaVersion: 'v1', startedAt: new Date().toISOString(), project: test.project, passed: false,
  compatibility, host: { os: platform(), release: release(), node: process.version,
    cpu: cpus()[0]?.model, logicalCPUs: cpus().length, memoryBytes: totalmem() },
  methodology: { samples: 30, concurrency: 1, observationPollingMs: 100,
    scope: 'Sequential full application HTTP workflow: upload through durable create, worker/model execution and GET-observed completion. Browser-visible measurements are separate artifacts with 2000ms UI polling.',
    workloads: 'Four attributed 300×300 PCB-IND patches cycled; three frozen holdout examples and one training-set serving smoke. This is performance sampling, not model evaluation.',
    percentiles: 'Nearest rank p50/p95; no p99/SLA claim from 30 samples.', temperature: 'Warmed after provider busy probe and real browser workflow.' },
  checks: {}, samples: [], errors: [], resourceSamples: [] };

async function json(path, expected = 200, options = {}) {
  const response = await fetch(`${test.baseURL}${path}`, { ...options,
    signal: AbortSignal.timeout(15_000), headers: { Accept: 'application/json', ...options.headers } });
  const body = await response.json();
  assert.equal(response.status, expected, `Unexpected HTTP status at ${path}: ${response.status}; code=${body.error?.code ?? 'none'}`);
  return body;
}
async function until(check, label, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check(); if (value) return value;
    await pause(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function upload(file) {
  const form = new FormData();
  form.append('image', new Blob([await readFile(resolve(root, 'fixtures/pcb', file))], { type: 'image/jpeg' }), file);
  form.append('source', 'browser');
  return json('/api/v1/assets', 201, { method: 'POST', body: form });
}
const submit = (assetId, key = randomUUID()) => json('/api/v1/inspections', 202, { method: 'POST',
  headers: { 'content-type': 'application/json', 'idempotency-key': key },
  body: JSON.stringify({ assetId, provider, candidatePatch: true }) });
const getInspection = id => json(`/api/v1/inspections/${id}`);
const completed = id => until(async () => {
  const record = await getInspection(id);
  assert.notEqual(record.status, 'failed', `Trained inspection ${id} failed: ${record.failure?.code}`);
  if (record.status !== 'completed') return false;
  assert.equal(record.result.simulated, false); assert.equal(record.result.backend, 'trained');
  assert.equal(record.result.artifactDigest, compatibility.artifactDigest);
  assert.equal(record.result.modelVersion, compatibility.release);
  assert.deepEqual(record.requested, provider);
  return record;
}, `trained completion ${id}`);
function summary(values) {
  assert.ok(values.length > 0 && values.every(Number.isFinite));
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, min: sorted[0], p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1], max: sorted.at(-1) };
}
async function resourceSnapshot(phase) {
  const ids = (await test.verifyOwnership()).map(container => container.Id);
  const stats = await command('docker', ['stats', '--no-stream', '--format', '{{json .}}', ...ids]);
  report.resourceSamples.push({ phase, observedAt: new Date().toISOString(), containers: stats.split('\n').filter(Boolean).map(line => JSON.parse(line)) });
}
async function saveReport() { await writeFile(resolve(directory, 'acceptance.json'), JSON.stringify(report, null, 2) + '\n'); }

console.log(`Isolated real-model acceptance: ${test.project}; ${test.baseURL}`);
try {
  report.platformRevisionAtRun = await command('git', ['rev-parse', 'HEAD']);
  report.platformTrackedChangesAtRun = (await command('git', ['status', '--porcelain', '--untracked-files=no'])).split('\n').filter(Boolean).length;
  const dockerInfo = JSON.parse(await command('docker', ['info', '--format', '{{json .}}']));
  report.dockerEnvironment = Object.fromEntries(['NCPU', 'MemTotal', 'OperatingSystem', 'KernelVersion', 'Architecture', 'OSType', 'ServerVersion'].map(key => [key, dockerInfo[key]]));
  await test.compose(['config', '--quiet']);
  const buildStarted = performance.now();
  await test.compose(['build'], { echo: true, timeout: 900_000 });
  report.buildMs = performance.now() - buildStarted;
  const startupStarted = performance.now();
  await test.compose(['up', '-d', '--wait', '--wait-timeout', '180'], { echo: true, timeout: 240_000 });
  report.stackCreationThroughHealthMs = performance.now() - startupStarted;
  await test.verifyMongoCompatibility();
  const containers = await test.verifyOwnership(); assert.equal(containers.length, 6);
  for (const container of containers) {
    const service = container.Config.Labels['com.docker.compose.service'];
    const bindings = Object.values(container.HostConfig.PortBindings ?? {}).flat();
    if (service === 'web') {
      assert.equal(bindings.length, 1); assert.equal(bindings[0].HostIp, '127.0.0.1');
      assert.equal(bindings[0].HostPort, new URL(test.baseURL).port);
    } else assert.equal(bindings.length, 0, `${service} must not publish a host port`);
    if (service === 'inference') {
      assert.ok(container.Config.User && !['0', 'root'].includes(container.Config.User));
      assert.equal(container.HostConfig.DeviceRequests?.length ?? 0, 0);
      assert.ok(container.Config.Env.includes('INSPECTION_DL_DEVICE=cpu'));
      assert.ok(container.Config.Env.includes('INSPECTION_DL_BACKEND=trained'));
      report.inferenceContainer = { user: container.Config.User, device: 'cpu', hostPublishedPorts: 0,
        readOnlyBundle: container.Mounts.find(mount => mount.Destination === '/models/pcb-ind-ssdlite-v1').RW === false };
    }
  }
  // This must be the first /predict after readiness, before browser or benchmarks.
  report.providerProbe = await runProviderProbe(test.compose);
  report.checks.actualReleasedCpuInference = true;
  report.checks.busyResponse = true;
  await resourceSnapshot('after-provider-probe');
  await until(async () => (await json('/api/v1/inference-modes')).trained.available, 'background trained availability observation');
  await pnpmCommand(['--filter', '@vip/web', 'test:trained'], { env: test.environment, echo: true, timeout: 360_000 });
  report.checks.actualBrowserReview = true;
  const browser = JSON.parse(await readFile(resolve(directory, 'browser-workflow.json'), 'utf8'));
  assert.match(browser.inspectionId, /^[a-f0-9]{24}$/);
  const browserRecord = await getInspection(browser.inspectionId);
  assert.equal(browserRecord.review.revision, 2);
  report.browserWorkflow = browser;
  report.browserWarmed = JSON.parse(await readFile(resolve(directory, 'browser-warmed.json'), 'utf8'));
  // Exercise the existing mock workflow against the same opt-in six-service
  // stack, proving that enabling trained inference preserves the demo.
  await pnpmCommand(['--filter', '@vip/web', 'exec', 'playwright', 'test', '--config', 'playwright.container.config.ts'], {
    env: test.environment, echo: true, timeout: 240_000,
  });
  report.checks.existingContainerBrowser = true;

  const fixtures = ['5810_t_007.jpg', '6581_b_043.jpg', '6529_t_006.jpg', '6040_b_034.jpg'];
  let resourceProbe;
  const batchStarted = performance.now();
  for (let index = 0; index < 30; index++) {
    const started = performance.now(); const file = fixtures[index % fixtures.length];
    try {
      const asset = await upload(file); const uploadAcceptedMs = performance.now() - started;
      const createStarted = performance.now(); const accepted = await submit(asset.id);
      const creationAcceptedMs = performance.now() - createStarted;
      const record = await completed(accepted.id);
      report.samples.push({ index, fixture: file, inspectionId: record.id,
        uploadAcceptedMs, creationAcceptedMs, uploadThroughObservedResultMs: performance.now() - started,
        queueWaitMs: Date.parse(record.processingStartedAt) - Date.parse(record.createdAt),
        workerProcessingMs: record.processingDurationMs, providerHttpMs: record.result.durationMs,
        pythonTimingMs: record.result.providerTimingMs, detectionCount: record.result.detections.length,
        requested: record.requested, result: record.result, completedAt: record.completedAt, attemptCount: record.attemptCount });
    } catch (error) { report.errors.push({ phase: 'benchmark', index, message: String(error).slice(0, 300) }); throw error; }
    if (index === 14) resourceProbe = resourceSnapshot('benchmark-midpoint').then(() => undefined, error => error);
  }
  report.batchMs = performance.now() - batchStarted;
  const resourceFailure = await resourceProbe; if (resourceFailure) throw resourceFailure;
  report.requestsPerSecond = report.samples.length / (report.batchMs / 1000);
  const workerLogs = await test.compose(['logs', '--no-color', '--no-log-prefix', 'worker']);
  const events = workerLogs.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  for (const sample of report.samples) {
    const event = events.find(entry => entry.inspectionId === sample.inspectionId && entry.msg === 'Inspection completed');
    assert.ok(event && Number.isFinite(event.commitDurationMs), 'Missing correlated result-commit duration');
    sample.commitDurationMs = event.commitDurationMs;
  }
  report.latencySummaryMs = Object.fromEntries(['uploadAcceptedMs', 'creationAcceptedMs', 'queueWaitMs', 'workerProcessingMs', 'providerHttpMs', 'commitDurationMs', 'uploadThroughObservedResultMs']
    .map(key => [key, summary(report.samples.map(sample => sample[key]))]));
  report.pythonLatencySummaryMs = Object.fromEntries(['decodePreprocess', 'modelInference', 'responsePostprocess', 'requestTotal']
    .map(key => [key, summary(report.samples.map(sample => sample.pythonTimingMs[key]))]));
  report.benchmarkErrorRate = report.errors.length / 30;
  report.benchmarkBusyRate = 0; // Verified below from actual correlated attempt outcomes.
  const sampleIds = new Set(report.samples.map(sample => sample.inspectionId));
  const busyAttempts = events.filter(event => sampleIds.has(event.inspectionId) && event.providerOutcome === 'busy').length;
  report.benchmarkBusyRate = busyAttempts / report.samples.reduce((count, sample) => count + sample.attemptCount, 0);
  report.checks.thirtyRepresentativeWorkflows = true;
  await resourceSnapshot('after-benchmark');

  const outageAsset = await upload(fixtures[0]);
  report.realBusyApplicationRetry = await runRealBusyApplicationRetry({ test, submit, getInspection, completed, assetId: outageAsset.id });
  report.checks.realBusyApplicationRetry = true;
  await test.disruptive(['stop', 'inference']);
  await until(async () => !(await json('/api/v1/inference-modes')).trained.available, 'model unavailable observation');
  await json('/api/v1/ready');
  const outageAccepted = await submit(outageAsset.id);
  const failed = await until(async () => { const record = await getInspection(outageAccepted.id); return record.status === 'failed' && record; }, 'three-attempt model outage failure');
  assert.equal(failed.attemptCount, 3); assert.equal(failed.result, undefined); assert.deepEqual(failed.requested, provider);
  await test.disruptive(['start', 'inference']);
  await until(async () => (await json('/api/v1/inference-modes')).trained.available, 'trained model readiness');
  const retry = await json(`/api/v1/inspections/${failed.id}/retry`, 202, { method: 'POST', headers: { 'idempotency-key': randomUUID() } });
  const retryRecord = await completed(retry.id); assert.equal(retryRecord.retriedFrom, failed.id);
  assert.deepEqual(retryRecord.requested, failed.requested);
  report.outage = { failedInspectionId: failed.id, failure: failed.failure, attempts: failed.attemptCount,
    apiStayedReady: true, acceptedWhileUnavailable: true, retryInspectionId: retryRecord.id };
  report.checks.outageExhaustionAndLinkedRetry = true;

  report.slowModelRecovery = await runSlowModelRecovery({ test, submit, getInspection, completed, outageAssetId: outageAsset.id });
  report.checks.realSlowApplicationRecovery = true;

  await test.disruptive(['stop', 'worker']);
  const heldKey = randomUUID(); const held = await submit(outageAsset.id, heldKey);
  assert.equal((await getInspection(held.id)).status, 'queued');
  await test.disruptive(['stop', 'redis']);
  const outageKey = randomUUID(); const redisHeld = await submit(outageAsset.id, outageKey);
  assert.equal((await getInspection(redisHeld.id)).status, 'queued');
  assert.equal((await submit(outageAsset.id, outageKey)).id, redisHeld.id);
  assert.equal((await submit(outageAsset.id, heldKey)).id, held.id);
  await test.disruptive(['start', 'redis']);
  await waitForFreshHealthyService(test, 'redis');
  await test.disruptive(['start', 'worker']);
  const recovered = await completed(held.id); const redisRecovered = await completed(redisHeld.id);
  report.redisWorkerInterruption = { heldInspectionId: recovered.id, acceptedDuringRedisOutageId: redisRecovered.id,
    replayKeptOneIntent: true, recovered: true };
  report.checks.workerRedisDurableRecovery = true;

  // Pause only this owned model process. The real worker claims a request while
  // Python cannot answer, then dies without its graceful cancellation handler.
  // Resuming Python may finish an abandoned HTTP request; Mongo's lease, rather
  // than an HTTP disconnect, controls when the next attempt may commit.
  let crashed;
  await test.disruptive(['pause', 'inference']);
  try {
    const crashAccepted = await submit(outageAsset.id);
    const claimed = await until(async () => {
      const record = await getInspection(crashAccepted.id);
      assert.notEqual(record.status, 'failed');
      return record.status === 'processing' && record;
    }, 'real worker claim while model is paused', 10_000);
    assert.equal(claimed.attemptCount, 1);
    await test.disruptive(['kill', '-s', 'SIGKILL', 'worker']);
    crashed = claimed;
  } finally {
    // Never leave the test project with a paused model if an assertion fails.
    await test.disruptive(['unpause', 'inference']);
  }
  const recoveredModelHealth = await waitForFreshHealthyService(test, 'inference');
  await test.disruptive(['start', 'worker']);
  const crashRecovered = await completed(crashed.id);
  assert.ok(crashRecovered.attemptCount >= 2 && crashRecovered.attemptCount <= 3);
  const recoveredResult = structuredClone(crashRecovered.result);
  assert.deepEqual((await getInspection(crashed.id)).result, recoveredResult);
  report.workerCrash = { inspectionId: crashed.id, observedClaimAttempt: crashed.attemptCount,
    freshModelHealthProbeAt: recoveredModelHealth.Log.at(-1).End,
    recoveredAttemptCount: crashRecovered.attemptCount, preservedProvider: true, immutableCompletedResult: true,
    scope: 'SIGKILL after processing claim with the real model process paused; lease recovery completed a later attempt. Python may finish a disconnected request after unpause; no claim that its internal completion was individually observed.' };
  report.checks.inFlightWorkerCrashAndLeaseRecovery = true;

  await test.disruptive(['down']); // Named volumes remain; own project only.
  await test.compose(['up', '-d', '--wait', '--wait-timeout', '180'], { echo: true, timeout: 240_000 });
  await test.verifyOwnership(); await test.verifyMongoCompatibility();
  const reopened = await getInspection(browserRecord.id);
  assert.deepEqual(reopened.result, browserRecord.result); assert.deepEqual(reopened.review, browserRecord.review);
  assert.deepEqual(reopened.requested, provider);
  assert.deepEqual((await getInspection(retryRecord.id)).result, retryRecord.result);
  assert.deepEqual((await getInspection(crashRecovered.id)).result, recoveredResult);
  report.persistence = { inspectionId: reopened.id, reviewRevision: reopened.review.revision,
    immutablePredictions: true, sameSavedReview: true, modelIdentityPreserved: true };
  report.checks.downUpPersistence = true;
  report.passed = true; report.finishedAt = new Date().toISOString();
  await saveReport();
  console.log(`Real integration acceptance passed; ${report.samples.length} measurements; evidence docs/real-inference/acceptance.json`);
} catch (error) {
  report.errors.push({ phase: 'acceptance', message: String(error).slice(0, 600) });
  report.finishedAt = new Date().toISOString(); await saveReport();
  await test.compose(['logs', '--no-color', '--tail', '50'], { echo: true }).catch(() => {});
  throw error;
} finally {
  if (flags.has('--keep')) console.log(`Kept isolated project ${test.project}; generated override .tools/${test.project}.compose.json; WEB_PORT=${new URL(test.baseURL).port}`);
  else await test.cleanup();
}
