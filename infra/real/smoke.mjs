import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { command, root } from '../docker/disposable.mjs';
import { compatibility, verifyRelease } from './verify-release.mjs';
import { realEnvironment } from './environment.mjs';
import { runSlowModelRecovery } from './slow-probe.mjs';

// A correctness smoke, separate from the historical 30+20 performance workload.
// It never rewrites docs/real-inference or authentic browser captures.
const flags = new Set(process.argv.slice(2));
assert.ok([...flags].every(flag => ['--ci-mongodb', '--recovery', '--keep'].includes(flag)),
  'Use optional --ci-mongodb / --recovery / --keep');
const verified = await verifyRelease(); // Strict source/bundle pin before any Docker mutation.
const test = await realEnvironment({ ciMongoCompatibility: flags.has('--ci-mongodb'), dlDirectory: verified.dlRoot });
const reportFile = resolve(root, '.tools/real-model-smoke.json');
const provider = { providerId: 'visual-inspection-dl', modelId: 'pcb-ind-ssdlite', modelVersion: compatibility.release,
  taxonomyVersion: compatibility.taxonomy, artifactDigest: compatibility.artifactDigest, confidenceThreshold: compatibility.threshold };
const mock = { providerId: 'mock', modelId: 'mock-detector', modelVersion: '1.0.0' };
const classes = ['mouse_bite', 'missing_copper', 'scratch', 'spurious_copper', 'copper_burr', 'stain', 'short', 'open'];
const report = { startedAt: new Date().toISOString(), passed: false, compatibility, checks: {}, errors: [],
  project: test.project, owner: test.owner, baseURL: test.baseURL, verifiedDlDirectory: verified.dlRoot,
  composeOverride: resolve(root, '.tools', `${test.project}.compose.json`),
  scope: 'Bounded CPU correctness smoke; not an accuracy evaluation, latency benchmark or full real-model acceptance run.',
  fixture: 'PCB-IND v4 5810_t_007.jpg training-set serving fixture; fixtures/pcb/README.md contains attribution and provenance.' };

async function json(path, expected = 200, options = {}) {
  const response = await fetch(`${test.baseURL}${path}`, { ...options, signal: AbortSignal.timeout(15_000),
    headers: { Accept: 'application/json', ...options.headers } });
  const body = await response.json();
  assert.equal(response.status, expected, `Unexpected HTTP status at ${path}: ${response.status}; code=${body.error?.code ?? 'none'}`);
  return body;
}
async function until(read, label, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await pause(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
const getInspection = id => json(`/api/v1/inspections/${id}`);
async function completed(id, selected = provider) {
  return until(async () => {
    const record = await getInspection(id);
    assert.notEqual(record.status, 'failed', `Inspection ${id} failed: ${record.failure?.code}`);
    if (record.status !== 'completed') return false;
    assert.deepEqual(record.requested, selected);
    assert.equal(record.result.providerId, selected.providerId);
    assert.equal(record.result.modelId, selected.modelId);
    assert.equal(record.result.modelVersion, selected.modelVersion);
    assert.equal(record.result.simulated, selected.providerId === 'mock');
    if (selected.providerId === provider.providerId) {
      assert.equal(record.result.backend, 'trained');
      assert.equal(record.result.taxonomyVersion, compatibility.taxonomy);
      assert.equal(record.result.artifactDigest, compatibility.artifactDigest);
      assert.equal(record.result.confidenceThreshold, compatibility.threshold);
    } else assert.equal(record.result.taxonomyVersion, 'mock-v1');
    return record;
  }, `completed ${selected.providerId} inspection`);
}
const submit = assetId => json('/api/v1/inspections', 202, { method: 'POST',
  headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
  body: JSON.stringify({ assetId, provider, candidatePatch: true }) });

async function finish() {
  try {
    if (flags.has('--keep')) {
      report.kept = true;
      console.log(`Kept owned smoke project ${test.project}; ${test.baseURL}; override ${report.composeOverride}`);
    } else {
      await test.cleanup();
      report.cleanedUp = true;
    }
  } catch (error) {
    report.passed = false;
    report.errors.push(`Owned cleanup failed: ${String(error).slice(0, 300)}`);
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    await mkdir(resolve(root, '.tools'), { recursive: true });
    await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Released-model CPU smoke ${report.passed ? 'passed' : 'failed'}; evidence ${reportFile}`);
  }
}

console.log(`Bounded released-model CPU smoke: ${test.project}; ${test.baseURL}`);
try {
  report.platformRevisionAtRun = await command('git', ['rev-parse', 'HEAD']);
  report.platformTrackedChangesAtRun = (await command('git', ['status', '--porcelain', '--untracked-files=no'])).split('\n').filter(Boolean).length;
  const config = JSON.parse(await test.compose(['config', '--format', 'json']));
  assert.equal(resolve(config.services.inference.build.context), verified.dlRoot, 'Compose must build the checkout examined by preflight');
  const bundle = config.services.inference.volumes.find(volume => volume.target === '/models/pcb-ind-ssdlite-v1');
  assert.equal(bundle.type, 'bind');
  assert.equal(resolve(bundle.source), verified.bundle, 'Compose must mount the exact release examined by preflight');
  assert.equal(bundle.read_only, true);
  report.checks.verifiedBuildAndBundleSources = true;
  await test.compose(['build'], { echo: true, timeout: 480_000 });
  await test.compose(['up', '-d', '--wait', '--wait-timeout', '180'], { echo: true, timeout: 210_000 });
  await test.verifyMongoCompatibility();
  const containers = await test.verifyOwnership();
  assert.equal(containers.length, 6);
  for (const container of containers) {
    const service = container.Config.Labels['com.docker.compose.service'];
    const ports = Object.values(container.HostConfig.PortBindings ?? {}).flat();
    if (service === 'web') {
      assert.equal(ports.length, 1);
      assert.equal(ports[0].HostIp, '127.0.0.1');
      assert.equal(ports[0].HostPort, new URL(test.baseURL).port);
    } else assert.equal(ports.length, 0, `${service} must not publish a host port`);
    if (service === 'inference') {
      assert.ok(container.Config.User && !['root', '0'].includes(container.Config.User));
      assert.equal(container.HostConfig.DeviceRequests?.length ?? 0, 0);
      assert.ok(container.Config.Env.includes('INSPECTION_DL_DEVICE=cpu'));
      assert.ok(container.Config.Env.includes('INSPECTION_DL_BACKEND=trained'));
      assert.equal(container.Mounts.find(mount => mount.Destination === '/models/pcb-ind-ssdlite-v1').RW, false);
      report.inference = { device: 'cpu', user: container.Config.User, backend: 'trained', hostPublishedPorts: 0, readOnlyBundle: true };
    }
  }
  report.checks.privateCpuTopology = true;
  // The background monitor checks both /ready and pinned /v1/model identity.
  await until(async () => (await json('/api/v1/inference-modes')).trained.available, 'pinned trained readiness');
  report.checks.pinnedTrainedReadiness = true;
  const form = new FormData();
  form.append('image', new Blob([await readFile(resolve(root, 'fixtures/pcb/5810_t_007.jpg'))], { type: 'image/jpeg' }), '5810_t_007.jpg');
  form.append('source', 'browser');
  const asset = await json('/api/v1/assets', 201, { method: 'POST', body: form });
  assert.equal(asset.width, 300); assert.equal(asset.height, 300);
  const accepted = await submit(asset.id);
  const trained = await completed(accepted.id);
  report.trained = { inspectionId: trained.id, attemptCount: trained.attemptCount, result: trained.result };
  report.checks.actualTrainedWorkerInference = true;

  const annotations = trained.result.detections.map(prediction => ({ id: `prediction:${prediction.id}`, origin: 'prediction',
    predictionId: prediction.id, classId: prediction.classId, disposition: 'accepted', boundingBox: prediction.boundingBox }));
  // These deliberately illustrative additions check vocabulary persistence, not ground truth.
  annotations.push(...classes.map((classId, index) => ({ id: `manual:${randomUUID()}`, origin: 'manual', classId,
    disposition: 'accepted', boundingBox: { x: 0.05 + index * 0.1, y: 0.05, width: 0.05, height: 0.05 } })));
  const saved = await json(`/api/v1/inspections/${trained.id}/review`, 200, { method: 'PUT',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contractVersion: 'v1', taxonomyVersion: compatibility.taxonomy,
      operationId: randomUUID(), expectedRevision: 0, expectedWriteSequence: 0, annotations }) });
  assert.equal(saved.review.revision, 1);
  const reopened = await getInspection(trained.id);
  assert.deepEqual(reopened.review, saved.review);
  assert.deepEqual(reopened.result, trained.result, 'Human review must not modify original predictions');
  assert.deepEqual([...new Set(reopened.review.annotations.map(annotation => annotation.classId))].sort(), [...classes].sort());
  report.review = { inspectionId: trained.id, revision: reopened.review.revision, classes, originalResultUnchanged: true,
    scope: 'API save/reopen with all eight manual classes; illustrative annotations, not expert corrections or a browser test.' };
  report.checks.eightClassReviewSaveReopen = true;

  const mockAccepted = await json('/api/v1/inspections', 202, { method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ assetId: asset.id, provider: mock }) });
  const simulated = await completed(mockAccepted.id, mock);
  report.mock = { inspectionId: simulated.id, providerId: simulated.result.providerId, taxonomyVersion: simulated.result.taxonomyVersion,
    simulated: simulated.result.simulated };
  report.checks.explicitMockIdentityPreserved = true;
  if (flags.has('--recovery')) {
    report.recovery = await runSlowModelRecovery({ test, submit, getInspection, completed, outageAssetId: asset.id });
    report.checks.realTimeoutRecovery = true;
  }
  report.passed = true;
} catch (error) {
  report.errors.push(String(error).slice(0, 600));
  // Provider/application logs are already bounded and contain no image bytes.
  await test.compose(['logs', '--no-color', '--tail', '20', 'api', 'worker', 'inference'], { echo: true }).catch(() => {});
  throw error;
} finally {
  await finish();
}
