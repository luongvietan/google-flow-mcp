# Flow Daemon Implementation Plan (Plan A1 of the Google Flow provider)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `google-flow-mcp` into a single background daemon that owns the Flow Chrome and a durable, serial job queue behind a loopback HTTP API, with the MCP server reduced to a thin client of that daemon.

**Architecture:** A `node:http` server in `src/daemon/` holds a mutex around every browser touch. Generation jobs (`POST /jobs`) are persisted in `data/jobs.json`, deduplicated by idempotency key and executed one at a time through a `FlowDriver` interface (Playwright implementation wraps the existing tool handlers; a fake is used in tests). The existing MCP tools are forwarded to `POST /tools/:name`, which runs the old handlers under the same mutex, so Claude and Hypit never drive Chrome concurrently.

**Tech Stack:** Node ≥ 22 ESM, `node:http`, `node:test`, existing Playwright/MCP SDK dependencies. No new npm dependencies.

**Spec:** `C:\Users\admin\Desktop\bulkgen\hypit\docs\superpowers\specs\2026-10-01-google-flow-provider-design.md`

**Scope of this plan (A1):** spec steps 1–2 (daemon, MCP proxy) plus the UI discovery that produces `config/capabilities.json`. Reference-image automation (image references, Frames to Video, Ingredients to Video), `FLOW_CLARIFICATION`/`CONTENT_REJECTED` detection and model/ratio fidelity fixes need the discovered UI facts and are **Plan A2**. The Hypit packages are **Plan B**. Until A2 lands, the daemon rejects reference inputs with `UNSUPPORTED_INPUT`.

**Repository:** all paths below are relative to `C:\Users\admin\Desktop\google-flow-mcp` unless stated. Run every command from that directory.

---

## File structure

| File | Responsibility |
| --- | --- |
| `src/daemon/errors.js` | Daemon error codes, `DaemonError`, mapping of legacy `FlowError` codes, URL redaction |
| `src/daemon/models.js` | Wire model id → `{ kind, flowName }` |
| `src/daemon/validate.js` | Validate/normalize a `POST /jobs` body |
| `src/daemon/job-store.js` | Durable job records, idempotency lookup, interrupted-job recovery |
| `src/daemon/upload-store.js` | Content-addressed reference uploads |
| `src/daemon/mutex.js` | Serializes every browser touch |
| `src/daemon/runner.js` | Executes queued jobs through a `FlowDriver`, maps failures, retries downloads |
| `src/daemon/token.js` | Create/load the local bearer token |
| `src/daemon/server.js` | HTTP routes, auth, body limits |
| `src/daemon/client.js` | HTTP client + `ensureDaemon()` auto-start (used by MCP; mirrored later by the Hypit provider) |
| `src/daemon/playwright-driver.js` | `FlowDriver` backed by the existing Playwright handlers |
| `src/daemon/tool-handlers.js` | The MCP tool switch moved out of `src/index.js` |
| `src/daemon/main.js` | Daemon entry point |
| `src/index.js` | MCP server, now a thin proxy to the daemon |
| `test/fake-driver.js` | `FlowDriver` test double |
| `test/*.test.js` | `node:test` suites |

`FlowDriver` contract (JSDoc, no TypeScript in this repo):

```js
/**
 * @typedef {{ file: string, mediaType: string, mediaUuid?: string }} GeneratedMedia
 * @typedef {{ references: string[], firstFrame?: string, lastFrame?: string, ingredients: string[] }} JobInputs  // absolute file paths
 * @typedef {object} DriverJob  // validated request + { flowModel: string, outputDir: string, inputs: JobInputs }
 * @typedef {object} FlowDriver
 * @property {() => Promise<{ chrome: boolean, loggedIn: boolean, account?: string, error?: string }>} health
 * @property {(job: DriverJob, progress: (phase: string) => void) => Promise<GeneratedMedia[]>} generateImage
 * @property {(job: DriverJob, progress: (phase: string) => void) => Promise<GeneratedMedia[]>} generateVideo
 * @property {(mediaUuid: string, kind: 'image'|'video', outputDir: string) => Promise<GeneratedMedia>} redownload
 */
```

---

### Task 0: Branch, test runner, ignore rules, stderr logging

**Files:**
- Modify: `package.json` (scripts)
- Modify: `.gitignore`
- Modify: `src/utils/logger.js`
- Create: `test/smoke.test.js`

The MCP stdio transport uses stdout for protocol frames; `logger.info` currently writes to stdout with `console.log`, which corrupts the stream. All log output moves to stderr.

- [ ] **Step 1: Create the branch**

```bash
git checkout -b feat/daemon
```

Expected: `Switched to a new branch 'feat/daemon'`

- [ ] **Step 2: Replace the scripts block in `package.json`**

Replace:

```json
  "scripts": {
    "start": "node src/index.js",
    "test": "node scripts/test-flow-image.sh",
    "discover": "node -e \"console.log('Run: bash scripts/test-flow-image.sh')\""
  },
```

with:

```json
  "scripts": {
    "start": "node src/index.js",
    "daemon": "node src/daemon/main.js",
    "test": "node --test \"test/*.test.js\""
  },
```

- [ ] **Step 3: Append to `.gitignore`**

```
data/
config/daemon-token
```

- [ ] **Step 4: Make every log level write to stderr** — in `src/utils/logger.js` replace the `info` and `debug` bodies:

```js
  info(msg, data = {}) {
    const line = `[${timestamp()}] INFO  ${msg} ${Object.keys(data).length ? JSON.stringify(data) : ''}`;
    console.error(line);
    getLogStream().write(line + '\n');
  },
```

```js
  debug(msg, data = {}) {
    const line = `[${timestamp()}] DEBUG ${msg} ${Object.keys(data).length ? JSON.stringify(data) : ''}`;
    if (process.env.DEBUG) {
      console.error(line);
    }
    getLogStream().write(line + '\n');
  }
```

(`warn` already uses `console.warn` → stderr; `error` uses `console.error`.)

- [ ] **Step 5: Add a smoke test** — `test/smoke.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

test('test runner works', () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 6: Run the tests**

Run: `npm test`
Expected: `# pass 1`, `# fail 0`

- [ ] **Step 7: Commit**

```bash
git add package.json .gitignore src/utils/logger.js test/smoke.test.js
git commit -m "chore: node:test runner, daemon script, stderr-only logging

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1: Error codes and model table

**Files:**
- Create: `src/daemon/errors.js`
- Create: `src/daemon/models.js`
- Test: `test/errors.test.js`

- [ ] **Step 1: Write the failing test** — `test/errors.test.js`:

```js
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '...src/daemon/errors.js'`

- [ ] **Step 3: Implement** — `src/daemon/errors.js`:

```js
export const JobErrorCodes = Object.freeze({
  INVALID_REQUEST: 'INVALID_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  NOT_FOUND: 'NOT_FOUND',
  DAEMON_UNAVAILABLE: 'DAEMON_UNAVAILABLE',
  BROWSER_UNAVAILABLE: 'BROWSER_UNAVAILABLE',
  NOT_LOGGED_IN: 'NOT_LOGGED_IN',
  ACCOUNT_MISMATCH: 'ACCOUNT_MISMATCH',
  CREDITS_NOT_CONFIRMED: 'CREDITS_NOT_CONFIRMED',
  UNSUPPORTED_INPUT: 'UNSUPPORTED_INPUT',
  FLOW_CLARIFICATION: 'FLOW_CLARIFICATION',
  CONTENT_REJECTED: 'CONTENT_REJECTED',
  INSUFFICIENT_CREDITS: 'INSUFFICIENT_CREDITS',
  UI_CHANGED: 'UI_CHANGED',
  RENDER_TIMEOUT: 'RENDER_TIMEOUT',
  DOWNLOAD_FAILED: 'DOWNLOAD_FAILED',
  INTERRUPTED: 'INTERRUPTED',
  INTERNAL: 'INTERNAL',
});

export class DaemonError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DaemonError';
    this.code = code;
    this.details = details;
  }
}

// Legacy handler codes (src/utils/errors.js) → public daemon codes.
const LEGACY = {
  WRONG_GOOGLE_ACCOUNT: JobErrorCodes.ACCOUNT_MISMATCH,
  NOT_LOGGED_IN: JobErrorCodes.NOT_LOGGED_IN,
  FLOW_PAGE_NOT_FOUND: JobErrorCodes.UI_CHANGED,
  UNKNOWN_UI_CHANGE: JobErrorCodes.UI_CHANGED,
  GENERATION_BUTTON_DISABLED: JobErrorCodes.UI_CHANGED,
  GENERATION_TIMEOUT: JobErrorCodes.RENDER_TIMEOUT,
  DOWNLOAD_FAILED: JobErrorCodes.DOWNLOAD_FAILED,
  GOOGLE_LIMIT_REACHED: JobErrorCodes.INSUFFICIENT_CREDITS,
  MANUAL_VERIFICATION_REQUIRED: JobErrorCodes.NOT_LOGGED_IN,
  BROWSER_NOT_CONNECTED: JobErrorCodes.BROWSER_UNAVAILABLE,
  PLAYWRIGHT_ERROR: JobErrorCodes.BROWSER_UNAVAILABLE,
  MODEL_NOT_AVAILABLE: JobErrorCodes.INVALID_REQUEST,
  RATIO_NOT_AVAILABLE: JobErrorCodes.INVALID_REQUEST,
  INVALID_PARAMS: JobErrorCodes.INVALID_REQUEST,
};

export function redact(message) {
  return String(message).replace(/https?:\/\/\S+/giu, '[redacted-url]');
}

export function toJobError(err) {
  const raw = err?.code;
  const code = Object.values(JobErrorCodes).includes(raw) ? raw : (LEGACY[raw] ?? JobErrorCodes.INTERNAL);
  const details = err?.details && typeof err.details === 'object' ? err.details : {};
  return { code, message: redact(err?.message ?? String(err)), details };
}
```

`src/daemon/models.js`:

```js
// Wire model ids shared with the Hypit provider → Flow UI labels used by the handlers.
export const WIRE_MODELS = Object.freeze({
  'nano-banana-2': { kind: 'image', flowName: 'Nano Banana 2' },
  'nano-banana-pro': { kind: 'image', flowName: 'Nano Banana Pro' },
  'veo-3.1-lite': { kind: 'video', flowName: 'Veo 3.1 - Lite' },
  'veo-3.1-fast': { kind: 'video', flowName: 'Veo 3.1 - Fast' },
  'veo-3.1-quality': { kind: 'video', flowName: 'Veo 3.1 - Quality' },
  'omni-flash': { kind: 'video', flowName: 'Omni Flash' },
});
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add src/daemon/errors.js src/daemon/models.js test/errors.test.js
git commit -m "feat(daemon): error codes and wire model table

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Job request validation

**Files:**
- Create: `src/daemon/validate.js`
- Test: `test/validate.test.js`

- [ ] **Step 1: Write the failing test** — `test/validate.test.js`:

```js
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
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '...src/daemon/validate.js'`

- [ ] **Step 3: Implement** — `src/daemon/validate.js`:

```js
import { DaemonError, JobErrorCodes } from './errors.js';
import { WIRE_MODELS } from './models.js';

const RATIO = /^\d{1,2}:\d{1,2}$/u;
const KEY = /^[A-Za-z0-9._:-]{8,128}$/u;

function invalid(message) {
  return new DaemonError(JobErrorCodes.INVALID_REQUEST, message);
}

function idList(body, name) {
  const value = body[name];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw invalid(`${name} must be an array of upload ids`);
  }
  return [...value];
}

function oneId(body, name) {
  const value = body[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) throw invalid(`${name} must be an upload id`);
  return value;
}

export function validateJobRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw invalid('Body must be a JSON object');
  const { kind, model, prompt, aspectRatio } = body;
  if (kind !== 'image' && kind !== 'video') throw invalid('kind must be "image" or "video"');
  const entry = WIRE_MODELS[model];
  if (!entry) throw invalid(`Unknown model "${model}"; known: ${Object.keys(WIRE_MODELS).join(', ')}`);
  if (entry.kind !== kind) throw invalid(`Model ${model} is a ${entry.kind} model, not ${kind}`);
  if (typeof prompt !== 'string' || prompt.trim().length === 0) throw invalid('prompt is required');
  if (typeof aspectRatio !== 'string' || !RATIO.test(aspectRatio)) throw invalid('aspectRatio like "9:16" is required');

  let duration;
  if (kind === 'video') {
    if (!Number.isInteger(body.duration) || body.duration <= 0) throw invalid('duration (whole seconds) is required for video');
    duration = body.duration;
  } else if (body.duration !== undefined) {
    throw invalid('duration applies only to video');
  }

  const references = idList(body, 'references');
  const ingredients = idList(body, 'ingredients');
  const firstFrame = oneId(body, 'firstFrame');
  const lastFrame = oneId(body, 'lastFrame');
  if (kind === 'image' && (ingredients.length > 0 || firstFrame !== undefined || lastFrame !== undefined)) {
    throw invalid('firstFrame, lastFrame and ingredients apply only to video');
  }
  if (kind === 'video' && references.length > 0) {
    throw invalid('references apply only to image; use firstFrame, lastFrame or ingredients for video');
  }

  if (typeof body.idempotencyKey !== 'string' || !KEY.test(body.idempotencyKey)) {
    throw invalid('idempotencyKey (8-128 characters of A-Z a-z 0-9 . _ : -) is required');
  }
  if (body.project !== undefined && (typeof body.project !== 'string' || body.project.trim().length === 0)) {
    throw invalid('project must be a non-empty string');
  }

  return {
    kind, model, prompt, aspectRatio, duration,
    references, firstFrame, lastFrame, ingredients,
    project: body.project,
    confirmCredits: body.confirmCredits === true,
    idempotencyKey: body.idempotencyKey,
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add src/daemon/validate.js test/validate.test.js
git commit -m "feat(daemon): validate job requests

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Durable job store

**Files:**
- Create: `src/daemon/job-store.js`
- Test: `test/job-store.test.js`

- [ ] **Step 1: Write the failing test** — `test/job-store.test.js`:

```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '...src/daemon/job-store.js'`

- [ ] **Step 3: Implement** — `src/daemon/job-store.js`:

```js
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const REUSABLE = new Set(['queued', 'running', 'succeeded']);

export class JobStore {
  constructor(file) {
    this.file = file;
    this.jobs = new Map();
    this.nextSeq = 1;
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const job of data.jobs) {
        this.jobs.set(job.id, job);
        this.nextSeq = Math.max(this.nextSeq, job.seq + 1);
      }
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version: 1, jobs: [...this.jobs.values()] }, null, 2));
    fs.renameSync(temp, this.file);
  }

  create(request, now = new Date()) {
    const job = {
      id: crypto.randomUUID(), seq: this.nextSeq++, state: 'queued', phase: 'queued', request,
      createdAt: now.toISOString(), startedAt: null, finishedAt: null, error: null, outputs: [], mediaUuids: [],
    };
    this.jobs.set(job.id, job);
    this.save();
    return job;
  }

  get(id) {
    return this.jobs.get(id);
  }

  update(id, patch) {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Unknown job ${id}`);
    Object.assign(job, patch);
    this.save();
    return job;
  }

  queued() {
    return [...this.jobs.values()].filter((job) => job.state === 'queued').sort((a, b) => a.seq - b.seq);
  }

  queuePosition(id) {
    const index = this.queued().findIndex((job) => job.id === id);
    return index < 0 ? null : index + 1;
  }

  findReusable(idempotencyKey) {
    for (const job of this.jobs.values()) {
      if (job.request.idempotencyKey === idempotencyKey && REUSABLE.has(job.state)) return job;
    }
    return undefined;
  }

  recoverInterrupted(now = new Date()) {
    const recovered = [];
    for (const job of this.jobs.values()) {
      if (job.state !== 'running') continue;
      Object.assign(job, {
        state: 'interrupted', phase: 'interrupted', finishedAt: now.toISOString(),
        error: { code: 'INTERRUPTED', details: {},
          message: 'The daemon restarted while this job was running. Flow credits may have been spent; the result may be in the Flow project.' },
      });
      recovered.push(job.id);
    }
    if (recovered.length > 0) this.save();
    return recovered;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add src/daemon/job-store.js test/job-store.test.js
git commit -m "feat(daemon): durable job store with idempotency and restart recovery

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Upload store and mutex

**Files:**
- Create: `src/daemon/upload-store.js`
- Create: `src/daemon/mutex.js`
- Test: `test/upload-store.test.js`
- Test: `test/mutex.test.js`

- [ ] **Step 1: Write the failing tests**

`test/upload-store.test.js`:

```js
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
```

`test/mutex.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { Mutex } from '../src/daemon/mutex.js';

test('runs tasks one at a time in order and survives failures', async () => {
  const mutex = new Mutex();
  const order = [];
  let active = 0;
  let maxActive = 0;
  const task = (name, ms, fail = false) => mutex.run(async () => {
    active += 1; maxActive = Math.max(maxActive, active);
    order.push(`start ${name}`);
    await new Promise((resolve) => setTimeout(resolve, ms));
    order.push(`end ${name}`);
    active -= 1;
    if (fail) throw new Error(name);
    return name;
  });
  assert.equal(mutex.busy, false);
  const results = await Promise.allSettled([task('a', 20), task('b', 5, true), task('c', 1)]);
  assert.equal(maxActive, 1);
  assert.deepEqual(order, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[2].value, 'c');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mutex.busy, false);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test`
Expected: FAIL — missing modules

- [ ] **Step 3: Implement**

`src/daemon/upload-store.js`:

```js
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DaemonError, JobErrorCodes } from './errors.js';

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const EXTENSIONS = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

export class UploadStore {
  constructor(dir) {
    this.dir = dir;
  }

  put(bytes, mediaType) {
    const extension = EXTENSIONS[mediaType];
    if (!extension) {
      throw new DaemonError(JobErrorCodes.INVALID_REQUEST, `Unsupported upload type ${mediaType}; use PNG, JPEG or WebP`);
    }
    if (bytes.length === 0) throw new DaemonError(JobErrorCodes.INVALID_REQUEST, 'Upload is empty');
    const id = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 32);
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, id + extension);
    if (!fs.existsSync(file)) fs.writeFileSync(file, bytes);
    return { id, mediaType, file };
  }

  resolve(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/u.test(id)) return undefined;
    for (const extension of Object.values(EXTENSIONS)) {
      const file = path.join(this.dir, id + extension);
      if (fs.existsSync(file)) return file;
    }
    return undefined;
  }
}
```

`src/daemon/mutex.js`:

```js
// Every browser touch (generation jobs, MCP tool calls, health probes) runs through one Mutex.
export class Mutex {
  #tail = Promise.resolve();
  #pending = 0;

  get busy() {
    return this.#pending > 0;
  }

  run(fn) {
    this.#pending += 1;
    const result = this.#tail.then(() => fn());
    this.#tail = result.then(() => undefined, () => undefined).finally(() => { this.#pending -= 1; });
    return result;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add src/daemon/upload-store.js src/daemon/mutex.js test/upload-store.test.js test/mutex.test.js
git commit -m "feat(daemon): content-addressed uploads and browser mutex

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Job runner with a fake driver

**Files:**
- Create: `test/fake-driver.js`
- Create: `src/daemon/runner.js`
- Test: `test/runner.test.js`

- [ ] **Step 1: Write the fake driver** — `test/fake-driver.js`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { FlowError, ErrorCodes } from '../src/utils/errors.js';

function write(dir, uuid, kind) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${uuid}.${kind === 'image' ? 'png' : 'mp4'}`);
  fs.writeFileSync(file, `${kind}:${uuid}`);
  return { file, mediaType: kind === 'image' ? 'image/png' : 'video/mp4', mediaUuid: uuid };
}

export class FakeDriver {
  constructor(behavior = {}) {
    this.behavior = behavior;
    this.calls = [];
    this.active = 0;
    this.maxActive = 0;
  }

  async health() {
    return this.behavior.health ?? { chrome: true, loggedIn: true, account: 'me@example.com' };
  }

  generateImage(job, progress) { return this.#generate('image', job, progress); }
  generateVideo(job, progress) { return this.#generate('video', job, progress); }

  async redownload(uuid, kind, outputDir) {
    this.calls.push({ op: 'redownload', uuid });
    if (this.behavior.redownloadFails) throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, 'still failing');
    return write(outputDir, uuid, kind);
  }

  async #generate(kind, job, progress) {
    this.calls.push({ op: kind, job });
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      progress('rendering');
      await new Promise((resolve) => setTimeout(resolve, this.behavior.delayMs ?? 5));
      if (this.behavior.fail) throw this.behavior.fail;
      return [write(job.outputDir, `uuid-${this.calls.length}`, kind)];
    } finally {
      this.active -= 1;
    }
  }
}
```

- [ ] **Step 2: Write the failing test** — `test/runner.test.js`:

```js
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
  const store = new JobStore(path.join(root, 'jobs.json'));
  const uploads = new UploadStore(path.join(root, 'uploads'));
  const driver = new FakeDriver(behavior);
  const runner = new JobRunner({ store, uploads, driver, mutex: new Mutex(), outputsDir: path.join(root, 'outputs') });
  return { store, uploads, driver, runner };
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
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '...src/daemon/runner.js'`

- [ ] **Step 4: Implement** — `src/daemon/runner.js`:

```js
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DaemonError, JobErrorCodes, toJobError } from './errors.js';
import { WIRE_MODELS } from './models.js';

export class JobRunner {
  #draining = null;
  #running = null;

  constructor({ store, uploads, driver, mutex, outputsDir, maxDownloadRetries = 3, log = () => {} }) {
    Object.assign(this, { store, uploads, driver, mutex, outputsDir, maxDownloadRetries, log });
  }

  enqueue(request) {
    const existing = this.store.findReusable(request.idempotencyKey);
    if (existing) return { job: existing, deduplicated: true };
    const job = this.store.create(request);
    this.kick();
    return { job, deduplicated: false };
  }

  kick() {
    if (this.#draining) return;
    this.#draining = this.#drain().finally(() => {
      this.#draining = null;
      if (this.store.queued().length > 0) this.kick();
    });
  }

  async idle() {
    while (this.#draining) await this.#draining;
  }

  status() {
    return { running: this.#running, queued: this.store.queued().length };
  }

  async #drain() {
    for (let next = this.store.queued()[0]; next; next = this.store.queued()[0]) {
      const id = next.id;
      this.store.update(id, { state: 'running', phase: 'waiting for browser', startedAt: new Date().toISOString() });
      this.#running = id;
      try {
        await this.mutex.run(() => this.#execute(id));
      } finally {
        this.#running = null;
      }
    }
  }

  #resolve(id) {
    const file = this.uploads.resolve(id);
    if (!file) throw new DaemonError(JobErrorCodes.INVALID_REQUEST, `Unknown upload id ${id}`);
    return file;
  }

  #inputs(request) {
    return {
      references: request.references.map((id) => this.#resolve(id)),
      firstFrame: request.firstFrame === undefined ? undefined : this.#resolve(request.firstFrame),
      lastFrame: request.lastFrame === undefined ? undefined : this.#resolve(request.lastFrame),
      ingredients: request.ingredients.map((id) => this.#resolve(id)),
    };
  }

  async #execute(id) {
    const { request } = this.store.get(id);
    const outputDir = path.join(this.outputsDir, id);
    const progress = (phase) => this.store.update(id, { phase });
    try {
      if (!request.confirmCredits) {
        throw new DaemonError(JobErrorCodes.CREDITS_NOT_CONFIRMED,
          'This job needs confirmCredits: true before Flow may spend credits');
      }
      const job = { ...request, flowModel: WIRE_MODELS[request.model].flowName, outputDir, inputs: this.#inputs(request) };
      progress('starting');
      let media;
      try {
        media = request.kind === 'image'
          ? await this.driver.generateImage(job, progress)
          : await this.driver.generateVideo(job, progress);
      } catch (err) {
        media = await this.#recoverDownload(err, request.kind, outputDir, progress);
      }
      if (media.length === 0) throw new DaemonError(JobErrorCodes.DOWNLOAD_FAILED, 'Flow returned no media');
      this.store.update(id, {
        state: 'succeeded', phase: 'done', finishedAt: new Date().toISOString(),
        outputs: media.map((item, index) => describe(item, index)),
        mediaUuids: media.map((item) => item.mediaUuid).filter(Boolean),
      });
      this.log('Job succeeded', { id, outputs: media.length });
    } catch (err) {
      const error = toJobError(err);
      this.store.update(id, { state: 'failed', phase: 'failed', finishedAt: new Date().toISOString(), error });
      this.log('Job failed', { id, code: error.code });
    }
  }

  async #recoverDownload(err, kind, outputDir, progress) {
    const uuids = err?.details?.mediaUuids ?? [];
    if (err?.code !== 'DOWNLOAD_FAILED' || uuids.length === 0) throw err;
    progress('retrying download');
    const media = [];
    let lastError = err;
    for (const uuid of uuids) {
      for (let attempt = 1; attempt <= this.maxDownloadRetries; attempt += 1) {
        try {
          media.push(await this.driver.redownload(uuid, kind, outputDir));
          break;
        } catch (retryError) {
          lastError = retryError;
        }
      }
    }
    if (media.length === 0) throw lastError;
    return media;
  }
}

function describe(item, index) {
  const bytes = fs.readFileSync(item.file);
  return {
    index, file: item.file, mediaType: item.mediaType, bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add src/daemon/runner.js test/fake-driver.js test/runner.test.js
git commit -m "feat(daemon): serial job runner with credit gate and download retry

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Token and HTTP server

**Files:**
- Create: `src/daemon/token.js`
- Create: `src/daemon/server.js`
- Test: `test/server.test.js`

- [ ] **Step 1: Write the failing test** — `test/server.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobStore } from '../src/daemon/job-store.js';
import { UploadStore } from '../src/daemon/upload-store.js';
import { Mutex } from '../src/daemon/mutex.js';
import { JobRunner } from '../src/daemon/runner.js';
import { createDaemonServer } from '../src/daemon/server.js';
import { loadOrCreateToken } from '../src/daemon/token.js';
import { FakeDriver } from './fake-driver.js';

async function start({ callTool = async () => ({ ok: 'tool' }) } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-server-'));
  const token = loadOrCreateToken(path.join(root, 'daemon-token'));
  const store = new JobStore(path.join(root, 'jobs.json'));
  const uploads = new UploadStore(path.join(root, 'uploads'));
  const mutex = new Mutex();
  const driver = new FakeDriver();
  const runner = new JobRunner({ store, uploads, driver, mutex, outputsDir: path.join(root, 'outputs') });
  const server = createDaemonServer({ token, store, uploads, runner, mutex, driver, expectedAccount: 'me@example.com', callTool });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { authorization: `Bearer ${token}` };
  return { server, base, auth, runner, token };
}
const job = { kind: 'image', model: 'nano-banana-2', prompt: 'a cat', aspectRatio: '1:1',
  confirmCredits: true, idempotencyKey: 'key-server-01' };

test('token is created once and reused', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-token-')), 'daemon-token');
  const first = loadOrCreateToken(file);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(loadOrCreateToken(file), first);
});

test('health is public and reports browser and queue', async (t) => {
  const { server, base } = await start();
  t.after(() => server.close());
  const body = await (await fetch(`${base}/health`)).json();
  assert.equal(body.ok, true);
  assert.equal(body.chrome, true);
  assert.equal(body.accountMatches, true);
  assert.deepEqual(body.queue, { running: null, queued: 0 });
});

test('everything else requires the bearer token', async (t) => {
  const { server, base } = await start();
  t.after(() => server.close());
  const response = await fetch(`${base}/jobs`, { method: 'POST', body: JSON.stringify(job) });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'UNAUTHORIZED');
});

test('upload, submit, poll and download a job', async (t) => {
  const { server, base, auth, runner } = await start();
  t.after(() => server.close());
  const upload = await (await fetch(`${base}/uploads`, {
    method: 'POST', headers: { ...auth, 'content-type': 'image/png' }, body: Buffer.from('ref'),
  })).json();
  assert.match(upload.id, /^[a-f0-9]{32}$/);

  const submitted = await fetch(`${base}/jobs`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ ...job, references: [upload.id] }),
  });
  assert.equal(submitted.status, 201);
  const { id, deduplicated } = await submitted.json();
  assert.equal(deduplicated, false);

  await runner.idle();
  const state = await (await fetch(`${base}/jobs/${id}`, { headers: auth })).json();
  assert.equal(state.state, 'succeeded');
  assert.equal(state.outputs[0].mediaType, 'image/png');
  assert.equal(state.outputs[0].file, undefined, 'local paths are not exposed');

  const output = await fetch(`${base}/jobs/${id}/outputs/0`, { headers: auth });
  assert.equal(output.headers.get('content-type'), 'image/png');
  assert.equal(await output.text(), 'image:uuid-1');

  const again = await fetch(`${base}/jobs`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ ...job, references: [upload.id] }),
  });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).deduplicated, true);
});

test('invalid bodies, unknown uploads and unknown jobs', async (t) => {
  const { server, base, auth } = await start();
  t.after(() => server.close());
  const post = (body) => fetch(`${base}/jobs`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body });
  assert.equal((await post('{nope')).status, 400);
  assert.equal((await post(JSON.stringify({ ...job, model: 'x' }))).status, 400);
  const unknownUpload = await post(JSON.stringify({ ...job, idempotencyKey: 'key-server-02', references: ['a'.repeat(32)] }));
  assert.equal(unknownUpload.status, 400);
  assert.match((await unknownUpload.json()).error.message, /Unknown upload id/);
  assert.equal((await fetch(`${base}/jobs/missing`, { headers: auth })).status, 404);
  assert.equal((await fetch(`${base}/jobs/missing/outputs/0`, { headers: auth })).status, 404);
});

test('tool calls run under the mutex and return their result', async (t) => {
  const { server, base, auth } = await start({ callTool: async (name, args) => ({ name, args }) });
  t.after(() => server.close());
  const response = await fetch(`${base}/tools/flow_status`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ full: true }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(await response.text()), { ok: true, result: { name: 'flow_status', args: { full: true } } });
});

test('tool failures come back as ok:false with a code', async (t) => {
  const { server, base, auth } = await start({ callTool: async () => { throw Object.assign(new Error('boom'), { code: 'UNKNOWN_UI_CHANGE' }); } });
  t.after(() => server.close());
  const text = await (await fetch(`${base}/tools/flow_status`, { method: 'POST', headers: auth, body: '{}' })).text();
  assert.deepEqual(JSON.parse(text), { ok: false, error: { code: 'UI_CHANGED', message: 'boom', details: {} } });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — missing `server.js` / `token.js`

- [ ] **Step 3: Implement**

`src/daemon/token.js`:

```js
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function loadOrCreateToken(file) {
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (/^[a-f0-9]{64}$/u.test(existing)) return existing;
  }
  const token = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, token, { mode: 0o600 });
  return token;
}
```

`src/daemon/server.js`:

```js
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { DaemonError, JobErrorCodes, toJobError } from './errors.js';
import { validateJobRequest } from './validate.js';
import { MAX_UPLOAD_BYTES } from './upload-store.js';

const MAX_JSON_BYTES = 1024 * 1024;
const STATUS = { INVALID_REQUEST: 400, UNAUTHORIZED: 401, NOT_FOUND: 404 };

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new DaemonError(JobErrorCodes.INVALID_REQUEST, `Request body exceeds ${limit} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const text = (await readBody(req, MAX_JSON_BYTES)).toString('utf8');
  if (text.trim().length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new DaemonError(JobErrorCodes.INVALID_REQUEST, 'Body is not valid JSON');
  }
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function authorized(req, token) {
  const header = req.headers.authorization ?? '';
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
  const expected = Buffer.from(token);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function publicJob(job, store) {
  return {
    id: job.id, state: job.state, phase: job.phase, queuePosition: store.queuePosition(job.id),
    createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt, error: job.error,
    outputs: job.outputs.map(({ index, mediaType, sha256, bytes }) => ({ index, mediaType, sha256, bytes })),
  };
}

export function createDaemonServer({ token, store, uploads, runner, mutex, driver, expectedAccount, callTool }) {
  let lastBrowser = { chrome: false, loggedIn: false };

  async function health() {
    // Never queue a probe behind a multi-minute render: report the last known state instead.
    let browser;
    if (mutex.busy) {
      browser = { ...lastBrowser, stale: true };
    } else {
      browser = await mutex.run(() => driver.health());
      lastBrowser = browser;
    }
    const accountMatches = expectedAccount && browser.account ? browser.account === expectedAccount : null;
    return { ok: true, ...browser, accountMatches, queue: runner.status() };
  }

  function requireJob(id) {
    const job = store.get(id);
    if (!job) throw new DaemonError(JobErrorCodes.NOT_FOUND, `Unknown job ${id}`);
    return job;
  }

  async function tool(req, res, name) {
    const args = await readJson(req);
    // Headers go out immediately and whitespace keeps the connection alive, so a
    // multi-minute tool call does not hit the client's header or body timeouts.
    res.writeHead(200, { 'content-type': 'application/json' });
    const keepAlive = setInterval(() => res.write(' '), 30_000);
    try {
      const result = await mutex.run(() => callTool(name, args));
      res.end(JSON.stringify({ ok: true, result }));
    } catch (err) {
      res.end(JSON.stringify({ ok: false, error: toJobError(err) }));
    } finally {
      clearInterval(keepAlive);
    }
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean);
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, await health());
    if (!authorized(req, token)) throw new DaemonError(JobErrorCodes.UNAUTHORIZED, 'Missing or wrong bearer token');

    if (req.method === 'POST' && url.pathname === '/uploads') {
      const mediaType = (req.headers['content-type'] ?? '').split(';')[0].trim();
      const upload = uploads.put(await readBody(req, MAX_UPLOAD_BYTES), mediaType);
      return send(res, 201, { id: upload.id, mediaType: upload.mediaType });
    }
    if (req.method === 'POST' && url.pathname === '/jobs') {
      const request = validateJobRequest(await readJson(req));
      for (const id of [...request.references, ...request.ingredients, request.firstFrame, request.lastFrame]) {
        if (id !== undefined && !uploads.resolve(id)) throw new DaemonError(JobErrorCodes.INVALID_REQUEST, `Unknown upload id ${id}`);
      }
      const { job, deduplicated } = runner.enqueue(request);
      return send(res, deduplicated ? 200 : 201, { id: job.id, state: job.state, deduplicated });
    }
    if (req.method === 'GET' && parts[0] === 'jobs' && parts.length === 2) {
      return send(res, 200, publicJob(requireJob(parts[1]), store));
    }
    if (req.method === 'GET' && parts[0] === 'jobs' && parts[2] === 'outputs' && parts.length === 4) {
      const output = requireJob(parts[1]).outputs[Number(parts[3])];
      if (!output) throw new DaemonError(JobErrorCodes.NOT_FOUND, `Job ${parts[1]} has no output ${parts[3]}`);
      res.writeHead(200, { 'content-type': output.mediaType, 'content-length': output.bytes, 'x-sha256': output.sha256 });
      return fs.createReadStream(output.file).pipe(res);
    }
    if (req.method === 'POST' && parts[0] === 'tools' && parts.length === 2) return tool(req, res, parts[1]);
    throw new DaemonError(JobErrorCodes.NOT_FOUND, `No route ${req.method} ${url.pathname}`);
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      const error = toJobError(err);
      if (res.headersSent) return res.end();
      send(res, STATUS[error.code] ?? 500, { error });
    });
  });
  server.requestTimeout = 0;
  return server;
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add src/daemon/token.js src/daemon/server.js test/server.test.js
git commit -m "feat(daemon): loopback HTTP API with bearer token

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Daemon client with auto-start

**Files:**
- Create: `src/daemon/client.js`
- Test: `test/client.test.js`

- [ ] **Step 1: Write the failing test** — `test/client.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobStore } from '../src/daemon/job-store.js';
import { UploadStore } from '../src/daemon/upload-store.js';
import { Mutex } from '../src/daemon/mutex.js';
import { JobRunner } from '../src/daemon/runner.js';
import { createDaemonServer } from '../src/daemon/server.js';
import { loadOrCreateToken } from '../src/daemon/token.js';
import { DaemonClient, ensureDaemon } from '../src/daemon/client.js';
import { FakeDriver } from './fake-driver.js';

async function startServer(root, port = 0) {
  const tokenFile = path.join(root, 'daemon-token');
  const token = loadOrCreateToken(tokenFile);
  const store = new JobStore(path.join(root, 'jobs.json'));
  const uploads = new UploadStore(path.join(root, 'uploads'));
  const mutex = new Mutex();
  const driver = new FakeDriver();
  const runner = new JobRunner({ store, uploads, driver, mutex, outputsDir: path.join(root, 'outputs') });
  const server = createDaemonServer({ token, store, uploads, runner, mutex, driver,
    callTool: async (name) => { if (name === 'bad') throw Object.assign(new Error('nope'), { code: 'INVALID_PARAMS' }); return { name }; } });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { server, runner, tokenFile, port: server.address().port };
}

test('client drives uploads, jobs, outputs and tools', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-client-'));
  const { server, runner, tokenFile, port } = await startServer(root);
  t.after(() => server.close());
  const client = new DaemonClient({ baseUrl: `http://127.0.0.1:${port}`, tokenFile });

  assert.equal((await client.health()).ok, true);
  const upload = await client.upload(Buffer.from('ref'), 'image/png');
  const submitted = await client.submitJob({ kind: 'image', model: 'nano-banana-2', prompt: 'p', aspectRatio: '1:1',
    references: [upload.id], confirmCredits: true, idempotencyKey: 'key-client-01' });
  await runner.idle();
  const job = await client.getJob(submitted.id);
  assert.equal(job.state, 'succeeded');
  const output = await client.getOutput(submitted.id, 0);
  assert.equal(output.mediaType, 'image/png');
  assert.equal(Buffer.from(output.bytes).toString(), 'image:uuid-1');
  assert.deepEqual(await client.callTool('flow_status', {}), { name: 'flow_status' });
  await assert.rejects(client.callTool('bad', {}), (err) => err.code === 'INVALID_REQUEST' && err.message === 'nope');
  await assert.rejects(client.getJob('missing'), (err) => err.code === 'NOT_FOUND');
});

test('unreachable daemon raises DAEMON_UNAVAILABLE', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-client-'));
  const tokenFile = path.join(root, 'daemon-token');
  loadOrCreateToken(tokenFile);
  const client = new DaemonClient({ baseUrl: 'http://127.0.0.1:1', tokenFile });
  await assert.rejects(client.health(), (err) => err.code === 'DAEMON_UNAVAILABLE');
});

test('ensureDaemon spawns once when the daemon is down, then waits for health', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-client-'));
  const probe = await startServer(root);
  const port = probe.port;
  await new Promise((resolve) => probe.server.close(resolve));
  let spawned = 0;
  let started;
  const client = await ensureDaemon({
    baseUrl: `http://127.0.0.1:${port}`, tokenFile: path.join(root, 'daemon-token'), timeoutMs: 5000,
    spawnDaemon: () => { spawned += 1; started = startServer(root, port); },
  });
  t.after(async () => (await started).server.close());
  assert.equal(spawned, 1);
  assert.equal((await client.health()).ok, true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — missing `client.js`

- [ ] **Step 3: Implement** — `src/daemon/client.js`:

```js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DaemonError, JobErrorCodes } from './errors.js';

const MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'main.js');

export class DaemonClient {
  constructor({ baseUrl, tokenFile, fetch = globalThis.fetch }) {
    Object.assign(this, { baseUrl: baseUrl.replace(/\/$/u, ''), tokenFile, fetcher: fetch });
  }

  async #request(pathname, init = {}) {
    const token = fs.existsSync(this.tokenFile) ? fs.readFileSync(this.tokenFile, 'utf8').trim() : '';
    let response;
    try {
      response = await this.fetcher(`${this.baseUrl}${pathname}`, {
        ...init, headers: { ...init.headers, authorization: `Bearer ${token}` },
      });
    } catch (err) {
      throw new DaemonError(JobErrorCodes.DAEMON_UNAVAILABLE,
        `Flow daemon is not reachable at ${this.baseUrl} (${err.cause?.code ?? err.message}). Start it with "npm run daemon" in google-flow-mcp.`);
    }
    if (!response.ok) {
      let error;
      try { error = (await response.json()).error; } catch { /* keep the HTTP status as evidence */ }
      throw new DaemonError(error?.code ?? JobErrorCodes.INTERNAL,
        error?.message ?? `Flow daemon ${init.method ?? 'GET'} ${pathname} returned HTTP ${response.status}`, error?.details ?? {});
    }
    return response;
  }

  async #json(pathname, init) {
    return (await this.#request(pathname, init)).json();
  }

  health() { return this.#json('/health'); }

  upload(bytes, mediaType) {
    return this.#json('/uploads', { method: 'POST', headers: { 'content-type': mediaType }, body: bytes });
  }

  submitJob(request) {
    return this.#json('/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
  }

  getJob(id) { return this.#json(`/jobs/${encodeURIComponent(id)}`); }

  async getOutput(id, index) {
    const response = await this.#request(`/jobs/${encodeURIComponent(id)}/outputs/${index}`);
    return { mediaType: response.headers.get('content-type'), sha256: response.headers.get('x-sha256'),
      bytes: new Uint8Array(await response.arrayBuffer()) };
  }

  async callTool(name, args) {
    const response = await this.#request(`/tools/${encodeURIComponent(name)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args ?? {}),
    });
    const body = JSON.parse(await response.text());
    if (!body.ok) throw new DaemonError(body.error.code, body.error.message, body.error.details);
    return body.result;
  }
}

function spawnDetachedDaemon() {
  const child = spawn(process.execPath, [MAIN], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

export async function ensureDaemon({ baseUrl, tokenFile, spawnDaemon = spawnDetachedDaemon, timeoutMs = 20_000 }) {
  const client = new DaemonClient({ baseUrl, tokenFile });
  try {
    await client.health();
    return client;
  } catch (err) {
    if (err.code !== JobErrorCodes.DAEMON_UNAVAILABLE) throw err;
  }
  spawnDaemon();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      await client.health();
      return client;
    } catch (err) {
      if (err.code !== JobErrorCodes.DAEMON_UNAVAILABLE || Date.now() > deadline) throw err;
    }
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add src/daemon/client.js test/client.test.js
git commit -m "feat(daemon): HTTP client with detached auto-start

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Handlers report media UUIDs and real timeouts

**Files:**
- Modify: `src/tools/generate-image.js:314-376`
- Modify: `src/tools/generate-video.js:214-270`

The driver needs the Flow media UUID of each downloaded file (for `redownload`) and must distinguish "nothing rendered in time" (`GENERATION_TIMEOUT` → `RENDER_TIMEOUT`) from "rendered but download failed" (`DOWNLOAD_FAILED` with UUIDs). These handlers only run against the live UI, so this task has no automated test; Task 12 verifies it live.

- [ ] **Step 1: Image handler — timeout code.** In `src/tools/generate-image.js` replace:

```js
    if (generatedImageUuids.length === 0) {
      await takeScreenshot(page, 'no-images-detected');
      throw new FlowError(ErrorCodes.DOWNLOAD_FAILED,
        'Generation completed but no images were detected in the DOM. ' +
        'Check the Flow project content library.');
    }
```

with:

```js
    if (generatedImageUuids.length === 0) {
      const shot = await takeScreenshot(page, 'no-images-detected');
      throw new FlowError(ErrorCodes.GENERATION_TIMEOUT,
        `No generated image appeared within ${Math.round(genTimeoutMs / 1000)}s. ` +
        'Check the Flow project content library.', { screenshot: shot });
    }
```

- [ ] **Step 2: Image handler — record UUID per file.** Replace:

```js
    const downloadedFiles = [];

    for (const uuid of generatedImageUuids) {
```

with:

```js
    const downloadedFiles = [];
    const media = [];

    for (const uuid of generatedImageUuids) {
```

and replace:

```js
            downloadedFiles.push(destPath);
            logger.info('Image downloaded', { uuid, size: buffer.length, path: destPath });
```

with:

```js
            downloadedFiles.push(destPath);
            media.push({ file: destPath, uuid });
            logger.info('Image downloaded', { uuid, size: buffer.length, path: destPath });
```

- [ ] **Step 3: Image handler — UUIDs on download failure and in the result.** Replace:

```js
      throw new FlowError(ErrorCodes.DOWNLOAD_FAILED,
        'Failed to download any generated images via the authenticated session');
```

with:

```js
      throw new FlowError(ErrorCodes.DOWNLOAD_FAILED,
        'Failed to download any generated images via the authenticated session',
        { mediaUuids: generatedImageUuids });
```

and in the `jobQueue.completeJob(job.id, { status: 'success', type: 'image', ...` object add `media,` after `files: downloadedFiles,`.

- [ ] **Step 4: Video handler — timeout code.** In `src/tools/generate-video.js` replace:

```js
    if (!mediaUuids.length && !videoSrc) {
      await takeScreenshot(page, 'no-video-detected');
      throw new FlowError(ErrorCodes.DOWNLOAD_FAILED,
        'Generation completed but no video was detected in the DOM. Check the Flow project library.');
    }
```

with:

```js
    if (!mediaUuids.length && !videoSrc) {
      const shot = await takeScreenshot(page, 'no-video-detected');
      throw new FlowError(ErrorCodes.GENERATION_TIMEOUT,
        `No generated video appeared within ${Math.round(genTimeoutMs / 1000)}s. Check the Flow project library.`,
        { screenshot: shot });
    }
```

- [ ] **Step 5: Video handler — record UUID per file.** Replace `const downloadedFiles = [];` (the one right after `outputDir`) with:

```js
    const downloadedFiles = [];
    const media = [];
```

replace:

```js
            downloadedFiles.push(destPath);
            logger.info('Video downloaded', { uuid, size: buffer.length, path: destPath });
```

with:

```js
            downloadedFiles.push(destPath);
            media.push({ file: destPath, uuid });
            logger.info('Video downloaded', { uuid, size: buffer.length, path: destPath });
```

replace:

```js
      throw new FlowError(ErrorCodes.DOWNLOAD_FAILED,
        `Video generated but download failed. UUIDs seen: ${mediaUuids.join(', ') || 'none'}; videoSrc: ${videoSrc || 'none'}`);
```

with:

```js
      throw new FlowError(ErrorCodes.DOWNLOAD_FAILED,
        `Video generated but download failed. UUIDs seen: ${mediaUuids.join(', ') || 'none'}`,
        { mediaUuids });
```

and in `jobQueue.completeJob(job.id, { status: 'success', type: 'video', ...` add `media,` after `files: downloadedFiles,`.

- [ ] **Step 6: Syntax check and existing tests**

Run: `node --check src/tools/generate-image.js && node --check src/tools/generate-video.js && npm test`
Expected: no output from `--check`; tests all pass

- [ ] **Step 7: Commit**

```bash
git add src/tools/generate-image.js src/tools/generate-video.js
git commit -m "fix(tools): report media uuids and distinguish render timeout from download failure

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Playwright driver, tool handlers and daemon entry

**Files:**
- Create: `src/daemon/playwright-driver.js`
- Create: `src/daemon/tool-handlers.js`
- Create: `src/daemon/main.js`

These modules load Playwright and the live Flow handlers, so they are verified by the live smoke test in Task 12, not unit tests.

- [ ] **Step 1: Driver** — `src/daemon/playwright-driver.js`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { getPage, isBrowserConnected } from '../browser/connect.js';
import { launchKiaraProfile, navigateToFlow } from '../browser/launch-profile.js';
import { verifyAccount } from '../browser/account-check.js';
import { handleGenerateImage } from '../tools/generate-image.js';
import { handleGenerateVideo } from '../tools/generate-video.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { DaemonError, JobErrorCodes } from './errors.js';

const MEDIA_URL = 'https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=';

function mediaTypeFor(file) {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.mp4') return 'video/mp4';
  throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, `Unexpected downloaded file type ${extension}`);
}

function toMedia(result) {
  if (!Array.isArray(result?.media)) throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, 'Handler returned no media list');
  return result.media.map(({ file, uuid }) => ({ file, mediaType: mediaTypeFor(file), mediaUuid: uuid }));
}

// Reference automation (image references, Frames to Video, Ingredients) arrives in Plan A2.
function rejectReferences(job) {
  const { references, firstFrame, lastFrame, ingredients } = job.inputs;
  if (references.length || ingredients.length || firstFrame || lastFrame) {
    throw new DaemonError(JobErrorCodes.UNSUPPORTED_INPUT,
      'Reference images, frames and ingredients are not automated yet in this daemon version');
  }
}

export class PlaywrightFlowDriver {
  async #connect() {
    if (!isBrowserConnected()) await launchKiaraProfile(false);
    const page = getPage();
    if (!page.url().includes('labs.google')) {
      const navigation = await navigateToFlow(page);
      if (navigation?.authenticated === false) {
        throw new FlowError(ErrorCodes.NOT_LOGGED_IN,
          'Flow needs a manual sign-in: run scripts/ensure-flow-chrome.ps1, sign in to Google and click "Sign in to Flow".');
      }
    }
    if (page.url().includes('accounts.google.com')) {
      throw new FlowError(ErrorCodes.NOT_LOGGED_IN, 'Flow redirected to Google sign-in; sign in once in the dedicated Chrome.');
    }
    return page;
  }

  async health() {
    try {
      await this.#connect();
    } catch (err) {
      return { chrome: err.code === ErrorCodes.NOT_LOGGED_IN, loggedIn: false, error: err.message };
    }
    try {
      const account = await verifyAccount();
      return { chrome: true, loggedIn: true, account: account.account };
    } catch (err) {
      return { chrome: true, loggedIn: false, error: err.message };
    }
  }

  async generateImage(job, progress) {
    rejectReferences(job);
    await this.#connect();
    progress('generating image');
    return toMedia(await handleGenerateImage({
      prompt: job.prompt, model: job.flowModel, ratio: job.aspectRatio, auto_confirm: true,
      output_folder: job.outputDir, project_name: job.project, campaign: job.project,
    }));
  }

  async generateVideo(job, progress) {
    rejectReferences(job);
    await this.#connect();
    progress('rendering video');
    return toMedia(await handleGenerateVideo({
      prompt: job.prompt, model: job.flowModel, ratio: job.aspectRatio, duration: `${job.duration}s`,
      auto_confirm: true, output_folder: job.outputDir, project_name: job.project, campaign: job.project,
    }));
  }

  async redownload(uuid, kind, outputDir) {
    const page = await this.#connect();
    const response = await page.request.get(`${MEDIA_URL}${encodeURIComponent(uuid)}`, { timeout: 60_000 });
    const mediaType = (response.headers()['content-type'] ?? '').split(';')[0].trim();
    if (!response.ok() || !mediaType.startsWith(kind === 'image' ? 'image/' : 'video/')) {
      throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, `Redownload of ${uuid} returned HTTP ${response.status()} ${mediaType}`);
    }
    fs.mkdirSync(outputDir, { recursive: true });
    const extension = mediaType === 'image/png' ? '.png' : mediaType.startsWith('image/') ? '.jpg' : '.mp4';
    const file = path.join(outputDir, `flow_${uuid.slice(0, 8)}${extension}`);
    fs.writeFileSync(file, await response.body());
    return { file, mediaType, mediaUuid: uuid };
  }
}
```

- [ ] **Step 2: Tool handlers** — create `src/daemon/tool-handlers.js`. Move the body of `handleToolCall` from `src/index.js` (the whole `switch (name) { ... }`, cases `flow_connect` through `flow_queue_status`) into this function **unchanged except**: each `return { content: [{ type: 'text', text: JSON.stringify(X, null, 2) }] };` becomes `return X;`; the `flow_connect` oauth branch returns its object directly; `flow_queue_status` returns `options.runnerStatus()` merged with the legacy queue; the `default` case throws a `DaemonError` NOT_FOUND:

```js
import { launchKiaraProfile, navigateToFlow } from '../browser/launch-profile.js';
import { getPage, setBrowser, closeBrowser as closeBrowserConnection } from '../browser/connect.js';
import { verifyAccount as checkAccount } from '../browser/account-check.js';
import { handleFlowStatus } from '../tools/flow-status.js';
import { handleGenerateImage } from '../tools/generate-image.js';
import { handleGenerateVideo } from '../tools/generate-video.js';
import { handleDownloadLatest } from '../tools/download-latest.js';
import { handleCreateCharacter } from '../tools/create-character.js';
import { handleImportCharacter } from '../tools/import-character.js';
import { handleOpenCharacters } from '../tools/open-characters.js';
import { handleCreateScene } from '../tools/create-scene.js';
import { handleOpenToolsGallery } from '../tools/open-tools-gallery.js';
import { handleUseGridArchitect } from '../tools/grid-architect.js';
import { handleDiscoverUi } from '../tools/discover-ui.js';
import { handleUseFlowTool } from '../tools/use-flow-tool.js';
import { jobQueue } from '../queue/job-queue.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { logger } from '../utils/logger.js';
import { DaemonError, JobErrorCodes } from './errors.js';

export async function callTool(name, args, options) {
  logger.info('Tool called', { tool: name, args: args ? JSON.stringify(args).substring(0, 200) : 'none' });
  switch (name) {
    case 'flow_connect': {
      const result = await launchKiaraProfile(args?.headless || false);
      if (result.browser) setBrowser(result.browser);
      const page = getPage();
      let oauthRequired = false;
      if (args?.open_flow !== false) {
        const navResult = await navigateToFlow(page);
        if (navResult && navResult.authenticated === false) oauthRequired = true;
      }
      let accountCheck = null;
      try { accountCheck = await checkAccount(page); } catch (e) { accountCheck = { verified: false, error: e.message }; }
      if (oauthRequired) {
        return {
          status: 'oauth_required',
          message: 'Google Flow needs a one-time manual sign-in:\n'
            + '  1. Run scripts/ensure-flow-chrome.ps1 (opens the dedicated Chrome)\n'
            + '  2. Sign in to Google in that window and click "Sign in to Flow"\n'
            + '  3. Call flow_connect again',
          browserType: 'Dedicated Chrome (FlowAutomationChrome)',
          account: accountCheck?.account || 'verified-account',
          url: page.url().substring(0, 100),
          accountVerified: accountCheck,
        };
      }
      return { status: 'connected', browserType: 'Dedicated Chrome (FlowAutomationChrome)',
        account: accountCheck?.account || 'verified-account', url: page.url(), accountVerified: accountCheck };
    }
    case 'flow_disconnect':
      await closeBrowserConnection();
      return { status: 'disconnected' };
    case 'flow_status': return handleFlowStatus();
    case 'flow_account_check': return checkAccount(getPage());
    case 'flow_discover_ui': return handleDiscoverUi(args);
    case 'flow_generate_image': return handleGenerateImage(args);
    case 'flow_generate_video': return handleGenerateVideo(args);
    case 'flow_download_latest': return handleDownloadLatest(args);
    case 'flow_create_character': return handleCreateCharacter(args);
    case 'flow_import_character': return handleImportCharacter(args);
    case 'flow_open_characters': return handleOpenCharacters(args);
    case 'flow_create_scene': return handleCreateScene(args);
    case 'flow_open_tools_gallery': return handleOpenToolsGallery(args);
    case 'flow_use_grid_architect': return handleUseGridArchitect(args);
    case 'flow_use_tool': return handleUseFlowTool(args);
    case 'flow_screenshot': {
      const screenshot = await takeScreenshot(getPage(), args?.name || 'manual');
      return { screenshot, message: 'Screenshot saved.' };
    }
    case 'flow_queue_status':
      return { daemon: options.runnerStatus(), legacy: jobQueue.getStatus(args?.history_limit) };
    default:
      throw new DaemonError(JobErrorCodes.NOT_FOUND, `Unknown tool: ${name}`);
  }
}
```

Before writing this file, diff the `flow_connect` case against `src/index.js:224-261`; if it differs from the code above in anything other than the MCP wrapping and the message language, keep the `src/index.js` behavior.

- [ ] **Step 3: Entry point** — `src/daemon/main.js`:

```js
#!/usr/bin/env node
import path from 'node:path';
import { get, getFlowHome } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { JobStore } from './job-store.js';
import { UploadStore } from './upload-store.js';
import { Mutex } from './mutex.js';
import { JobRunner } from './runner.js';
import { createDaemonServer } from './server.js';
import { loadOrCreateToken } from './token.js';
import { PlaywrightFlowDriver } from './playwright-driver.js';
import { callTool } from './tool-handlers.js';

const home = getFlowHome();
const dataDir = path.join(home, 'data');
const token = loadOrCreateToken(path.join(home, 'config', 'daemon-token'));
const store = new JobStore(path.join(dataDir, 'jobs.json'));
const interrupted = store.recoverInterrupted();
const uploads = new UploadStore(path.join(dataDir, 'uploads'));
const mutex = new Mutex();
const driver = new PlaywrightFlowDriver();
const runner = new JobRunner({
  store, uploads, driver, mutex, outputsDir: path.join(dataDir, 'outputs'),
  log: (message, data) => logger.info(message, data),
});
const server = createDaemonServer({
  token, store, uploads, runner, mutex, driver, expectedAccount: get('expectedAccount'),
  callTool: (name, args) => callTool(name, args, { runnerStatus: () => runner.status() }),
});
const port = get('daemonPort', 47821);

server.on('error', (err) => {
  logger.error('Flow daemon could not start', { port, error: err.message });
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => {
  logger.info('Flow daemon listening', { port, interrupted: interrupted.length });
  runner.kick();
});
```

- [ ] **Step 4: Syntax check**

Run: `node --check src/daemon/playwright-driver.js && node --check src/daemon/tool-handlers.js && node --check src/daemon/main.js && npm test`
Expected: no `--check` output; tests all pass

- [ ] **Step 5: Start the daemon and hit health (no Flow action, no credits)**

Run in the background: `npm run daemon`
Then: `curl -s http://127.0.0.1:47821/health`
Expected: JSON with `"ok":true` and a `queue` object. `chrome`/`loggedIn` reflect the dedicated Chrome's state (the probe launches the dedicated Chrome if it is not running — that is expected). Stop the daemon afterwards.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/playwright-driver.js src/daemon/tool-handlers.js src/daemon/main.js
git commit -m "feat(daemon): Playwright driver, tool dispatch and entry point

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: MCP server becomes a daemon proxy

**Files:**
- Modify: `src/index.js`

- [ ] **Step 1: Replace the imports and `handleToolCall`.** In `src/index.js`, delete lines 10–30 (all imports after the MCP SDK imports) and the entire `async function handleToolCall(name, args) { ... }` (currently `src/index.js:219-348`). Insert after the MCP SDK imports:

```js
import path from 'node:path';
import { get, getFlowHome } from './utils/config.js';
import { logger } from './utils/logger.js';
import { ensureDaemon } from './daemon/client.js';

const DAEMON = {
  baseUrl: `http://127.0.0.1:${get('daemonPort', 47821)}`,
  tokenFile: path.join(getFlowHome(), 'config', 'daemon-token'),
};
```

and insert after `TOOL_DEFINITIONS`:

```js
async function handleToolCall(name, args) {
  if (!TOOL_DEFINITIONS.some((tool) => tool.name === name)) {
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }
  const client = await ensureDaemon(DAEMON);
  const result = await client.callTool(name, args ?? {});
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}
```

`TOOL_DEFINITIONS`, the `Server` setup, the `CallToolRequestSchema` error wrapper and the transport stay as they are.

- [ ] **Step 2: Syntax and tests**

Run: `node --check src/index.js && npm test`
Expected: no `--check` output; tests all pass

- [ ] **Step 3: MCP handshake smoke test (no Flow action)** — `test/mcp-proxy.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('MCP server lists the Flow tools over stdio without corrupting the stream', async (t) => {
  const transport = new StdioClientTransport({ command: process.execPath, args: ['src/index.js'] });
  const client = new Client({ name: 'proxy-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(() => client.close());
  const { tools } = await client.listTools();
  assert.ok(tools.some((tool) => tool.name === 'flow_generate_video'));
  assert.equal(tools.length, 17);
});
```

Run: `npm test`
Expected: all pass (listing tools does not start the daemon).

- [ ] **Step 4: Commit**

```bash
git add src/index.js test/mcp-proxy.test.js
git commit -m "feat(mcp): forward every tool call to the Flow daemon

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Documentation

**Files:**
- Modify: `README.md` (add a section after "Setup")
- Modify: `config/flow.config.example.json`

- [ ] **Step 1: Add `daemonPort` to the example config** — after `"cdpPort": 9222,` add:

```json
  "daemonPort": 47821,
```

- [ ] **Step 2: Add this section to `README.md` after the Setup section:**

````markdown
## Daemon

Only one process may drive the Flow Chrome. `src/daemon/main.js` owns it, keeps a serial job
queue in `data/jobs.json` and listens on `127.0.0.1:47821` (`daemonPort`). The MCP server starts
the daemon on first use and forwards every tool call to it; other programs (for example the
Hypit provider) submit generation jobs over HTTP.

```bash
npm run daemon
curl http://127.0.0.1:47821/health
```

Requests other than `/health` need `authorization: Bearer <config/daemon-token>`; the token is
created on first start.

| Route | Purpose |
| --- | --- |
| `GET /health` | Chrome, sign-in and queue state |
| `POST /uploads` | Reference image bytes (PNG/JPEG/WebP) → `{ id }` |
| `POST /jobs` | `{ kind, model, prompt, aspectRatio, duration?, references?, firstFrame?, lastFrame?, ingredients?, project?, confirmCredits, idempotencyKey }` |
| `GET /jobs/:id` | `queued` · `running` · `succeeded` · `failed` · `interrupted`, with phase and outputs |
| `GET /jobs/:id/outputs/:n` | Generated file |
| `POST /tools/:name` | Run one MCP tool under the browser lock |

Every generation job needs `confirmCredits: true`. A repeated `idempotencyKey` returns the
existing queued, running or succeeded job instead of spending credits again.

Models: `nano-banana-2`, `nano-banana-pro`, `veo-3.1-lite`, `veo-3.1-fast`, `veo-3.1-quality`,
`omni-flash`. Reference inputs are rejected with `UNSUPPORTED_INPUT` until reference automation lands.

After updating, restart your MCP client so it loads the proxy version of the server.
````

- [ ] **Step 3: Commit**

```bash
git add README.md config/flow.config.example.json
git commit -m "docs: describe the Flow daemon

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Live verification (requires the user)

Needs the dedicated Chrome signed in to Flow. **Ask the user before Step 4 — it spends Flow credits.**

- [ ] **Step 1: Chrome up**

Run: `powershell -File scripts/ensure-flow-chrome.ps1`
Expected: `READY: ...` or `LAUNCHED: ...`

- [ ] **Step 2: Daemon up and healthy**

Run in the background: `npm run daemon`
Then: `curl -s http://127.0.0.1:47821/health`
Expected: `"ok":true,"chrome":true,"loggedIn":true`. If `loggedIn` is false, the user signs in in the dedicated Chrome and this step repeats.

- [ ] **Step 3: No-credit tool call through the daemon**

```bash
node -e "import('./src/daemon/client.js').then(async ({ DaemonClient }) => { const c = new DaemonClient({ baseUrl: 'http://127.0.0.1:47821', tokenFile: 'config/daemon-token' }); console.log(JSON.stringify(await c.callTool('flow_generate_image', { prompt: 'a red apple on a table', auto_confirm: false }), null, 2)); })"
```

Expected: `"status": "ready_for_confirmation"` and a screenshot path; no credits used.

- [ ] **Step 4: One real image job (ask the user first)**

```bash
node -e "import('./src/daemon/client.js').then(async ({ DaemonClient }) => { const c = new DaemonClient({ baseUrl: 'http://127.0.0.1:47821', tokenFile: 'config/daemon-token' }); const j = await c.submitJob({ kind: 'image', model: 'nano-banana-2', prompt: 'a red apple on a wooden table, studio light', aspectRatio: '1:1', project: 'daemon-smoke', confirmCredits: true, idempotencyKey: 'smoke-image-0001' }); for (;;) { const s = await c.getJob(j.id); console.log(s.state, s.phase); if (!['queued','running'].includes(s.state)) { console.log(JSON.stringify(s, null, 2)); break; } await new Promise(r => setTimeout(r, 5000)); } })"
```

Expected: ends with `succeeded`, one output with `mediaType` `image/png` or `image/jpeg`. Open `data/outputs/<id>/` and check the image matches the prompt.

- [ ] **Step 5: Restart the MCP client** so Claude loads the proxy server, then call `flow_status` from Claude. Expected: normal status JSON (served through the daemon).

- [ ] **Step 6: Report** results to the user. No commit (no code changes).

---

### Task 13: UI discovery → `config/capabilities.json` (requires the user)

This produces the facts Plans A2 and B depend on. **No generation is submitted in this task.** Use the dedicated Chrome through the daemon's tools (`flow_discover_ui`, `flow_screenshot`) and, where a menu must be opened, the Claude in-app browser **only for reading** the Flow page the user has open. Record each fact with the screenshot that shows it.

**Files:**
- Create: `config/capabilities.json`
- Create: `docs/capabilities.md`

- [ ] **Step 1: Image models.** In a Flow project, open the model picker. For `Nano Banana 2` and `Nano Banana Pro` record: selectable aspect ratios, whether and how reference images can be attached (button, drag-drop, "+" menu), the maximum number of references, the output resolutions offered on download, and the credit cost shown (0 if none).

- [ ] **Step 2: Video models.** For `Veo 3.1 - Lite`, `Veo 3.1 - Fast`, `Veo 3.1 - Quality`, `Omni Flash` record: aspect ratios, allowed durations, credit cost, and which generation modes exist — text-to-video, Frames to Video (first frame, last frame, both), Ingredients to Video (maximum ingredients) — and which combinations the UI forbids.

- [ ] **Step 3: How the agent-first prompt bar selects things.** Record whether model, ratio and duration are chosen by UI controls, by the imperative prompt text, or both; and the exact text/icons of the attach control. Note the UI language (the handlers currently match Italian text such as "Approva").

- [ ] **Step 4: Failure surfaces.** Without generating, collect the visible text Flow shows for: content-policy refusal, out-of-credits, and the agent asking a clarifying question (use screenshots from earlier sessions in `logs/`/screenshots if present; otherwise mark `"unknown"`).

- [ ] **Step 5: Write `config/capabilities.json`** with exactly this shape (values from Steps 1–4; use `null` for anything that could not be observed, never a guess):

```json
{
  "version": 1,
  "discoveredAt": "2026-10-01",
  "uiLanguage": "it",
  "image": {
    "nano-banana-2": { "aspectRatios": [], "maxReferences": null, "downloadResolutions": [], "credits": null },
    "nano-banana-pro": { "aspectRatios": [], "maxReferences": null, "downloadResolutions": [], "credits": null }
  },
  "video": {
    "veo-3.1-lite": { "aspectRatios": [], "durations": [], "credits": null,
      "modes": { "text": null, "firstFrame": null, "lastFrame": null, "ingredients": null },
      "forbiddenCombinations": [] },
    "veo-3.1-fast": { "aspectRatios": [], "durations": [], "credits": null,
      "modes": { "text": null, "firstFrame": null, "lastFrame": null, "ingredients": null },
      "forbiddenCombinations": [] },
    "veo-3.1-quality": { "aspectRatios": [], "durations": [], "credits": null,
      "modes": { "text": null, "firstFrame": null, "lastFrame": null, "ingredients": null },
      "forbiddenCombinations": [] },
    "omni-flash": { "aspectRatios": [], "durations": [], "credits": null,
      "modes": { "text": null, "firstFrame": null, "lastFrame": null, "ingredients": null },
      "forbiddenCombinations": [] }
  },
  "selection": { "model": null, "aspectRatio": null, "duration": null, "attachControl": null },
  "failureTexts": { "contentRejected": null, "insufficientCredits": null, "clarification": null }
}
```

`modes.ingredients` is the maximum ingredient count (`0` = unsupported); `modes.firstFrame`/`lastFrame`/`text` are booleans; `durations` are integers in seconds; `forbiddenCombinations` lists arrays of mode names that cannot be used together (e.g. `["ingredients", "firstFrame"]`); `selection.*` is `"ui"`, `"prompt"` or `"both"`.

- [ ] **Step 6: Write `docs/capabilities.md`** — one row per fact: the fact, where it was seen, the screenshot path.

- [ ] **Step 7: Commit**

```bash
git add config/capabilities.json docs/capabilities.md
git commit -m "docs: Flow UI capability table from live discovery

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 8: Hand off.** Plan A2 (reference automation, failure detection, model/ratio fidelity) and Plan B (Hypit `flow-veo` + provider) are written from this table.

---

## Self-review notes

- Spec coverage (A1 scope): daemon process, loopback + token, serial durable queue, uploads, all five routes, idempotency, `confirmCredits` gate, `interrupted` recovery, download retry by media UUID, redaction, MCP proxy + auto-start, `reference_images` behavior (rejected until A2), capability discovery. Deferred with reason: `FLOW_CLARIFICATION`, `CONTENT_REJECTED` detection and reference automation (need Task 13 facts) → A2; Hypit packages → B.
- Known gap carried to A2: the existing image handler never applies the requested model or ratio in the UI (it only validates them against config). Task 13 Step 3 establishes how selection works so A2 can fix it.
