import assert from 'node:assert/strict';

/** Queued failures are private execution state, intentionally absent from public DTOs. */
export async function observeQueuedFailure(compose, inspectionId, code, timeoutMs = 8000) {
  assert.match(inspectionId, /^[a-f0-9]{24}$/);
  assert.ok(['PROVIDER_UNAVAILABLE', 'PROVIDER_TIMEOUT'].includes(code));
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 20_000);
  const script = `
import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import { Types } from 'mongoose';
import { connectDatabase, createInspectionModel } from '@vip/backend';
import { PCB_CONFIGURATION } from '@vip/contracts';
const id = ${JSON.stringify(inspectionId)};
const code = ${JSON.stringify(code)};
const connection = await connectDatabase(process.env.MONGODB_URI);
try {
  const model = createInspectionModel(connection);
  const deadline = Date.now() + ${timeoutMs};
  let observed;
  while (Date.now() < deadline) {
    // Compute presence in MongoDB rather than reading/transferring result contents.
    const [record] = await model.aggregate([
      { $match: { _id: new Types.ObjectId(id) } },
      { $project: { _id: 0, id: { $toString: '$_id' }, status: 1, attemptCount: 1, maxAttempts: 1,
        requested: 1, failure: { code: '$failure.code' }, hasResult: { $ne: [{ $type: '$result' }, 'missing'] } } },
    ]).option({ maxTimeMS: 1000 }).exec();
    assert.ok(record, 'The accepted inspection must remain durable');
    assert.ok(['queued', 'processing'].includes(record.status), 'Inspection became terminal before the controlled retry could be observed');
    assert.equal(record.hasResult, false, 'No original result may exist before fault recovery');
    assert.deepEqual(record.requested, PCB_CONFIGURATION);
    if (record.status === 'queued' && record.attemptCount >= 1 && record.failure?.code === code) {
      assert.equal(record.maxAttempts, 3);
      assert.ok(record.attemptCount < record.maxAttempts);
      observed = record; break;
    }
    await pause(50);
  }
  assert.ok(observed, 'A matching durable queued failure was not observed within the bound');
  console.log(JSON.stringify(observed));
} finally { await connection.close(); }
`;
  const output = await compose(['exec', '-T', '-w', '/app/apps/api', 'api', 'node', '--input-type=module', '-'], {
    input: script, timeout: timeoutMs + 8000,
  });
  const record = JSON.parse(output.trim());
  assert.equal(record.id, inspectionId); assert.equal(record.status, 'queued');
  assert.equal(record.failure?.code, code); assert.equal(record.hasResult, false);
  assert.ok(record.attemptCount >= 1 && record.attemptCount < record.maxAttempts);
  return record;
}
