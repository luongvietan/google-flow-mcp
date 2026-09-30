import test from 'node:test';
import assert from 'node:assert/strict';
import { DaemonError, JobErrorCodes, toJobError, redact } from '../src/daemon/errors.js';
import { FlowError, ErrorCodes } from '../src/utils/errors.js';
import { WIRE_MODELS } from '../src/daemon/models.js';

test('DaemonError keeps its code and details', () => {
  const error = toJobError(new DaemonError(JobErrorCodes.INVALID_REQUEST, 'bad', { field: 'prompt' }));
  assert.deepEqual(error, { code: 'INVALID_REQUEST', message: 'bad', details: { field: 'prompt' } });
});

test('legacy FlowError codes map to daemon codes', () => {
  assert.equal(toJobError(new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, 'x')).code, 'UI_CHANGED');
  assert.equal(toJobError(new FlowError(ErrorCodes.GENERATION_BUTTON_DISABLED, 'x')).code, 'UI_CHANGED');
  assert.equal(toJobError(new FlowError(ErrorCodes.GENERATION_TIMEOUT, 'x')).code, 'RENDER_TIMEOUT');
  assert.equal(toJobError(new FlowError(ErrorCodes.WRONG_GOOGLE_ACCOUNT, 'x')).code, 'ACCOUNT_MISMATCH');
  assert.equal(toJobError(new FlowError(ErrorCodes.GOOGLE_LIMIT_REACHED, 'x')).code, 'INSUFFICIENT_CREDITS');
  assert.equal(toJobError(new FlowError(ErrorCodes.BROWSER_NOT_CONNECTED, 'x')).code, 'BROWSER_UNAVAILABLE');
  assert.equal(toJobError(new FlowError(ErrorCodes.MODEL_NOT_AVAILABLE, 'x')).code, 'INVALID_REQUEST');
});

test('unknown errors become INTERNAL and messages are redacted', () => {
  const error = toJobError(new Error('failed at https://labs.google/fx/api?name=abc token'));
  assert.equal(error.code, 'INTERNAL');
  assert.equal(error.message, 'failed at [redacted-url] token');
  assert.equal(redact('see http://x.y/z now'), 'see [redacted-url] now');
});

test('wire models declare kind and Flow label', () => {
  assert.deepEqual(WIRE_MODELS['nano-banana-2'], { kind: 'image', flowName: 'Nano Banana 2' });
  assert.deepEqual(WIRE_MODELS['veo-3.1-lite'], { kind: 'video', flowName: 'Veo 3.1 - Lite' });
  assert.equal(Object.keys(WIRE_MODELS).length, 6);
});
