import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UploadStore } from '../src/daemon/upload-store.js';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flow-uploads-'));

test('stores bytes content-addressed and resolves ids', () => {
  const store = new UploadStore(dir());
  const first = store.put(Buffer.from('png-bytes'), 'image/png');
  const second = store.put(Buffer.from('png-bytes'), 'image/png');
  assert.match(first.id, /^[a-f0-9]{32}$/);
  assert.equal(first.id, second.id);
  assert.equal(fs.readFileSync(store.resolve(first.id), 'utf8'), 'png-bytes');
});

test('rejects unsupported types, empty bodies and bad ids', () => {
  const store = new UploadStore(dir());
  assert.throws(() => store.put(Buffer.from('x'), 'image/gif'), (err) => err.code === 'INVALID_REQUEST');
  assert.throws(() => store.put(Buffer.alloc(0), 'image/png'), (err) => err.code === 'INVALID_REQUEST');
  assert.equal(store.resolve('../../etc/passwd'), undefined);
  assert.equal(store.resolve('f'.repeat(32)), undefined);
});
