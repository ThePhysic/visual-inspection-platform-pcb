import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { assertRealContainer, realComposeEnvironment, waitForFreshHealthyService } from './environment.mjs';
import { resolveDlDirectory } from './configuration.mjs';
import { execFileSync } from 'node:child_process';
import { assertCleanDlBuildInputs } from './verify-release.mjs';

const owner = 'a'.repeat(32);
const project = `vip-real-${owner}`;
function container(service, mounts) {
  return { Config: { Labels: { 'io.vip.disposable-owner': owner, 'com.docker.compose.project': project,
    'com.docker.compose.service': service } }, Mounts: mounts };
}
const dataMount = (name, destination, writable = true) => ({ Type: 'volume', Name: `${project}_${name}`, Destination: destination, RW: writable });

test('accepts explicitly owned Mongo data and configdb volumes', () => {
  assertRealContainer(container('mongodb', [dataMount('mongodb-data', '/data/db'), dataMount('mongodb-config-data', '/data/configdb')]), project, owner);
});
test('refuses anonymous, foreign, missing, or additional data mounts before disruption', () => {
  for (const mounts of [
    [dataMount('mongodb-data', '/data/db')],
    [dataMount('mongodb-data', '/data/db'), { ...dataMount('mongodb-config-data', '/data/configdb'), Name: 'anonymous-volume' }],
    [dataMount('images', '/data/images', false), dataMount('images', '/unexpected')],
  ]) assert.throws(() => assertRealContainer(container(mounts[0].Destination === '/data/db' ? 'mongodb' : 'worker', mounts), project, owner));
});
test('requires inference release bind to be read-only and owned by the exact project', () => {
  const release = { Type: 'bind', Source: '/host/visual-inspection-dl/releases/pcb-ind-ssdlite-v1',
    Destination: '/models/pcb-ind-ssdlite-v1', RW: false };
  assertRealContainer(container('inference', [release]), project, owner);
  assert.throws(() => assertRealContainer(container('inference', [{ ...release, RW: true }]), project, owner));
  assert.throws(() => assertRealContainer(container('inference', [{ ...release, Source: '/unexpected/bundle' }]), project, owner));
  const foreign = container('inference', [release]); foreign.Config.Labels['io.vip.disposable-owner'] = 'b'.repeat(32);
  assert.throws(() => assertRealContainer(foreign, project, owner));
});

test('recovery waits past cached healthy and failing probes for a new successful observation', async () => {
  const owned = { ...container('inference', []), Id: 'a'.repeat(64) };
  const observations = [
    { Status: 'healthy', Log: [{ End: 'before-outage', ExitCode: 0 }] },
    { Status: 'healthy', Log: [{ End: 'before-outage', ExitCode: 0 }] },
    { Status: 'unhealthy', Log: [{ End: 'failed-during-outage', ExitCode: 1 }] },
    { Status: 'healthy', Log: [{ End: 'new-success-after-recovery', ExitCode: 0 }] },
  ];
  let reads = 0; let polls = 0;
  const health = await waitForFreshHealthyService({ verifyOwnership: async () => [owned] }, 'inference', {
    inspect: async id => { assert.equal(id, owned.Id); return observations[reads++]; },
    poll: async () => { polls++; },
  });
  assert.equal(reads, 4); assert.equal(polls, 2);
  assert.equal(health.Log.at(-1).End, 'new-success-after-recovery');
});

async function checkoutPaths(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vip-dl-directory-test-'));
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}vip-dl-directory-test-`), 'Refusing unsafe temporary-directory cleanup');
    await rm(directory, { recursive: true, force: true });
  });
  const projectRoot = join(directory, 'visual-inspection-platform');
  const defaultDl = join(directory, 'visual-inspection-dl');
  const alternateDl = join(directory, 'alternate dl');
  const shellDl = join(directory, 'shell-dl');
  for (const [path, marker] of [[projectRoot, 'platform'], [defaultDl, 'unselected default'], [alternateDl, 'selected alternate'], [shellDl, 'selected shell']]) {
    await mkdir(path); await writeFile(join(path, 'checkout-marker'), marker);
  }
  return { projectRoot, defaultDl, alternateDl, shellDl };
}

test('the .env-only DL override selects the actual alternate checkout instead of the existing default', async t => {
  const fixture = await checkoutPaths(t);
  await writeFile(join(fixture.projectRoot, '.env'), 'UNRELATED_SECRET=never-output\nDL_REPOSITORY_DIR="../alternate dl" # selected checkout\n');
  const selected = await resolveDlDirectory({ projectRoot: fixture.projectRoot, environment: {} });
  assert.equal(selected, fixture.alternateDl);
  assert.equal(await readFile(join(selected, 'checkout-marker'), 'utf8'), 'selected alternate');
});

test('shell paths override .env and an explicitly empty shell path uses Compose default semantics', async t => {
  const fixture = await checkoutPaths(t);
  await writeFile(join(fixture.projectRoot, '.env'), 'DL_REPOSITORY_DIR=../alternate dl\n');
  const selected = await resolveDlDirectory({ projectRoot: fixture.projectRoot, environment: { DL_REPOSITORY_DIR: '../shell-dl' } });
  assert.equal(selected, fixture.shellDl);
  assert.equal(await readFile(join(selected, 'checkout-marker'), 'utf8'), 'selected shell');
  assert.equal(await resolveDlDirectory({ projectRoot: fixture.projectRoot, environment: { DL_REPOSITORY_DIR: '' } }), fixture.defaultDl);
});

test('captured verified path overrides later environment changes for every Compose invocation', async t => {
  const fixture = await checkoutPaths(t);
  const envFile = join(fixture.projectRoot, '.env');
  await writeFile(envFile, 'DL_REPOSITORY_DIR=../alternate dl\n');
  const verified = await resolveDlDirectory({ projectRoot: fixture.projectRoot, environment: {} });
  await writeFile(envFile, 'DL_REPOSITORY_DIR=../shell-dl\n');
  const childEnvironment = realComposeEnvironment(8081, verified, { DL_REPOSITORY_DIR: fixture.defaultDl, WEB_PORT: '9999', ANOTHER_SETTING: 'retained' });
  assert.equal(childEnvironment.DL_REPOSITORY_DIR, fixture.alternateDl);
  assert.equal(childEnvironment.WEB_PORT, '8081');
  assert.equal(childEnvironment.ANOTHER_SETTING, 'retained');
  assert.equal(await readFile(join(childEnvironment.DL_REPOSITORY_DIR, 'checkout-marker'), 'utf8'), 'selected alternate');
  assert.throws(() => realComposeEnvironment(8081, '../relative-unverified-dl'));
});

test('interpolated .env paths and custom Compose env sources fail closed instead of selecting different inputs', async t => {
  const fixture = await checkoutPaths(t);
  await writeFile(join(fixture.projectRoot, '.env'), 'DL_REPOSITORY_DIR=${SOME_CHECKOUT}/dl\n');
  await assert.rejects(resolveDlDirectory({ projectRoot: fixture.projectRoot, environment: {} }), /literal path/);
  // A literal, exported override wins over an unselected interpolated .env value.
  assert.equal(await resolveDlDirectory({ projectRoot: fixture.projectRoot, environment: { DL_REPOSITORY_DIR: fixture.shellDl } }), fixture.shellDl);
  await assert.rejects(resolveDlDirectory({ projectRoot: fixture.projectRoot, environment: { COMPOSE_ENV_FILES: 'other.env' } }), /custom Compose env-file/);
});

test('ordinary mock tooling can import the optional helpers without requiring a DL clone', async t => {
  const fixture = await checkoutPaths(t);
  const missingRoot = join(fixture.projectRoot, 'empty-project');
  await mkdir(missingRoot);
  assert.equal(await resolveDlDirectory({ projectRoot: missingRoot, environment: {} }), join(fixture.projectRoot, 'visual-inspection-dl'));
});

test('source pinning rejects new untracked serving code while allowing ignored caches and unrelated notes', async t => {
  const fixture = await checkoutPaths(t);
  const checkout = fixture.alternateDl;
  const packageDirectory = join(checkout, 'src', 'inspection_dl');
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(join(packageDirectory, '__init__.py'), '# tracked serving package\n');
  await writeFile(join(checkout, '.gitignore'), '__pycache__/\n.venv/\ndata/\n');
  execFileSync('git', ['init', '--quiet'], { cwd: checkout, windowsHide: true });
  execFileSync('git', ['add', '.gitignore', 'src/inspection_dl/__init__.py'], { cwd: checkout, windowsHide: true });
  await writeFile(join(checkout, 'local-notes.md'), 'Unrelated local notes are not model image build inputs.\n');
  await mkdir(join(packageDirectory, '__pycache__'));
  await writeFile(join(packageDirectory, '__pycache__', '__init__.cpython-312.pyc'), 'ignored cache');
  assert.doesNotThrow(() => assertCleanDlBuildInputs(checkout));
  // Docker COPY src includes this file although the commit and tracked-file
  // status have not changed. It must not bypass the source compatibility pin.
  await writeFile(join(packageDirectory, 'local_experiment.py'), 'EXPERIMENTAL = True\n');
  assert.throws(() => assertCleanDlBuildInputs(checkout), /untracked serving source build inputs/);
});
