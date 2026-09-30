import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobStore } from '../src/daemon/job-store.js';
import { UploadStore } from '../src/daemon/upload-store.js';
import { Mutex } from '../src/daemon/mutex.js';
import { JobRunner } from '../src/daemon/runner.js';
import { FlowError, ErrorCodes } from '../src/utils/errors.js';
import { FakeDriver } from './fake-driver.js';

function setup(behavior) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-runner-'));
  const file = path.join(root, 'jobs.json');
  const store = new JobStore(file);
  const uploads = new UploadStore(path.join(root, 'uploads'));
  const driver = new FakeDriver(behavior);
  const mutex = new Mutex();
  const runner = new JobRunner({ store, uploads, driver, mutex, outputsDir: path.join(root, 'outputs') });
  return { store, uploads, driver, runner, mutex, file };
}
const image = (key, extra = {}) => ({ kind: 'image', model: 'nano-banana-2', prompt: 'p', aspectRatio: '1:1',
  duration: undefined, references: [], firstFrame: undefined, lastFrame: undefined, ingredients: [],
  project: 'demo', confirmCredits: true, idempotencyKey: key, ...extra });

test('runs a job to success and records hashed outputs', async () => {
  const { store, runner, driver } = setup();
  const { job, deduplicated } = runner.enqueue(image('key-00000001'));
  assert.equal(deduplicated, false);
  await runner.idle();
  const done = store.get(job.id);
  assert.equal(done.state, 'succeeded');
  assert.equal(done.outputs.length, 1);
  const bytes = fs.readFileSync(done.outputs[0].file);
  assert.equal(done.outputs[0].sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.equal(done.outputs[0].mediaType, 'image/png');
  assert.equal(done.outputs[0].bytes, bytes.length);
  assert.deepEqual(done.mediaUuids, ['uuid-1']);
  assert.equal(driver.calls[0].job.flowModel, 'Nano Banana 2');
});

test('deduplicates by idempotency key', async () => {
  const { runner, driver } = setup();
  const first = runner.enqueue(image('key-00000002'));
  const second = runner.enqueue(image('key-00000002'));
  assert.equal(second.deduplicated, true);
  assert.equal(second.job.id, first.job.id);
  await runner.idle();
  assert.equal(driver.calls.length, 1);
});

test('refuses to run without confirmCredits and never touches the driver', async () => {
  const { store, runner, driver } = setup();
  const { job } = runner.enqueue(image('key-00000003', { confirmCredits: false }));
  await runner.idle();
  assert.equal(store.get(job.id).state, 'failed');
  assert.equal(store.get(job.id).error.code, 'CREDITS_NOT_CONFIRMED');
  assert.equal(driver.calls.length, 0);
});

test('runs jobs strictly one at a time in submission order', async () => {
  const { runner, driver } = setup({ delayMs: 15 });
  runner.enqueue(image('key-0000000a'));
  runner.enqueue(image('key-0000000b'));
  runner.enqueue(image('key-0000000c'));
  await runner.idle();
  assert.equal(driver.maxActive, 1);
  assert.deepEqual(driver.calls.map((call) => call.job.idempotencyKey), ['key-0000000a', 'key-0000000b', 'key-0000000c']);
});

test('maps driver failures to daemon codes', async () => {
  const { store, runner } = setup({ fail: new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, 'no prompt box') });
  const { job } = runner.enqueue(image('key-00000004'));
  await runner.idle();
  assert.deepEqual(store.get(job.id).error, { code: 'UI_CHANGED', message: 'no prompt box', details: {} });
});

test('retries a failed download by media uuid without regenerating', async () => {
  const fail = new FlowError(ErrorCodes.DOWNLOAD_FAILED, 'download broke', { mediaUuids: ['m-1'] });
  const { store, runner, driver } = setup({ fail });
  const { job } = runner.enqueue(image('key-00000005'));
  await runner.idle();
  assert.equal(store.get(job.id).state, 'succeeded');
  assert.deepEqual(driver.calls.map((call) => call.op), ['image', 'redownload']);
});

test('gives up after the download retries are exhausted', async () => {
  const fail = new FlowError(ErrorCodes.DOWNLOAD_FAILED, 'download broke', { mediaUuids: ['m-1'] });
  const { store, runner, driver } = setup({ fail, redownloadFails: true });
  const { job } = runner.enqueue(image('key-00000006'));
  await runner.idle();
  assert.equal(store.get(job.id).error.code, 'DOWNLOAD_FAILED');
  assert.equal(driver.calls.filter((call) => call.op === 'redownload').length, 3);
});

test('resolves upload ids to files for the driver', async () => {
  const { uploads, runner, driver } = setup();
  const upload = uploads.put(Buffer.from('ref'), 'image/png');
  runner.enqueue(image('key-00000007', { references: [upload.id] }));
  await runner.idle();
  assert.deepEqual(driver.calls[0].job.inputs.references, [upload.file]);
});

test('reports status', async () => {
  const { runner } = setup({ delayMs: 20 });
  runner.enqueue(image('key-00000008'));
  runner.enqueue(image('key-00000009'));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(runner.status().queued, 1);
  assert.notEqual(runner.status().running, null);
  await runner.idle();
  assert.deepEqual(runner.status(), { running: null, queued: 0 });
});

test('a job waiting for the browser stays queued, so a restart re-runs it instead of marking it interrupted', async () => {
  const { store, runner, mutex, file } = setup();
  let release;
  const toolCall = mutex.run(() => new Promise((resolve) => { release = resolve; }));
  const { job } = runner.enqueue(image('key-0000000w'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.get(job.id).state, 'queued');
  assert.deepEqual(new JobStore(file).recoverInterrupted(), []);
  release();
  await toolCall;
  await runner.idle();
  assert.equal(store.get(job.id).state, 'succeeded');
});
