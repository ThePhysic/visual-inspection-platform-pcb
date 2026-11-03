import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { command, root } from '../docker/disposable.mjs';

const label = 'io.vip.disposable-owner';
const services = ['web', 'api', 'worker', 'mongodb', 'redis', 'inference'];
const volumes = ['images', 'mongodb-data', 'mongodb-config-data', 'redis-data'];

// Compose can reject a start immediately against cached dependency health after
// an outage. Observe a NEW successful probe without restarting the dependency.
export async function waitForFreshHealthyService(environment, service, {
  timeout = 45_000,
  inspect = async id => JSON.parse(await command('docker', ['inspect', '--format', '{{json .State.Health}}', id], { timeout: 5000 })),
  poll = () => pause(250),
} = {}) {
  assert.ok(services.includes(service));
  const matches = (await environment.verifyOwnership()).filter(container => container.Config.Labels['com.docker.compose.service'] === service);
  assert.equal(matches.length, 1, 'Expected one owned dependency container');
  const id = matches[0].Id;
  assert.match(id, /^[a-f0-9]{64}$/);
  const initial = await inspect(id);
  const previousProbe = initial?.Log?.at(-1)?.End;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const health = await inspect(id);
    const probe = health?.Log?.at(-1);
    if (health?.Status === 'healthy' && probe?.ExitCode === 0 && probe.End && probe.End !== previousProbe) return health;
    await poll();
  }
  throw new Error(`Owned ${service} did not produce a fresh successful Docker health probe after recovery`);
}

export function assertRealContainer(container, project, owner) {
  assert.match(owner, /^[a-f0-9]{32}$/);
  assert.equal(project, `vip-real-${owner}`);
  assert.equal(container.Config.Labels[label], owner, 'Foreign container: refusing disruption/cleanup');
  assert.equal(container.Config.Labels['com.docker.compose.project'], project);
  const service = container.Config.Labels['com.docker.compose.service'];
  assert.ok(services.includes(service), 'Unexpected service: refusing disruption/cleanup');
  const expected = {
    web: {}, api: { '/data/images': ['images', true] }, worker: { '/data/images': ['images', false] },
    mongodb: { '/data/db': ['mongodb-data', true], '/data/configdb': ['mongodb-config-data', true] },
    redis: { '/data': ['redis-data', true] }, inference: { '/models/pcb-ind-ssdlite-v1': ['bundle', false] },
  }[service];
  assert.equal(container.Mounts.length, Object.keys(expected).length, 'Unexpected/anonymous data mount: refusing disruption/cleanup');
  for (const [destination, [name, writable]] of Object.entries(expected)) {
    const matches = container.Mounts.filter(mount => mount.Destination === destination);
    assert.equal(matches.length, 1);
    const [mount] = matches;
    assert.equal(mount.RW, writable);
    if (service === 'inference') {
      assert.equal(mount.Type, 'bind');
      assert.ok(mount.Source.replaceAll('\\', '/').endsWith('/releases/pcb-ind-ssdlite-v1'), 'Unexpected release mount');
    } else {
      assert.equal(mount.Type, 'volume');
      assert.equal(mount.Name, `${project}_${name}`, 'Foreign or anonymous volume');
    }
  }
}

async function freePort() {
  const server = createServer();
  await new Promise((done, reject) => { server.on('error', reject); server.listen(0, '127.0.0.1', done); });
  const port = server.address().port;
  await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
  return port;
}

export async function realEnvironment({ ciMongoCompatibility = false } = {}) {
  const owner = randomUUID().replaceAll('-', '');
  const project = `vip-real-${owner}`;
  const webPort = await freePort();
  const file = resolve(root, '.tools', `${project}.compose.json`);
  // A fresh random project is verified absent before any mutating Docker command.
  for (const kind of ['container', 'volume', 'network']) {
    const args = kind === 'container' ? ['ps', '-aq'] : [kind, 'ls', '-q'];
    assert.equal(await command('docker', [...args, '--filter', `label=com.docker.compose.project=${project}`]), '');
  }
  const override = {
    services: Object.fromEntries(services.map(service => [service, { labels: { [label]: owner } }])),
    volumes: Object.fromEntries(volumes.map(name => [name, { labels: { [label]: owner } }])),
    networks: { default: { labels: { [label]: owner } } },
  };
  for (const service of ['api', 'worker']) override.services[service].environment = {
    MONGODB_URI: `mongodb://mongodb:27017/vip_real_${owner}`,
  };
  override.services.mongodb.volumes = ['mongodb-config-data:/data/configdb'];
  await mkdir(resolve(root, '.tools'), { recursive: true });
  await writeFile(file, JSON.stringify(override), { flag: 'wx' });
  const composeArgs = ['compose', '-p', project, '-f', 'compose.yaml',
    ...(ciMongoCompatibility ? ['-f', 'compose.ci.yaml'] : []), '-f', 'compose.real.yaml', '-f', file];
  const compose = (args, options = {}) => command('docker', [...composeArgs, ...args], {
    ...options, env: { ...options.env, WEB_PORT: String(webPort) },
  });

  async function verifyOwnership() {
    const ids = (await command('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`])).split(/\s+/).filter(Boolean);
    const containers = ids.length ? JSON.parse(await command('docker', ['inspect', ...ids])) : [];
    for (const container of containers) assertRealContainer(container, project, owner);
    for (const kind of ['volume', 'network']) {
      const names = (await command('docker', [kind, 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`])).split(/\s+/).filter(Boolean);
      if (names.length) for (const resource of JSON.parse(await command('docker', [kind, 'inspect', ...names]))) {
        assert.equal(resource.Labels[label], owner, `Foreign ${kind}: refusing cleanup`);
        assert.equal(resource.Labels['com.docker.compose.project'], project);
        assert.ok(kind === 'network' ? resource.Name === `${project}_default`
          : volumes.some(name => resource.Name === `${project}_${name}`), 'Unexpected owned resource name');
      }
    }
    return containers;
  }
  const disruptive = async args => { await verifyOwnership(); return compose(args, { echo: true }); };
  return { project, owner, compose, disruptive, verifyOwnership,
    baseURL: `http://127.0.0.1:${webPort}`, environment: { CONTAINER_BASE_URL: `http://127.0.0.1:${webPort}` },
    async verifyMongoCompatibility() {
      if (!ciMongoCompatibility) return;
      await compose(['exec', '-T', 'mongodb', 'mongosh', '--quiet', '--eval',
        'const s=db.serverStatus(); print(JSON.stringify({version:s.version,usingPerCPUCaches:s.tcmalloc?.usingPerCPUCaches})); if(s.version!=="8.0.34" || s.tcmalloc?.usingPerCPUCaches!==false) quit(1);']);
    },
    async cleanup() {
      await disruptive(['down', '--volumes', '--remove-orphans']);
      await unlink(file);
    },
  };
}
