import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertRealContainer } from './environment.mjs';

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
