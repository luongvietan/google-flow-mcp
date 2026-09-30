import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobStore } from '../src/daemon/job-store.js';

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-store-')), 'jobs.json');
}
const request = (key) => ({ kind: 'image', model: 'nano-banana-2', prompt: 'p', aspectRatio: '1:1',
  references: [], ingredients: [], confirmCredits: true, idempotencyKey: key });

test('creates, persists and reloads jobs in submission order', () => {
  const file = tempFile();
  const store = new JobStore(file);
  const a = store.create(request('key-aaaaaaaa'));
  const b = store.create(request('key-bbbbbbbb'));
  assert.equal(a.state, 'queued');
  const reloaded = new JobStore(file);
  assert.deepEqual(reloaded.queued().map((job) => job.id), [a.id, b.id]);
  assert.equal(reloaded.queuePosition(b.id), 2);
});

test('update persists and unknown ids throw', () => {
  const file = tempFile();
  const store = new JobStore(file);
  const job = store.create(request('key-cccccccc'));
  store.update(job.id, { state: 'running', phase: 'rendering' });
  assert.equal(new JobStore(file).get(job.id).phase, 'rendering');
  assert.throws(() => store.update('nope', {}), /Unknown job/);
});

test('findReusable returns active or succeeded jobs, never failed ones', () => {
  const store = new JobStore(tempFile());
  const job = store.create(request('key-dddddddd'));
  assert.equal(store.findReusable('key-dddddddd').id, job.id);
  store.update(job.id, { state: 'succeeded' });
  assert.equal(store.findReusable('key-dddddddd').id, job.id);
  store.update(job.id, { state: 'failed' });
  assert.equal(store.findReusable('key-dddddddd'), undefined);
});

test('recoverInterrupted marks running jobs interrupted', () => {
  const file = tempFile();
  const store = new JobStore(file);
  const job = store.create(request('key-eeeeeeee'));
  store.update(job.id, { state: 'running' });
  const again = new JobStore(file);
  assert.deepEqual(again.recoverInterrupted(), [job.id]);
  const recovered = new JobStore(file).get(job.id);
  assert.equal(recovered.state, 'interrupted');
  assert.equal(recovered.error.code, 'INTERRUPTED');
});
