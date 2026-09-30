import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FLOW_HOME, RATIO_ICONS, parseAccountLabel, extractMedia, isProjectUrl,
  orderIngredients, buildPrompt, legacyModel, parseDuration,
} from '../src/flow/ui.js';

const U1 = 'c4dbeffe-73c5-45ad-ada7-47fe6b6c85fa';
const U2 = '0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0';

test('constants', () => {
  assert.equal(FLOW_HOME, 'https://flow.google.com/');
  assert.equal(RATIO_ICONS['9:16'], 'crop_9_16');
  assert.equal(RATIO_ICONS['4:3'], 'crop_landscape');
  assert.equal(isProjectUrl(`https://flow.google.com/project/${U1}`), true);
  assert.equal(isProjectUrl('https://flow.google.com/'), false);
});

test('parseAccountLabel reads the email out of the account chip label', () => {
  assert.equal(parseAccountLabel('Tài khoản Google: Nhu Quynh  \n(nhuquynh.231123@gmail.com), Gói thành viên của Google'),
    'nhuquynh.231123@gmail.com');
  assert.equal(parseAccountLabel('Google Account: A B (a.b@example.com)'), 'a.b@example.com');
  assert.equal(parseAccountLabel(null), null);
  assert.equal(parseAccountLabel('no email here'), null);
});

test('extractMedia keeps signed flow-content URLs, deduplicated by uuid', () => {
  const signed = `https://flow-content.google/image/${U1}?Expires=1&KeyName=k&Signature=s`;
  const media = extractMedia([
    signed, signed.replace('Signature=s', 'Signature=t'),
    `https://flow-content.google/video/${U2}?Expires=1&KeyName=k&Signature=v`,
    `https://flow-content.google/image/${U2}`, 'https://example.com/x.png', '',
  ]);
  assert.deepEqual(media, [
    { kind: 'image', uuid: U1, url: signed },
    { kind: 'video', uuid: U2, url: `https://flow-content.google/video/${U2}?Expires=1&KeyName=k&Signature=v` },
  ]);
});

test('orderIngredients puts frames first, then ingredients, then references', () => {
  const job = { inputs: { firstFrame: 'f.png', lastFrame: 'l.png', ingredients: ['i1.png', 'i2.png'], references: ['r.png'] } };
  assert.deepEqual(orderIngredients(job), [
    { role: 'firstFrame', file: 'f.png' }, { role: 'lastFrame', file: 'l.png' },
    { role: 'ingredient', file: 'i1.png' }, { role: 'ingredient', file: 'i2.png' },
    { role: 'reference', file: 'r.png' },
  ]);
  assert.deepEqual(orderIngredients({ inputs: { references: [], ingredients: [] } }), []);
});

test('buildPrompt states kind, duration and attachment roles', () => {
  const video = buildPrompt({ kind: 'video', duration: 8, prompt: 'a cat jumps' },
    [{ role: 'firstFrame', file: 'f' }, { role: 'ingredient', file: 'i' }]);
  assert.match(video, /^Generate exactly one 8-second video now\./);
  assert.match(video, /attached image 1 as the exact first frame/);
  assert.match(video, /attached image 2 as a visual ingredient/);
  assert.match(video, /Description: a cat jumps$/);
  assert.equal(video.includes('\n'), false, 'single line: Enter would submit');
  const image = buildPrompt({ kind: 'image', prompt: 'an apple' }, [{ role: 'reference', file: 'r' }]);
  assert.match(image, /^Generate exactly one image now\./);
  assert.match(image, /attached image 1 as a visual reference/);
});

test('buildPrompt names the exact model and forbids automatic substitution', () => {
  const prompt = buildPrompt({ kind: 'video', duration: 8, flowModel: 'Veo 3.1 - Lite', prompt: 'an apple' }, []);
  assert.match(prompt, /Use exactly the Veo 3\.1 - Lite model/);
  assert.match(prompt, /Do not substitute another model/);
  assert.match(prompt, /do not generate/);
});

test('legacyModel maps MCP tool names to wire models', () => {
  assert.equal(legacyModel('image', undefined), 'nano-banana-2');
  assert.equal(legacyModel('image', 'Nano Banana Pro'), 'nano-banana-pro');
  assert.equal(legacyModel('image', 'nano-banana-2-lite'), 'nano-banana-2-lite');
  assert.equal(legacyModel('video', undefined), 'veo-3.1-fast');
  assert.equal(legacyModel('video', 'lite'), 'veo-3.1-lite');
  assert.equal(legacyModel('video', 'flash'), 'omni-flash');
  assert.equal(legacyModel('video', 'Veo 3.1 - Quality'), 'veo-3.1-quality');
  assert.throws(() => legacyModel('image', 'Imagen 4'), (err) => err.code === 'INVALID_REQUEST');
  assert.throws(() => legacyModel('image', 'lite'), (err) => err.code === 'INVALID_REQUEST');
});

test('parseDuration accepts "8s" and 8', () => {
  assert.equal(parseDuration('8s'), 8);
  assert.equal(parseDuration(6), 6);
  assert.equal(parseDuration(undefined), 8);
  assert.throws(() => parseDuration('long'), (err) => err.code === 'INVALID_REQUEST');
});
