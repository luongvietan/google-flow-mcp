import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaywrightFlowDriver } from '../src/daemon/playwright-driver.js';
import { FlowError, ErrorCodes } from '../src/utils/errors.js';

class FakeSession {
  constructor({ account = 'bot@example.com', media, downloadFails = false } = {}) {
    Object.assign(this, { accountValue: account, calls: [], downloadFails });
    this.fresh = media ?? [{ kind: 'image', uuid: 'u-new', url: 'https://flow-content.google/image/u-new?Signature=x' }];
  }
  async account() { this.calls.push('account'); return this.accountValue; }
  async openProject(name) { this.calls.push(`open:${name}`); return 'https://flow.google.com/project/p'; }
  async configure(options) { this.calls.push(`configure:${options.kind}:${options.flowModel}:${options.aspectRatio}`); }
  async clearPrompt() { this.calls.push('clear'); }
  async attachIngredients(files) { this.calls.push(`attach:${files.join(',')}`); }
  async mediaSnapshot() { this.calls.push('snapshot'); return [{ kind: 'image', uuid: 'u-old', url: 'x' }]; }
  async typePrompt(text) { this.calls.push('type'); this.prompt = text; }
  async send() { this.calls.push('send'); }
  async waitForMedia(kind, baseline) { this.calls.push(`wait:${kind}:${[...baseline].join(',')}`); return this.fresh; }
  async download(media, dir) {
    this.calls.push(`download:${media.uuid}`);
    if (this.downloadFails) throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, 'broken', { mediaUuids: [media.uuid] });
    return { file: `${dir}/x.jpg`, mediaType: 'image/jpeg', mediaUuid: media.uuid };
  }
}

function driverWith(session, expectedAccount = 'bot@example.com') {
  return new PlaywrightFlowDriver({ expectedAccount, connect: async () => ({}), sessionFactory: () => session, renderTimeoutMs: 1000 });
}
const imageJob = { kind: 'image', model: 'nano-banana-2', flowModel: 'Nano Banana 2', prompt: 'an apple', aspectRatio: '1:1',
  project: 'demo', outputDir: 'out', inputs: { references: ['r.png'], ingredients: [] } };

test('runs the full image pipeline in order', async () => {
  const session = new FakeSession();
  const media = await driverWith(session).generateImage(imageJob, () => {});
  assert.deepEqual(session.calls, [
    'account', 'open:demo', 'configure:image:Nano Banana 2:1:1', 'clear', 'attach:r.png',
    'snapshot', 'type', 'send', 'wait:image:u-old', 'download:u-new',
  ]);
  assert.match(session.prompt, /attached image 1 as a visual reference/);
  assert.deepEqual(media, [{ file: 'out/x.jpg', mediaType: 'image/jpeg', mediaUuid: 'u-new' }]);
});

test('video jobs attach frames first and keep only the first result', async () => {
  const session = new FakeSession({ media: [
    { kind: 'video', uuid: 'v1', url: 'a' }, { kind: 'video', uuid: 'v2', url: 'b' }] });
  const job = { ...imageJob, kind: 'video', model: 'veo-3.1-lite', flowModel: 'Veo 3.1 - Lite', aspectRatio: '9:16', duration: 8,
    inputs: { references: [], ingredients: ['i.png'], firstFrame: 'f.png' } };
  const media = await driverWith(session).generateVideo(job, () => {});
  assert.ok(session.calls.includes('attach:f.png,i.png'));
  assert.match(session.prompt, /^Generate exactly one 8-second video now\./);
  assert.equal(media.length, 1);
  assert.equal(media[0].mediaUuid, 'v1');
});

test('skips attaching when there are no inputs', async () => {
  const session = new FakeSession();
  await driverWith(session).generateImage({ ...imageJob, inputs: { references: [], ingredients: [] } }, () => {});
  assert.equal(session.calls.some((call) => call.startsWith('attach')), false);
});

test('refuses a different signed-in account before touching the project', async () => {
  const session = new FakeSession({ account: 'someone@example.com' });
  await assert.rejects(driverWith(session).generateImage(imageJob, () => {}), (err) => err.code === 'ACCOUNT_MISMATCH');
  assert.deepEqual(session.calls, ['account']);
});

test('a failed download keeps the media uuid for the runner retry', async () => {
  const session = new FakeSession({ downloadFails: true });
  await assert.rejects(driverWith(session).generateImage(imageJob, () => {}),
    (err) => err.code === 'DOWNLOAD_FAILED' && err.details.mediaUuids[0] === 'u-new');
});

test('health reports the real account', async () => {
  const health = await driverWith(new FakeSession({ account: 'bot@example.com' })).health();
  assert.deepEqual(health, { chrome: true, loggedIn: true, account: 'bot@example.com' });
  const signedOut = await driverWith(new FakeSession({ account: null })).health();
  assert.equal(signedOut.loggedIn, false);
});
