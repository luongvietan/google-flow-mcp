import test from 'node:test';
import assert from 'node:assert/strict';
import { callTool } from '../src/daemon/tool-handlers.js';

const noDriver = { driver: { generateImage: () => assert.fail('driver called'), generateVideo: () => assert.fail('driver called') }, outputsDir: 'out' };

test('MCP generate tools validate like daemon jobs before touching Flow', async () => {
  for (const [name, args, pattern] of [
    ['flow_generate_video', { prompt: 'a boat', ratio: '1:1', auto_confirm: true }, /not available for video/],
    ['flow_generate_image', { prompt: 'an apple', ratio: '2:1', auto_confirm: true }, /not available for image/],
    ['flow_generate_image', { prompt: ' ', auto_confirm: true }, /prompt is required/],
    ['flow_generate_video', { prompt: 'a boat', ratio: '1:1' }, /not available for video/],
  ]) {
    await assert.rejects(callTool(name, args, noDriver), (err) => err.code === 'INVALID_REQUEST' && pattern.test(err.message), name);
  }
});

test('auto_confirm false returns ready_for_confirmation without the driver', async () => {
  const result = await callTool('flow_generate_video', { prompt: 'a boat', model: 'lite', duration: '8s' }, noDriver);
  assert.equal(result.status, 'ready_for_confirmation');
  assert.equal(result.model_used, 'Veo 3.1 - Lite');
  assert.equal(result.duration, 8);
});
