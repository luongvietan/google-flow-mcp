import test from 'node:test';
import assert from 'node:assert/strict';
import { FlowSession } from '../src/flow/session.js';

test('reuses a matching uploaded asset without waiting for a duplicate entry', async () => {
  const calls = [];
  let chips = 0;
  const asset = { click: async () => { calls.push('select'); chips++; }, elementHandle: async () => { throw new Error('Picker closed after selecting existing image'); } };
  const named = { count: async () => 1, first: () => asset };
  const confirm = { isVisible: async () => false, click: async () => calls.push('confirm'), elementHandle: async () => ({}) };
  const page = {
    locator(selector) {
      if (selector === '.asset-item') return { filter: () => named };
      if (selector.startsWith('button.chip-container')) return { count: async () => chips };
      if (selector === 'button') return { filter: () => ({ first: () => confirm }) };
      throw new Error(`Unexpected locator ${selector}`);
    },
    waitForTimeout: async () => {}, waitForFunction: async () => {},
    waitForEvent: async () => { throw new Error('Existing content must not be uploaded again'); },
  };
  const session = new FlowSession(page, { registryFile: 'unused' });
  session.dismissOverlays = async () => {};
  session.icon = (name) => ({ last: () => ({ click: async () => calls.push(name) }), first: () => ({ waitFor: async () => {}, click: async () => calls.push('upload') }) });
  await session.attachIngredients(['content-addressed.jpg']);
  assert.deepEqual(calls, ['add', 'select']);
});

test('model verification rejects actual metadata naming Omni and removes its response listener', async () => {
  const id = '51d06863-6526-4bed-ac77-7abd803f1709';
  const pair = (key, value) => [key, [null, null, value]];
  const text = JSON.stringify([['wrb.fr', 'GN0Bre', JSON.stringify([[], [[[], [[pair('prompt', 'Use exactly the Veo 3.1 - Lite model'), pair('model_display_name', 'Omni 1.1 Flash'), pair('media_id', id)]]]]])]]);
  let listener; let removed = false;
  const page = {
    on: (_event, callback) => { listener = callback; }, off: (_event, callback) => { assert.equal(callback, listener); removed = true; },
    reload: async () => listener({ url: () => 'https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute', text: async () => text }),
    waitForTimeout: async () => {},
  };
  const session = new FlowSession(page, { registryFile: 'unused' });
  await assert.rejects(session.verifyMediaModel({ kind: 'video', uuid: id, url: 'https://flow-content.google/video/test?Signature=fixture' }, 'Veo 3.1 - Lite'),
    (error) => error.code === 'UNSUPPORTED_INPUT' && error.details.actualModel === 'Omni 1.1 Flash');
  assert.equal(removed, true);
});

test('credit reading restores the page header after tile scrolling', async () => {
  const calls = [];
  const panel = { isVisible: async () => false, waitFor: async () => {}, innerText: async () => '854 tín dụng Google Flow', locator: () => ({ first: () => ({ click: async () => calls.push('close') }) }) };
  const page = {
    evaluate: async () => calls.push('scroll'), waitForTimeout: async () => {},
    locator: (selector) => selector === '[role="dialog"]' ? { filter: () => ({ first: () => panel }) } : { filter: () => ({ first: () => ({ click: async () => { assert.equal(calls[0], 'scroll'); calls.push('open'); } }) }) },
  };
  const session = new FlowSession(page, { registryFile: 'unused' }); session.dismissOverlays = async () => {};
  assert.equal(await session.credits(), 854); assert.deepEqual(calls, ['scroll', 'open', 'close']);
});
