# Flow Driver Rewrite Implementation Plan (Plan A2 of the Google Flow provider)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the daemon generate images and videos — with reference images, first/last frames and ingredients — against the current Flow UI at `flow.google.com`, replacing the legacy handlers that no longer match it.

**Architecture:** A new `src/flow/` layer. `ui.js` holds pure, unit-tested knowledge (URLs, media URL parsing, account parsing, icon names, prompt building, legacy name mapping). `session.js` is the only code that touches the Flow page; it locates controls by Material icon ligatures (`tune`, `arrow_forward`, `add`, `upload`, `crop_16_9` …) and model names, which do not change with the UI language. `PlaywrightFlowDriver` orchestrates a job through a `FlowSession` (injectable, so orchestration is unit-tested with a fake session). The MCP `flow_generate_*` tools reuse the driver, and the legacy handlers are deleted.

**Tech Stack:** Node ≥ 22 ESM, Playwright over CDP (existing), `node:test`.

**Facts this plan relies on** (from `docs/capabilities.md` and live probes on 2026-10-01):

- Home `https://flow.google.com/`; button text `Start Creating` opens a new project at `/project/<uuid>`. Project title is the first `<input>` on the project page.
- Account chip: `<a aria-label="Tài khoản Google: <name> (<email>), …">`.
- Generated media are `<img>`/`<video>` sources of the form `https://flow-content.google/image/<uuid>?Expires=…&KeyName=…&Signature=…`. The **signed** URL downloads the original (Nano Banana 2 16:9 → JPEG 1376×768); the unsigned URL returns 403.
- Prompt bar icons: `add` (ingredient picker), `article_spark` (agent instructions), `tune` (settings), `arrow_forward` (send; hidden while the agent is busy). A generating tile shows a percentage (`25%`).
- Settings panel: radio inputs `value="1"` = confirm before generating, `value="2"` = never confirm (auto-generate and deduct credits); image section then video section, each with ratio radios (icons `crop_16_9`, `crop_landscape`, `crop_square`, `crop_portrait`, `crop_9_16`; video only 16:9 and 9:16), count radios `x1`–`x4`, and a model menu button (`aria-haspopup="menu"`, text ends with `arrow_drop_down`; first = image, second = video). Menu items: `🍌 Nano Banana Pro`, `🍌 Nano Banana 2`, `🍌 Nano Banana 2 Lite`, `Omni 1.1 Flash`, `Veo 3.1 - Lite`, `Veo 3.1 - Fast`, `Veo 3.1 - Quality`. Save button text `Lưu`. CDK overlay backdrops intercept clicks until dismissed.
- Ingredient picker: upload button with icon `upload`; confirm button text `Thêm vào câu lệnh`.

**Not yet observed (verified in the live tasks, Tasks 7–10):** the `<video>` source pattern for finished videos, how uploaded ingredients become selected, how the agent honours "first frame / last frame" wording, allowed durations and credit cost per model.

**Decisions:**
- The automation account is the one signed in to the dedicated Chrome (`nhuquynh.231123@gmail.com`); `expectedAccount` is set to it and checked for real.
- The driver sets **"never confirm"** (`value="2"`) in Flow's settings. The daemon's own `confirmCredits` gate is the spending authorization; a Flow confirmation dialog would otherwise stall unattended jobs. This changes that account's Flow setting for manual use too.
- Each job sets count `x1`, its model and ratio in the settings panel before sending.
- Prompts are written in English (the agent answers any language) and state the attached images' roles explicitly.
- Covering or removing Flow's visible AI watermark is out of scope.

**Repository:** `C:\Users\admin\Desktop\google-flow-mcp`, branch `feat/flow-driver` from `feat/daemon`. Paths below are relative to it.

---

## File structure

| File | Responsibility |
| --- | --- |
| `src/flow/ui.js` | Pure constants and helpers: URLs, icons, ratio icons, account/media parsing, ingredient ordering, prompt text, legacy MCP name mapping |
| `src/flow/session.js` | `FlowSession`: every interaction with the Flow page |
| `src/daemon/models.js` | Wire models (+ `nano-banana-2-lite`, `Omni 1.1 Flash` label) and allowed ratios per kind |
| `src/daemon/validate.js` | Rejects ratios the kind does not support |
| `src/daemon/playwright-driver.js` | Job orchestration through a `FlowSession` |
| `src/daemon/tool-handlers.js` | `flow_generate_image`/`flow_generate_video` delegate to the driver |
| `src/daemon/main.js` | Wires driver options (registry, expected account) into tools |
| `src/tools/generate-image.js`, `src/tools/generate-video.js` | Deleted |
| `test/ui.test.js`, `test/driver.test.js` | New unit tests |

---

### Task 0: Branch and account config

**Files:**
- Modify (local, git-ignored): `config/flow.config.json`

- [ ] **Step 1: Branch** — `feat/flow-driver` already exists (created from `feat/daemon` with this plan):

```bash
git checkout feat/flow-driver
```

- [ ] **Step 2: Set the automation account and Flow URL** (local machine only; already done on the user's machine, skip in a cloud checkout) — in `config/flow.config.json` set:

```json
  "flowUrl": "https://flow.google.com/",
  "expectedAccount": "nhuquynh.231123@gmail.com",
```

- [ ] **Step 3: Same keys in the example config** — in `config/flow.config.example.json` set `"flowUrl": "https://flow.google.com/"` (leave the placeholder email).

- [ ] **Step 4: Commit the example only**

```bash
git add config/flow.config.example.json
git commit -m "chore: Flow moved to flow.google.com

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1: Models and ratio validation

**Files:**
- Modify: `src/daemon/models.js`
- Modify: `src/daemon/validate.js`
- Modify: `test/errors.test.js`, `test/validate.test.js`

- [ ] **Step 1: Update the tests first.** In `test/errors.test.js` replace the last test with:

```js
test('wire models declare kind and Flow label', () => {
  assert.deepEqual(WIRE_MODELS['nano-banana-2'], { kind: 'image', flowName: 'Nano Banana 2' });
  assert.deepEqual(WIRE_MODELS['nano-banana-2-lite'], { kind: 'image', flowName: 'Nano Banana 2 Lite' });
  assert.deepEqual(WIRE_MODELS['veo-3.1-lite'], { kind: 'video', flowName: 'Veo 3.1 - Lite' });
  assert.deepEqual(WIRE_MODELS['omni-flash'], { kind: 'video', flowName: 'Omni 1.1 Flash' });
  assert.equal(Object.keys(WIRE_MODELS).length, 7);
});
```

In `test/validate.test.js`, inside `rejects malformed requests`, add:

```js
  rejects({ ...video, aspectRatio: '1:1' }, /not available for video/);
  rejects({ ...image, aspectRatio: '2:1' }, /not available for image/);
```

- [ ] **Step 2: Run — expect 3 failures**

Run: `npm test`
Expected: FAIL in `wire models declare kind and Flow label` and `rejects malformed requests`

- [ ] **Step 3: Implement** — replace `src/daemon/models.js` with:

```js
// Wire model ids shared with the Hypit provider → Flow menu labels (docs/capabilities.md).
export const WIRE_MODELS = Object.freeze({
  'nano-banana-2': { kind: 'image', flowName: 'Nano Banana 2' },
  'nano-banana-pro': { kind: 'image', flowName: 'Nano Banana Pro' },
  'nano-banana-2-lite': { kind: 'image', flowName: 'Nano Banana 2 Lite' },
  'veo-3.1-lite': { kind: 'video', flowName: 'Veo 3.1 - Lite' },
  'veo-3.1-fast': { kind: 'video', flowName: 'Veo 3.1 - Fast' },
  'veo-3.1-quality': { kind: 'video', flowName: 'Veo 3.1 - Quality' },
  'omni-flash': { kind: 'video', flowName: 'Omni 1.1 Flash' },
});

export const ASPECT_RATIOS = Object.freeze({
  image: ['16:9', '4:3', '1:1', '3:4', '9:16'],
  video: ['16:9', '9:16'],
});
```

In `src/daemon/validate.js` change the import to `import { ASPECT_RATIOS, WIRE_MODELS } from './models.js';` and directly after the `aspectRatio` format check add:

```js
  if (!ASPECT_RATIOS[kind].includes(aspectRatio)) {
    throw invalid(`aspectRatio ${aspectRatio} is not available for ${kind}; use ${ASPECT_RATIOS[kind].join(', ')}`);
  }
```

- [ ] **Step 4: Run**

Run: `npm test`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add src/daemon/models.js src/daemon/validate.js test/errors.test.js test/validate.test.js
git commit -m "feat(daemon): current Flow model list and per-kind aspect ratios

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Pure UI knowledge (`src/flow/ui.js`)

**Files:**
- Create: `src/flow/ui.js`
- Test: `test/ui.test.js`

- [ ] **Step 1: Write the failing test** — `test/ui.test.js`:

```js
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
```

- [ ] **Step 2: Run — expect failure**

Run: `npm test`
Expected: FAIL — `Cannot find module '...src/flow/ui.js'`

- [ ] **Step 3: Implement** — `src/flow/ui.js`:

```js
import { DaemonError, JobErrorCodes } from '../daemon/errors.js';
import { WIRE_MODELS } from '../daemon/models.js';

export const FLOW_HOME = 'https://flow.google.com/';

// Material icon ligatures are the same in every UI language.
export const ICONS = Object.freeze({
  add: 'add', upload: 'upload', settings: 'tune', send: 'arrow_forward', back: 'arrow_back', dropdown: 'arrow_drop_down',
});

export const RATIO_ICONS = Object.freeze({
  '16:9': 'crop_16_9', '4:3': 'crop_landscape', '1:1': 'crop_square', '3:4': 'crop_portrait', '9:16': 'crop_9_16',
});

// Text-labelled controls, per UI language seen so far.
export const LABELS = Object.freeze({
  startCreating: ['Start Creating'],
  save: ['Lưu', 'Save', 'Salva', 'Enregistrer'],
  addToPrompt: ['Thêm vào câu lệnh', 'Add to prompt'],
});

const PROJECT_URL = /^https:\/\/flow\.google\.com\/project\/[0-9a-f-]{36}/u;
const MEDIA_URL = /^https:\/\/flow-content\.google\/(image|video)\/([0-9a-f-]{36})\?\S*Signature=/u;

export function isProjectUrl(url) {
  return PROJECT_URL.test(url ?? '');
}

export function parseAccountLabel(label) {
  const match = /\(([^()\s]+@[^()\s]+)\)/u.exec(label ?? '');
  return match ? match[1] : null;
}

export function extractMedia(urls) {
  const seen = new Map();
  for (const url of urls) {
    const match = MEDIA_URL.exec(url ?? '');
    if (match && !seen.has(match[2])) seen.set(match[2], { kind: match[1], uuid: match[2], url });
  }
  return [...seen.values()];
}

export function orderIngredients(job) {
  const { firstFrame, lastFrame, ingredients = [], references = [] } = job.inputs;
  return [
    ...(firstFrame ? [{ role: 'firstFrame', file: firstFrame }] : []),
    ...(lastFrame ? [{ role: 'lastFrame', file: lastFrame }] : []),
    ...ingredients.map((file) => ({ role: 'ingredient', file })),
    ...references.map((file) => ({ role: 'reference', file })),
  ];
}

const ROLE_TEXT = {
  firstFrame: (n) => `Use attached image ${n} as the exact first frame of the video.`,
  lastFrame: (n) => `Use attached image ${n} as the exact last frame of the video.`,
  ingredient: (n) => `Use attached image ${n} as a visual ingredient (subject, character or object) that must appear in the video.`,
  reference: (n) => `Use attached image ${n} as a visual reference.`,
};

// One line only: the prompt box submits on Enter.
export function buildPrompt(job, ingredients) {
  const parts = [job.kind === 'video'
    ? `Generate exactly one ${job.duration}-second video now.`
    : 'Generate exactly one image now.'];
  parts.push('Do not ask questions and do not offer alternatives.');
  ingredients.forEach((item, index) => parts.push(ROLE_TEXT[item.role](index + 1)));
  parts.push('Follow the description exactly: include every element it mentions and add nothing it does not ask for.');
  parts.push(`Description: ${job.prompt}`);
  return parts.join(' ');
}

const LEGACY_VIDEO = { lite: 'veo-3.1-lite', test: 'veo-3.1-lite', fast: 'veo-3.1-fast', speed: 'veo-3.1-fast',
  quality: 'veo-3.1-quality', premium: 'veo-3.1-quality', flash: 'omni-flash', simple: 'omni-flash' };

export function legacyModel(kind, name) {
  if (name === undefined || name === 'auto') return kind === 'image' ? 'nano-banana-2' : 'veo-3.1-fast';
  const wire = (kind === 'video' ? LEGACY_VIDEO[name] : undefined)
    ?? (WIRE_MODELS[name] ? name : undefined)
    ?? Object.keys(WIRE_MODELS).find((id) => WIRE_MODELS[id].flowName === name);
  if (!wire || WIRE_MODELS[wire].kind !== kind) {
    const known = Object.entries(WIRE_MODELS).filter(([, m]) => m.kind === kind).map(([, m]) => m.flowName);
    throw new DaemonError(JobErrorCodes.INVALID_REQUEST, `Model "${name}" is not a Flow ${kind} model; use ${known.join(', ')}`);
  }
  return wire;
}

export function parseDuration(value) {
  if (value === undefined) return 8;
  const seconds = typeof value === 'number' ? value : Number(/^(\d+)s?$/u.exec(String(value))?.[1]);
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new DaemonError(JobErrorCodes.INVALID_REQUEST, `duration "${value}" must look like "8s"`);
  }
  return seconds;
}
```

- [ ] **Step 4: Run**

Run: `npm test`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add src/flow/ui.js test/ui.test.js
git commit -m "feat(flow): language-independent UI knowledge and prompt building

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `FlowSession` (page interaction)

**Files:**
- Create: `src/flow/session.js`

`FlowSession` touches the live page only; it is exercised by the live tasks (7–10). Keep every selector in this file.

- [ ] **Step 1: Implement** — `src/flow/session.js`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { DaemonError, JobErrorCodes } from '../daemon/errors.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { FLOW_HOME, ICONS, LABELS, RATIO_ICONS, extractMedia, isProjectUrl, parseAccountLabel } from './ui.js';

const exactText = (labels) => new RegExp(`^\\s*(${labels.map(escape).join('|')})\\s*$`, 'u');
function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function readRegistry(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

export class FlowSession {
  constructor(page, { registryFile }) {
    this.page = page;
    this.registryFile = registryFile;
  }

  icon(name) {
    return this.page.locator(`button:has(:text-is("${name}"))`);
  }

  async uiChanged(message, shotName) {
    const screenshot = await takeScreenshot(this.page, shotName).catch(() => null);
    return new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, message, { screenshot });
  }

  async account() {
    const label = await this.page.locator('a[aria-label*="@"]').first().getAttribute('aria-label', { timeout: 10_000 }).catch(() => null);
    return parseAccountLabel(label);
  }

  async dismissOverlays() {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const backdrop = this.page.locator('.cdk-overlay-backdrop-showing').last();
      if (!(await backdrop.isVisible().catch(() => false))) return;
      await backdrop.click({ position: { x: 5, y: 5 } });
      await this.page.waitForTimeout(400);
    }
  }

  async #waitForPromptBar() {
    await this.icon(ICONS.settings).first().waitFor({ state: 'visible', timeout: 30_000 })
      .catch(async () => { throw await this.uiChanged('Flow project page has no prompt bar (settings icon "tune" not found)', 'no-prompt-bar'); });
  }

  async openProject(name) {
    const registry = readRegistry(this.registryFile);
    const known = name ? registry[name] : undefined;
    if (known) {
      if (!this.page.url().startsWith(known)) await this.page.goto(known, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await this.#waitForPromptBar();
      return known;
    }
    if (!name && isProjectUrl(this.page.url())) {
      await this.#waitForPromptBar();
      return this.page.url();
    }
    await this.page.goto(FLOW_HOME, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const start = this.page.locator('button').filter({ hasText: exactText(LABELS.startCreating) }).first();
    await start.click({ timeout: 15_000 }).catch(async () => { throw await this.uiChanged('Flow home has no "Start Creating" button', 'no-start-creating'); });
    await this.page.waitForURL(/\/project\/[0-9a-f-]{36}/u, { timeout: 30_000 });
    const url = this.page.url().split('?')[0];
    await this.#waitForPromptBar();
    if (name) {
      const title = this.page.locator('input').first();
      await title.fill(name);
      await title.press('Enter');
      registry[name] = url;
      fs.mkdirSync(path.dirname(this.registryFile), { recursive: true });
      fs.writeFileSync(this.registryFile, JSON.stringify(registry, null, 2));
    }
    return url;
  }

  // Sets model, ratio, count x1 and "never ask before generating" for one kind, then saves.
  async configure({ kind, flowModel, aspectRatio }) {
    const section = kind === 'image' ? 0 : 1;
    await this.dismissOverlays();
    await this.icon(ICONS.settings).first().click();
    const pickers = this.page.locator('button[aria-haspopup="menu"]').filter({ hasText: ICONS.dropdown });
    await pickers.nth(1).waitFor({ state: 'visible', timeout: 10_000 })
      .catch(async () => { throw await this.uiChanged('Flow settings panel did not open', 'no-settings-panel'); });

    await this.page.locator('input[type="radio"][value="2"]').first().check({ force: true });

    const ratioIcon = RATIO_ICONS[aspectRatio];
    const ratios = this.page.locator('button[role="radio"]').filter({ has: this.page.locator(`:text-is("${ratioIcon}")`) });
    // 16:9 and 9:16 exist in both sections; 4:3, 1:1, 3:4 only in the image section.
    await ratios.nth((await ratios.count()) > 1 ? section : 0).click();
    await this.page.locator('button[role="radio"]').filter({ hasText: exactText(['x1']) }).nth(section).click();

    await pickers.nth(section).click();
    const item = this.page.locator('[role="menuitem"]').filter({ hasText: new RegExp(`${escape(flowModel)}\\s*$`, 'u') }).first();
    await item.click({ timeout: 10_000 }).catch(async () => { throw await this.uiChanged(`Flow has no ${kind} model "${flowModel}"`, 'no-model-item'); });
    const shown = (await pickers.nth(section).innerText()).replace(ICONS.dropdown, '').trim();
    if (!shown.endsWith(flowModel)) throw await this.uiChanged(`Flow shows model "${shown}" instead of "${flowModel}"`, 'model-not-selected');

    await this.page.locator('button').filter({ hasText: exactText(LABELS.save) }).last().click();
    await this.#waitForPromptBar();
  }

  async clearPrompt() {
    const box = this.page.locator('[contenteditable="true"]').last();
    await box.click();
    await this.page.keyboard.press('Control+A');
    await this.page.keyboard.press('Delete');
  }

  async attachIngredients(files) {
    for (const file of files) {
      await this.dismissOverlays();
      await this.icon(ICONS.add).last().click();
      const chooser = this.page.waitForEvent('filechooser', { timeout: 15_000 });
      await this.icon(ICONS.upload).first().click()
        .catch(async () => { throw await this.uiChanged('Ingredient picker has no upload button', 'no-upload-button'); });
      await (await chooser).setFiles(file);
      const confirm = this.page.locator('button').filter({ hasText: exactText(LABELS.addToPrompt) }).first();
      await confirm.waitFor({ state: 'visible', timeout: 60_000 });
      await this.page.waitForFunction((el) => !el.disabled, await confirm.elementHandle(), { timeout: 60_000 });
      await confirm.click();
      await this.page.waitForTimeout(800);
    }
  }

  async typePrompt(text) {
    const box = this.page.locator('[contenteditable="true"]').last();
    await box.click();
    await this.page.keyboard.press('Control+End');
    await this.page.keyboard.insertText(text);
  }

  async send() {
    const send = this.icon(ICONS.send).last();
    await send.waitFor({ state: 'visible', timeout: 10_000 })
      .catch(async () => { throw await this.uiChanged('Flow send button (arrow_forward) is not available', 'no-send-button'); });
    if (await send.isDisabled()) throw await this.uiChanged('Flow send button is disabled', 'send-disabled');
    await send.click();
  }

  async mediaSnapshot() {
    const urls = await this.page.evaluate(() => [...document.querySelectorAll('img,video,source')]
      .flatMap((el) => [el.currentSrc, el.src, el.getAttribute('poster')]).filter(Boolean));
    return extractMedia(urls);
  }

  async #busy() {
    const sendVisible = await this.icon(ICONS.send).last().isVisible().catch(() => false);
    const progressTile = await this.page.getByText(/^\d{1,3}%$/u).first().isVisible().catch(() => false);
    return !sendVisible || progressTile;
  }

  async waitForMedia(kind, baseline, { timeoutMs, progress }) {
    const deadline = Date.now() + timeoutMs;
    let idleSince = null;
    while (Date.now() < deadline) {
      await this.page.waitForTimeout(3_000);
      const fresh = (await this.mediaSnapshot()).filter((item) => item.kind === kind && !baseline.has(item.uuid));
      if (fresh.length > 0) return fresh;
      if (await this.#busy()) {
        idleSince = null;
        progress(kind === 'video' ? 'rendering video' : 'generating image');
      } else if ((idleSince ??= Date.now()) < Date.now() - 20_000) {
        const screenshot = await takeScreenshot(this.page, 'agent-replied-without-media').catch(() => null);
        throw new DaemonError(JobErrorCodes.FLOW_CLARIFICATION,
          "Flow's agent stopped without producing media (it may have asked a question or refused). Read its reply in the Flow project.",
          { screenshot });
      }
    }
    throw new FlowError(ErrorCodes.GENERATION_TIMEOUT, `No new ${kind} appeared within ${Math.round(timeoutMs / 1000)}s`);
  }

  async download(media, outputDir) {
    const response = await this.page.request.get(media.url, { timeout: 120_000 });
    const mediaType = (response.headers()['content-type'] ?? '').split(';')[0].trim();
    if (!response.ok() || !mediaType.startsWith(`${media.kind}/`)) {
      throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, `Download of ${media.uuid} returned HTTP ${response.status()} ${mediaType}`,
        { mediaUuids: [media.uuid] });
    }
    const extension = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'video/mp4': '.mp4' }[mediaType] ?? '';
    if (!extension) throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, `Unexpected media type ${mediaType}`, { mediaUuids: [media.uuid] });
    fs.mkdirSync(outputDir, { recursive: true });
    const file = path.join(outputDir, `flow_${media.uuid.slice(0, 8)}${extension}`);
    fs.writeFileSync(file, await response.body());
    return { file, mediaType, mediaUuid: media.uuid };
  }

  // Reads "1.050 tín dụng Google Flow" (or "1,050 … credits") from the account menu.
  async credits() {
    await this.dismissOverlays();
    await this.page.locator('[role="button"]').filter({ hasText: /^\s*PRO\s*$/u }).first().click();
    const text = await this.page.locator('.cdk-overlay-pane').last().innerText({ timeout: 10_000 });
    await this.dismissOverlays();
    const match = /([\d.,]+)\s*(tín dụng|credits)/iu.exec(text);
    return match ? Number(match[1].replace(/[.,]/gu, '')) : null;
  }
}
```

- [ ] **Step 2: Syntax check**

Run: `node --check src/flow/session.js && npm test`
Expected: no output from `--check`; tests pass

- [ ] **Step 3: Commit**

```bash
git add src/flow/session.js
git commit -m "feat(flow): FlowSession for the flow.google.com UI

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Driver orchestration through a session

**Files:**
- Modify: `src/daemon/playwright-driver.js` (rewrite)
- Test: `test/driver.test.js`

- [ ] **Step 1: Write the failing test** — `test/driver.test.js`:

```js
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
```

- [ ] **Step 2: Run — expect failures**

Run: `npm test`
Expected: FAIL in `test/driver.test.js`

- [ ] **Step 3: Implement** — replace `src/daemon/playwright-driver.js` with:

```js
import { getPage, isBrowserConnected } from '../browser/connect.js';
import { launchKiaraProfile } from '../browser/launch-profile.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { FlowSession } from '../flow/session.js';
import { FLOW_HOME, buildPrompt, orderIngredients } from '../flow/ui.js';
import { DaemonError, JobErrorCodes } from './errors.js';

async function connectToFlow() {
  if (!isBrowserConnected()) await launchKiaraProfile(false);
  const page = getPage();
  if (!page.url().startsWith(FLOW_HOME)) await page.goto(FLOW_HOME, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  if (page.url().includes('accounts.google.com')) {
    throw new FlowError(ErrorCodes.NOT_LOGGED_IN, 'Flow redirected to Google sign-in; sign in once in the dedicated Chrome (scripts/ensure-flow-chrome.ps1).');
  }
  return page;
}

export class PlaywrightFlowDriver {
  constructor({ registryFile, expectedAccount, renderTimeoutMs = 900_000, connect = connectToFlow,
    sessionFactory = (page) => new FlowSession(page, { registryFile }) } = {}) {
    Object.assign(this, { expectedAccount, renderTimeoutMs, connect, sessionFactory });
  }

  async #session() {
    return this.sessionFactory(await this.connect());
  }

  async health() {
    let session;
    try {
      session = await this.#session();
    } catch (err) {
      return { chrome: err.code === ErrorCodes.NOT_LOGGED_IN, loggedIn: false, error: err.message };
    }
    const account = await session.account();
    return account ? { chrome: true, loggedIn: true, account } : { chrome: true, loggedIn: false, error: 'No Google account chip on the Flow page' };
  }

  generateImage(job, progress) { return this.#generate(job, progress); }
  generateVideo(job, progress) { return this.#generate(job, progress); }

  async #generate(job, progress) {
    const session = await this.#session();
    const account = await session.account();
    if (this.expectedAccount && account !== this.expectedAccount) {
      throw new DaemonError(JobErrorCodes.ACCOUNT_MISMATCH,
        `Flow is signed in as ${account ?? 'nobody'}, expected ${this.expectedAccount}`);
    }
    progress('opening project');
    await session.openProject(job.project);
    progress('configuring model');
    await session.configure({ kind: job.kind, flowModel: job.flowModel, aspectRatio: job.aspectRatio });
    await session.clearPrompt();
    const ingredients = orderIngredients(job);
    if (ingredients.length > 0) {
      progress('attaching references');
      await session.attachIngredients(ingredients.map((item) => item.file));
    }
    const baseline = new Set((await session.mediaSnapshot()).map((item) => item.uuid));
    progress('sending prompt');
    await session.typePrompt(buildPrompt(job, ingredients));
    await session.send();
    const [first] = await session.waitForMedia(job.kind, baseline, { timeoutMs: this.renderTimeoutMs, progress });
    progress('downloading');
    return [await session.download(first, job.outputDir)];
  }

  async redownload(uuid, kind, outputDir) {
    const session = await this.#session();
    const found = (await session.mediaSnapshot()).find((item) => item.uuid === uuid && item.kind === kind);
    if (!found) throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, `Media ${uuid} is no longer on the Flow page`);
    return session.download(found, outputDir);
  }
}
```

- [ ] **Step 4: Run**

Run: `npm test`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add src/daemon/playwright-driver.js test/driver.test.js
git commit -m "feat(daemon): drive jobs through FlowSession with real account check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: MCP generate tools reuse the driver; delete legacy handlers

**Files:**
- Modify: `src/daemon/tool-handlers.js`
- Modify: `src/daemon/main.js`
- Delete: `src/tools/generate-image.js`, `src/tools/generate-video.js`

- [ ] **Step 1: tool-handlers imports** — in `src/daemon/tool-handlers.js` delete the two lines importing `handleGenerateImage` and `handleGenerateVideo`, and add:

```js
import path from 'node:path';
import { legacyModel, parseDuration } from '../flow/ui.js';
import { WIRE_MODELS } from './models.js';
```

- [ ] **Step 2: Add the shared generator** above `export async function callTool`:

```js
// MCP entry to the same pipeline the daemon jobs use. auto_confirm !== true never touches Flow.
async function generateForTool(kind, args, options) {
  const model = legacyModel(kind, args?.model);
  const aspectRatio = args?.ratio ?? (kind === 'image' ? '1:1' : '16:9');
  const duration = kind === 'video' ? parseDuration(args?.duration) : undefined;
  if (args?.auto_confirm !== true) {
    return { status: 'ready_for_confirmation', type: kind, model_used: WIRE_MODELS[model].flowName, ratio: aspectRatio, duration,
      message: 'Nothing was sent to Flow. Call again with auto_confirm=true to generate; this may spend Flow credits.' };
  }
  const job = {
    kind, model, flowModel: WIRE_MODELS[model].flowName, prompt: args.prompt, aspectRatio, duration,
    project: args.project_name ?? args.campaign,
    outputDir: args.output_folder ?? path.join(options.outputsDir, 'mcp', new Date().toISOString().replace(/[:.]/gu, '-')),
    inputs: { references: kind === 'image' ? (args.reference_images ?? []) : [], ingredients: kind === 'video' ? (args.reference_images ?? []) : [] },
  };
  const media = kind === 'image' ? await options.driver.generateImage(job, () => {}) : await options.driver.generateVideo(job, () => {});
  return { status: 'success', type: kind, model_used: job.flowModel, ratio: aspectRatio, duration, prompt: args.prompt,
    files: media.map((item) => item.file), credits_consumed: true };
}
```

- [ ] **Step 3: Route the two tools** — replace:

```js
    case 'flow_generate_image': return handleGenerateImage(args);
    case 'flow_generate_video': return handleGenerateVideo(args);
```

with:

```js
    case 'flow_generate_image': return generateForTool('image', args, options);
    case 'flow_generate_video': return generateForTool('video', args, options);
```

- [ ] **Step 4: Wire options in `src/daemon/main.js`** — replace the driver construction and the `callTool` option:

```js
const driver = new PlaywrightFlowDriver({
  registryFile: path.join(dataDir, 'projects.json'),
  expectedAccount: get('expectedAccount'),
  renderTimeoutMs: get('videoGenerationTimeoutMs', 900_000),
});
```

```js
  callTool: (name, args) => callTool(name, args, {
    runnerStatus: () => runner.status(), driver, outputsDir: path.join(dataDir, 'outputs'),
  }),
```

- [ ] **Step 5: Update the tool schema** — in `src/index.js`, in the `flow_generate_video` `inputSchema.properties`, add after `duration`:

```js
        reference_images: { type: 'array', items: { type: 'string' }, description: 'Paths to images the video must include as ingredients (optional).' },
```

and in both `flow_generate_image` and `flow_generate_video` change the `model` description to list the current names: image `Nano Banana 2 (default), Nano Banana Pro, Nano Banana 2 Lite`; video `lite, fast (default), quality, flash (Omni 1.1 Flash), or the exact Flow name`.

- [ ] **Step 6: Delete legacy handlers and verify nothing imports them**

```bash
git rm src/tools/generate-image.js src/tools/generate-video.js
grep -rn "generate-image.js\|generate-video.js\|handleGenerate" src test
```

Expected: `grep` prints nothing.

- [ ] **Step 7: Check and test**

Run: `node --check src/daemon/tool-handlers.js && node --check src/daemon/main.js && node --check src/index.js && npm test`
Expected: all pass (the MCP proxy test still lists 17 tools)

- [ ] **Step 8: Commit**

```bash
git add -A src/daemon/tool-handlers.js src/daemon/main.js src/index.js src/tools
git commit -m "feat(mcp): generate tools use the daemon driver; remove legacy handlers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1:** In the README Daemon section, replace the models line and the `UNSUPPORTED_INPUT` sentence with:

```markdown
Models: `nano-banana-2`, `nano-banana-pro`, `nano-banana-2-lite`, `veo-3.1-lite`, `veo-3.1-fast`,
`veo-3.1-quality`, `omni-flash` (Omni 1.1 Flash). Images accept ratios 16:9, 4:3, 1:1, 3:4, 9:16;
videos 16:9 and 9:16. Reference images (image jobs), first/last frames and ingredients (video jobs)
are uploaded through Flow's ingredient picker.

The driver targets `https://flow.google.com/`, finds controls by their Material icon names, sets
model/ratio/count in Flow's settings panel before each job and switches Flow's "confirm before
generating" option to "never" — the daemon's `confirmCredits` flag is the spending gate. It refuses
to run when the signed-in account differs from `expectedAccount`. Flow adds a visible AI watermark
in some regions.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: describe the flow.google.com driver

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Live tasks (Claude with the user — need the signed-in Chrome)

Run the daemon (`npm run daemon`) after the Chrome is up (`scripts/ensure-flow-chrome.ps1`). Every generation below needs the user's explicit go-ahead first; state the model and expected credit use. After each task, fix `session.js` if a step fails (screenshot path is in the job error details), add or adjust a unit test where the fix is pure logic, commit, and re-run.

### Task 7: No-credit checks

- [ ] `curl http://127.0.0.1:47821/health` → `loggedIn: true`, `account: "nhuquynh.231123@gmail.com"`, `accountMatches: true`.
- [ ] Temporarily set `expectedAccount` to another address, restart the daemon, submit an image job → fails with `ACCOUNT_MISMATCH` and nothing is typed into Flow. Restore the config.
- [ ] Submit a job with `confirmCredits: false` → `CREDITS_NOT_CONFIRMED`, browser untouched.
- [ ] Call MCP `flow_generate_image` with `auto_confirm: false` → `ready_for_confirmation`, browser untouched.

### Task 8: Image, text only (approval needed; Nano Banana 2, count x1)

- [ ] Submit `{ kind: 'image', model: 'nano-banana-2', prompt: 'a red apple on a wooden table, studio light', aspectRatio: '1:1', project: 'daemon-smoke', confirmCredits: true, idempotencyKey: 'a2-image-0001' }` and poll to the end.
- [ ] Verify: a project titled `daemon-smoke` exists on the Flow home page; `data/projects.json` maps it; the output is a 1:1 JPEG/PNG of an apple; exactly one new image in the project (x1 honoured); Flow settings show Nano Banana 2 / 1:1 / x1 / "never".
- [ ] Read the balance with `FlowSession.credits()` before and after; record the image credit cost in `config/capabilities.json` (`image["nano-banana-2"].credits`).
- [ ] Re-submit the same `idempotencyKey` → `deduplicated: true`, no new Flow activity.

### Task 9: Image with a reference (approval needed)

- [ ] Upload the Task 8 output via `POST /uploads`, submit an image job with `references: [<id>]` and prompt `the same apple, now cut in half`.
- [ ] Verify: the ingredient picker uploaded and attached the file (it shows in the prompt before sending), the result resembles the reference. If uploads are not auto-selected after `setFiles`, select the newest item in the picker's recent list before clicking `Thêm vào câu lệnh` — change `attachIngredients` accordingly.
- [ ] Record `maxReferences` if the picker shows a limit.

### Task 10: Video (approval needed; Veo 3.1 Lite, 8 s, 9:16)

- [ ] Text only: `{ kind: 'video', model: 'veo-3.1-lite', prompt: 'a paper boat drifting on a calm lake at sunrise', aspectRatio: '9:16', duration: 8, … }`.
- [ ] Verify the finished video's DOM source. If it is not `https://flow-content.google/video/<uuid>?…Signature=…`, update `MEDIA_URL` in `src/flow/ui.js` and the `extractMedia` test with the observed pattern. Confirm the MP4 is 9:16 and ~8 s (`ffprobe` if available).
- [ ] First frame: upload the Task 8 apple, submit a Veo 3.1 Lite 8 s job with `firstFrame: <id>` and prompt `the camera slowly pushes in`. Verify the video starts on the apple.
- [ ] Try one other duration (6 s) and record which durations Flow accepts for Veo 3.1 Lite (a refusal surfaces as `FLOW_CLARIFICATION`).
- [ ] Record credits per video and the allowed durations/modes in `config/capabilities.json` and `docs/capabilities.md`; commit.

### Task 11: Merge

- [ ] `npm test` all pass; push `feat/flow-driver`; open a PR into `master` (after PR #1) describing live results and any selector changes made in Tasks 7–10.

---

## Self-review notes

- Spec coverage: all six wire models + Nano Banana 2 Lite; references, first/last frame, ingredients; real account check; idempotency and credit gate unchanged; failure codes `UI_CHANGED` (with screenshot), `FLOW_CLARIFICATION` (agent stops without media), `RENDER_TIMEOUT`, `DOWNLOAD_FAILED` (with uuid for retry), `ACCOUNT_MISMATCH`. `CONTENT_REJECTED` and `INSUFFICIENT_CREDITS` surface as `FLOW_CLARIFICATION` until their texts are observed; distinguishing them is deferred until a live refusal is seen.
- Known risk: `configure` assumes the image section precedes the video section and that the first `input` on a project page is the title (both observed on 2026-10-01). Tasks 8 and 10 verify them.
