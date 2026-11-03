import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import { waitForFreshHealthyService } from './environment.mjs';
import { compatibility } from './verify-release.mjs';
import { observeQueuedFailure } from './observe-retry.mjs';

async function withinDeadline(read, deadline) {
  const remaining = deadline - performance.now();
  assert.ok(remaining > 0, 'No durable provider timeout was observed within the bounded observation window');
  let timer;
  try {
    return await Promise.race([read(), new Promise((_resolve, reject) => {
      timer = setTimeout(() => { reject(new Error('Durable timeout observation exceeded its 20-second window')); }, remaining);
    })]);
  } finally { clearTimeout(timer); }
}

/**
 * Exercise the released Python service through the real durable application.
 * Container pause delays actual HTTP service work; no provider or model is
 * replaced. This is recovery evidence, separate from latency benchmark samples.
 */
export async function runSlowModelRecovery({ test, submit, getInspection, completed, outageAssetId }) {
  assert.match(outageAssetId, /^[a-f0-9]{24}$/);
  const owned = await test.verifyOwnership();
  const inference = owned.filter(container => container.Config.Labels['com.docker.compose.service'] === 'inference');
  assert.equal(inference.length, 1, 'Slow-service probe requires exactly one owned inference container');
  const inferenceId = inference[0].Id;
  assert.equal(inference[0].State.Running, true, 'Inference must be running before pause');
  assert.equal(inference[0].State.Paused, false, 'Inference was already paused before the slow-service probe');

  let accepted;
  let timeoutRecord;
  let pauseAttempted = false;
  let unpausedAt;
  const started = performance.now();
  try {
    // Mark before awaiting, so an interrupted acknowledgement still attempts to
    // restore only this verified disposable service in finally.
    pauseAttempted = true;
    await test.disruptive(['pause', 'inference']);
    const paused = (await test.verifyOwnership()).find(container => container.Id === inferenceId);
    assert.ok(paused?.State.Paused, 'Owned inference did not enter paused state');
    accepted = await submit(outageAssetId);
    assert.match(accepted.id, /^[a-f0-9]{24}$/);
    const deadline = performance.now() + 20_000;
    const publicRecord = await withinDeadline(() => getInspection(accepted.id), deadline);
    assert.equal(publicRecord.result, undefined, 'Paused inference must not create a substitute result');
    assert.notEqual(publicRecord.status, 'completed', 'Paused inference unexpectedly completed');
    assert.notEqual(publicRecord.status, 'failed', 'Slow-service probe exhausted its budget before restoration');
    assert.equal(publicRecord.maxAttempts, 3);
    // Queued REST records intentionally omit the latest failure. Observe that
    // durable transition privately rather than expanding the public contract.
    timeoutRecord = await withinDeadline(() => observeQueuedFailure(test.compose, accepted.id, 'PROVIDER_TIMEOUT',
      Math.max(1, Math.floor(deadline - performance.now()))), deadline);
    assert.equal(timeoutRecord.status, 'queued');
    assert.equal(timeoutRecord.failure.code, 'PROVIDER_TIMEOUT');
    assert.equal(timeoutRecord.hasResult, false, 'Paused inference persisted an unexpected result');
    assert.equal(timeoutRecord.maxAttempts, 3);
    assert.ok(timeoutRecord.attemptCount >= 1 && timeoutRecord.attemptCount < timeoutRecord.maxAttempts,
      'A retry must remain after the durable timeout');
  } finally {
    if (pauseAttempted) {
      await test.disruptive(['unpause', 'inference']);
      unpausedAt = performance.now();
    }
  }

  await waitForFreshHealthyService(test, 'inference');
  const restored = (await test.verifyOwnership()).find(container => container.Id === inferenceId);
  assert.ok(restored?.State.Running && !restored.State.Paused, 'Owned inference was not restored');
  const result = await completed(accepted.id);
  assert.equal(result.status, 'completed');
  assert.ok(result.attemptCount > timeoutRecord.attemptCount && result.attemptCount <= 3,
    'Recovery must use a remaining application attempt');
  assert.deepEqual(result.requested, timeoutRecord.requested, 'Recovery changed the immutable provider request');
  assert.equal(result.result.providerId, 'visual-inspection-dl');
  assert.equal(result.result.modelId, 'pcb-ind-ssdlite');
  assert.equal(result.result.modelVersion, compatibility.release);
  assert.equal(result.result.taxonomyVersion, compatibility.taxonomy);
  assert.equal(result.result.artifactDigest, compatibility.artifactDigest);
  assert.equal(result.result.confidenceThreshold, compatibility.threshold);
  assert.equal(result.result.backend, 'trained');
  assert.equal(result.result.simulated, false);
  const recoveryObservedMs = performance.now() - unpausedAt;
  const originalResult = structuredClone(result.result);
  await pause(250);
  const reopened = await getInspection(result.id);
  assert.equal(reopened.status, 'completed');
  assert.equal(reopened.attemptCount, result.attemptCount);
  assert.equal(reopened.completedAt, result.completedAt);
  assert.deepEqual(reopened.requested, result.requested);
  assert.deepEqual(reopened.result, originalResult, 'A subsequent read changed the committed original result');

  return {
    scope: 'Real application worker HTTP timeout while its owned trained Python container was paused, then restoration and retry. Separate from benchmark samples; no exact latency guarantee.',
    inspectionId: result.id,
    timeout: { status: timeoutRecord.status, code: timeoutRecord.failure.code, attemptCount: timeoutRecord.attemptCount,
      resultAbsent: true, observationWindowMs: 20_000,
      observationSource: 'Read-only Mongo observation inside the owned API container; queued REST responses omit failure metadata' },
    recovery: { status: result.status, attemptCount: result.attemptCount, maxAttempts: result.maxAttempts,
      restoredSameContainer: true, unpauseThroughFreshHealthAndObservedResultMs: recoveryObservedMs,
      providerId: originalResult.providerId, backend: originalResult.backend, simulated: originalResult.simulated,
      modelVersion: originalResult.modelVersion, taxonomyVersion: originalResult.taxonomyVersion,
      artifactDigest: originalResult.artifactDigest, detectionCount: originalResult.detections.length,
      unchangedOnSubsequentRead: true },
    observedProbeDurationMs: performance.now() - started,
    limitation: 'The cancelled Python request may finish after disconnect. Its internal completion was not individually observed; this probe verifies the durable timeout, bounded application retry, and stable persisted completion.',
  };
}
