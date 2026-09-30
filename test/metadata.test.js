import test from 'node:test';
import assert from 'node:assert/strict';
import { extractRenderedModels } from '../src/flow/metadata.js';
const id = '51d06863-6526-4bed-ac77-7abd803f1709';
const pair = (key, value) => [key, [null, null, value]];
const rpc = (records) => `)]}'\n\n123\n${JSON.stringify([['wrb.fr', 'GN0Bre', JSON.stringify([[], records.map(record => [[], [record]])])]])}\n`;
test('persisted metadata binds model to media id and ignores model names in prompt strings', () => {
  const body = [[pair('prompt', 'Use exactly the Veo 3.1 - Lite model'), pair('model_display_name', 'Omni 1.1 Flash'), [pair('media_id', id)]]];
  assert.equal(extractRenderedModels(rpc(body)).get(id), 'Omni 1.1 Flash');
});
test('image metadata strips the UI banana icon, and incomplete/conflicting metadata fails closed', () => {
  assert.equal(extractRenderedModels(rpc([[pair('model_display_name', '🍌 Nano Banana 2 Lite'), pair('media_id', id)]])).get(id), 'Nano Banana 2 Lite');
  assert.equal(extractRenderedModels(rpc([[pair('prompt', 'Nano Banana Pro'), pair('media_id', id)]])).has(id), false);
  const rows = ['Nano Banana Pro', 'Nano Banana 2'].map(model => [pair('model_display_name', model), pair('media_id', id)]);
  assert.equal(extractRenderedModels(rpc(rows)).get(id), null);
  assert.equal(extractRenderedModels('invalid').size, 0);
  assert.equal(extractRenderedModels(rpc([[pair('model_display_name', 'Veo 3.1 - Lite')], [pair('media_id', id)]])).has(id), false, 'orphan fields across history records must not be joined');
  const other = '11d06863-6526-4bed-ac77-7abd803f1709';
  assert.equal(extractRenderedModels(rpc([[pair('model_display_name', 'Nano Banana Pro'), pair('media_id', id)], [pair('media_id', other)]])).has(other), false);
  assert.equal(extractRenderedModels(rpc([[pair('model_display_name', 'Future Model'), pair('media_id', id)], [pair('model_display_name', 'Nano Banana Pro'), pair('media_id', other)]])).get(id), 'Future Model');
});
