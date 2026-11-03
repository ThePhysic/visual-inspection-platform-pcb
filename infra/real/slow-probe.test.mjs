import assert from 'node:assert/strict';
import test from 'node:test';
import { runSlowModelRecovery } from './slow-probe.mjs';

// Control-plane unit tests prove restoration on failure. They do not replace
// the actual paused-Python worker scenario in infra/real/run.mjs.
function environment({ losePauseAcknowledgement = false } = {}) {
  let paused = false;
  const commands = [];
  return {
    commands,
    async verifyOwnership() {
      return [{ Id: 'a'.repeat(64), Config: { Labels: { 'com.docker.compose.service': 'inference' } },
        State: { Running: true, Paused: paused } }];
    },
    async disruptive(args) {
      commands.push(args);
      if (args[0] === 'pause') {
        paused = true;
        if (losePauseAcknowledgement) throw new Error('Lost pause acknowledgement');
      } else if (args[0] === 'unpause') paused = false;
      else assert.fail('Unexpected disruptive operation');
    },
  };
}
const inspectionId = 'b'.repeat(24);
const outageAssetId = 'c'.repeat(24);
const unexpectedRead = async () => { assert.fail('Unexpected inspection read'); };

test('restores paused inference when durable submission fails', async () => {
  const owned = environment();
  await assert.rejects(runSlowModelRecovery({ test: owned, outageAssetId,
    submit: async () => { throw new Error('Submission unavailable'); }, getInspection: unexpectedRead, completed: unexpectedRead,
  }), /Submission unavailable/);
  assert.deepEqual(owned.commands, [['pause', 'inference'], ['unpause', 'inference']]);
  assert.equal((await owned.verifyOwnership())[0].State.Paused, false);
});

test('restores paused inference when an invalid substitute result is observed', async () => {
  const owned = environment();
  await assert.rejects(runSlowModelRecovery({ test: owned, outageAssetId,
    submit: async () => ({ id: inspectionId }),
    getInspection: async () => ({ id: inspectionId, status: 'completed', result: { simulated: true } }),
    completed: unexpectedRead,
  }), /must not create a substitute result/);
  assert.deepEqual(owned.commands, [['pause', 'inference'], ['unpause', 'inference']]);
});

test('attempts restoration even if the pause acknowledgement is lost', async () => {
  const owned = environment({ losePauseAcknowledgement: true });
  await assert.rejects(runSlowModelRecovery({ test: owned, outageAssetId,
    submit: unexpectedRead, getInspection: unexpectedRead, completed: unexpectedRead,
  }), /Lost pause acknowledgement/);
  assert.deepEqual(owned.commands, [['pause', 'inference'], ['unpause', 'inference']]);
  assert.equal((await owned.verifyOwnership())[0].State.Paused, false);
});

test('ownership verification failure prevents any disruption', async () => {
  let calls = 0;
  await assert.rejects(runSlowModelRecovery({
    test: { verifyOwnership: async () => { throw new Error('Foreign container'); }, disruptive: async () => { calls++; } },
    outageAssetId, submit: unexpectedRead, getInspection: unexpectedRead, completed: unexpectedRead,
  }), /Foreign container/);
  assert.equal(calls, 0);
});
