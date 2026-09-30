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
import { FakeDriver } from './fake-driver.js';

async function start({ callTool = async () => ({ ok: 'tool' }) } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-server-'));
  const token = loadOrCreateToken(path.join(root, 'daemon-token'));
  const store = new JobStore(path.join(root, 'jobs.json'));
  const uploads = new UploadStore(path.join(root, 'uploads'));
  const mutex = new Mutex();
  const driver = new FakeDriver();
  const runner = new JobRunner({ store, uploads, driver, mutex, outputsDir: path.join(root, 'outputs') });
  const server = createDaemonServer({ token, store, uploads, runner, mutex, driver, expectedAccount: 'me@example.com', callTool });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { authorization: `Bearer ${token}` };
  return { server, base, auth, runner, token, mutex, driver };
}
const job = { kind: 'image', model: 'nano-banana-2', prompt: 'a cat', aspectRatio: '1:1',
  confirmCredits: true, idempotencyKey: 'key-server-01' };

test('token is created once and reused', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-token-')), 'daemon-token');
  const first = loadOrCreateToken(file);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(loadOrCreateToken(file), first);
});

test('health is public and reports browser and queue', async (t) => {
  const { server, base } = await start();
  t.after(() => server.close());
  const body = await (await fetch(`${base}/health`)).json();
  assert.equal(body.ok, true);
  assert.equal(body.chrome, true);
  assert.equal(body.accountMatches, true);
  assert.deepEqual(body.queue, { running: null, queued: 0 });
});

test('everything else requires the bearer token', async (t) => {
  const { server, base } = await start();
  t.after(() => server.close());
  const response = await fetch(`${base}/jobs`, { method: 'POST', body: JSON.stringify(job) });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'UNAUTHORIZED');
});

test('credit reads require authentication and wait for the browser mutex', async (t) => {
  const { server, base, auth, mutex, driver } = await start();
  t.after(() => server.close());
  let calls = 0;
  driver.credits = async () => { calls++; return 900; };
  assert.equal((await fetch(`${base}/credits`)).status, 401);
  let release;
  const rendering = mutex.run(() => new Promise((resolve) => { release = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  const reading = fetch(`${base}/credits`, { headers: auth });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, 0, 'credit UI must not touch an active render');
  release(); await rendering;
  const response = await reading;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { credits: 900 });
  assert.equal(calls, 1);
});

test('upload, submit, poll and download a job', async (t) => {
  const { server, base, auth, runner } = await start();
  t.after(() => server.close());
  const upload = await (await fetch(`${base}/uploads`, {
    method: 'POST', headers: { ...auth, 'content-type': 'image/png' }, body: Buffer.from('ref'),
  })).json();
  assert.match(upload.id, /^[a-f0-9]{32}$/);

  const submitted = await fetch(`${base}/jobs`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ ...job, references: [upload.id] }),
  });
  assert.equal(submitted.status, 201);
  const { id, deduplicated } = await submitted.json();
  assert.equal(deduplicated, false);

  await runner.idle();
  const state = await (await fetch(`${base}/jobs/${id}`, { headers: auth })).json();
  assert.equal(state.state, 'succeeded');
  assert.equal(state.outputs[0].mediaType, 'image/png');
  assert.equal(state.outputs[0].file, undefined, 'local paths are not exposed');

  const output = await fetch(`${base}/jobs/${id}/outputs/0`, { headers: auth });
  assert.equal(output.headers.get('content-type'), 'image/png');
  assert.equal(await output.text(), 'image:uuid-1');

  const again = await fetch(`${base}/jobs`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ ...job, references: [upload.id] }),
  });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).deduplicated, true);
});

test('invalid bodies, unknown uploads and unknown jobs', async (t) => {
  const { server, base, auth } = await start();
  t.after(() => server.close());
  const post = (body) => fetch(`${base}/jobs`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body });
  assert.equal((await post('{nope')).status, 400);
  assert.equal((await post(JSON.stringify({ ...job, model: 'x' }))).status, 400);
  const unknownUpload = await post(JSON.stringify({ ...job, idempotencyKey: 'key-server-02', references: ['a'.repeat(32)] }));
  assert.equal(unknownUpload.status, 400);
  assert.match((await unknownUpload.json()).error.message, /Unknown upload id/);
  assert.equal((await fetch(`${base}/jobs/missing`, { headers: auth })).status, 404);
  assert.equal((await fetch(`${base}/jobs/missing/outputs/0`, { headers: auth })).status, 404);
});

test('tool calls run under the mutex and return their result', async (t) => {
  const { server, base, auth } = await start({ callTool: async (name, args) => ({ name, args }) });
  t.after(() => server.close());
  const response = await fetch(`${base}/tools/flow_status`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ full: true }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(await response.text()), { ok: true, result: { name: 'flow_status', args: { full: true } } });
});

test('tool failures come back as ok:false with a code', async (t) => {
  const { server, base, auth } = await start({ callTool: async () => { throw Object.assign(new Error('boom'), { code: 'UNKNOWN_UI_CHANGE' }); } });
  t.after(() => server.close());
  const text = await (await fetch(`${base}/tools/flow_status`, { method: 'POST', headers: auth, body: '{}' })).text();
  assert.deepEqual(JSON.parse(text), { ok: false, error: { code: 'UI_CHANGED', message: 'boom', details: {} } });
});
