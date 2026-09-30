import test from 'node:test';
import assert from 'node:assert/strict';
import { validateJobRequest } from '../src/daemon/validate.js';

const image = { kind: 'image', model: 'nano-banana-2', prompt: 'a cat', aspectRatio: '9:16',
  confirmCredits: true, idempotencyKey: 'key-00000001' };
const video = { kind: 'video', model: 'veo-3.1-lite', prompt: 'a cat runs', aspectRatio: '16:9',
  duration: 8, confirmCredits: true, idempotencyKey: 'key-00000002' };

function rejects(body, pattern) {
  assert.throws(() => validateJobRequest(body), (err) => err.code === 'INVALID_REQUEST' && pattern.test(err.message));
}

test('normalizes a valid image request', () => {
  assert.deepEqual(validateJobRequest(image), {
    kind: 'image', model: 'nano-banana-2', prompt: 'a cat', aspectRatio: '9:16', duration: undefined,
    references: [], firstFrame: undefined, lastFrame: undefined, ingredients: [], project: undefined,
    confirmCredits: true, idempotencyKey: 'key-00000001',
  });
});

test('normalizes a valid video request with frames', () => {
  const result = validateJobRequest({ ...video, firstFrame: 'a'.repeat(32), ingredients: ['b'.repeat(32)] });
  assert.equal(result.duration, 8);
  assert.equal(result.firstFrame, 'a'.repeat(32));
  assert.deepEqual(result.ingredients, ['b'.repeat(32)]);
});

test('missing confirmCredits normalizes to false', () => {
  assert.equal(validateJobRequest({ ...image, confirmCredits: undefined }).confirmCredits, false);
});

test('rejects malformed requests', () => {
  rejects(null, /JSON object/);
  rejects({ ...image, kind: 'audio' }, /kind/);
  rejects({ ...image, model: 'seedance-2-mini' }, /Unknown model/);
  rejects({ ...image, model: 'veo-3.1-lite' }, /video model, not image/);
  rejects({ ...image, prompt: '  ' }, /prompt/);
  rejects({ ...image, aspectRatio: 'wide' }, /aspectRatio/);
  rejects({ ...image, duration: 8 }, /only to video/);
  rejects({ ...video, duration: 7.5 }, /duration/);
  rejects({ ...image, firstFrame: 'a'.repeat(32) }, /only to video/);
  rejects({ ...video, references: ['a'.repeat(32)] }, /only to image/);
  rejects({ ...image, references: [42] }, /references/);
  rejects({ ...image, idempotencyKey: 'short' }, /idempotencyKey/);
  rejects({ ...image, project: '' }, /project/);
  rejects({ ...video, aspectRatio: '1:1' }, /not available for video/);
  rejects({ ...image, aspectRatio: '2:1' }, /not available for image/);
});
