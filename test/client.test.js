import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobStore } from '../src/daemon/job-store.js';
import { UploadStore } from '../src/daemon/upload-store.js';
import { Mutex } from '../src/daemon/mutex.js';
import { JobRunner } from '../src/daemon/runner.js';
import { createDaemonServer } from '../src/daemon/server.js';
import { loadOrCreateToken } from '../src/daemon/token.js';
import { DaemonClient, ensureDaemon } from '../src/daemon/client.js';
import { FakeDriver } from './fake-driver.js';

async function startServer(root, port = 0) {
  const tokenFile = path.join(root, 'daemon-token');
  const token = loadOrCreateToken(tokenFile);
  const store = new JobStore(path.join(root, 'jobs.json'));
  const uploads = new UploadStore(path.join(root, 'uploads'));
  const mutex = new Mutex();
  const driver = new FakeDriver();
  const runner = new JobRunner({ store, uploads, driver, mutex, outputsDir: path.join(root, 'outputs') });
  const server = createDaemonServer({ token, store, uploads, runner, mutex, driver,
    callTool: async (name) => { if (name === 'bad') throw Object.assign(new Error('nope'), { code: 'INVALID_PARAMS' }); return { name }; } });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { server, runner, tokenFile, port: server.address().port };
}

test('client drives uploads, jobs, outputs and tools', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-client-'));
  const { server, runner, tokenFile, port } = await startServer(root);
  t.after(() => server.close());
  const client = new DaemonClient({ baseUrl: `http://127.0.0.1:${port}`, tokenFile });

  assert.equal((await client.health()).ok, true);
  const upload = await client.upload(Buffer.from('ref'), 'image/png');
  const submitted = await client.submitJob({ kind: 'image', model: 'nano-banana-2', prompt: 'p', aspectRatio: '1:1',
    references: [upload.id], confirmCredits: true, idempotencyKey: 'key-client-01' });
  await runner.idle();
  const job = await client.getJob(submitted.id);
  assert.equal(job.state, 'succeeded');
  const output = await client.getOutput(submitted.id, 0);
  assert.equal(output.mediaType, 'image/png');
  assert.equal(Buffer.from(output.bytes).toString(), 'image:uuid-1');
  assert.deepEqual(await client.callTool('flow_status', {}), { name: 'flow_status' });
  await assert.rejects(client.callTool('bad', {}), (err) => err.code === 'INVALID_REQUEST' && err.message === 'nope');
  await assert.rejects(client.getJob('missing'), (err) => err.code === 'NOT_FOUND');
});

test('unreachable daemon raises DAEMON_UNAVAILABLE', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-client-'));
  const tokenFile = path.join(root, 'daemon-token');
  loadOrCreateToken(tokenFile);
  const client = new DaemonClient({ baseUrl: 'http://127.0.0.1:1', tokenFile });
  await assert.rejects(client.health(), (err) => err.code === 'DAEMON_UNAVAILABLE');
});

test('ensureDaemon spawns once when the daemon is down, then waits for health', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-client-'));
  const probe = await startServer(root);
  const port = probe.port;
  await new Promise((resolve) => probe.server.close(resolve));
  let spawned = 0;
  let started;
  const client = await ensureDaemon({
    baseUrl: `http://127.0.0.1:${port}`, tokenFile: path.join(root, 'daemon-token'), timeoutMs: 5000,
    spawnDaemon: () => { spawned += 1; started = startServer(root, port); },
  });
  t.after(async () => (await started).server.close());
  assert.equal(spawned, 1);
  assert.equal((await client.health()).ok, true);
});
