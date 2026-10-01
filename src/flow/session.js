import fs from 'node:fs';
import path from 'node:path';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { DaemonError, JobErrorCodes } from '../daemon/errors.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { extractRenderedModels } from './metadata.js';
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
    // The fixed "add New project" button creates a project; "Start Creating" only reopens the latest one.
    await this.icon(ICONS.add).first().click({ timeout: 15_000 })
      .catch(async () => { throw await this.uiChanged('Flow home has no "New project" (add) button', 'no-new-project'); });
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

  // "Start new session" (edit_square) keeps the project and its media grid but empties the agent chat,
  // which is where results are read from.
  async newChatSession() {
    await this.dismissOverlays();
    await this.icon('edit_square').first().click({ timeout: 10_000 })
      .catch(async () => { throw await this.uiChanged('Flow has no "Start new session" (edit_square) button', 'no-new-session'); });
    await this.page.waitForFunction(() => document.querySelectorAll('flow-a2ui-image-option, flow-a2ui-video-option').length === 0,
      null, { timeout: 10_000 })
      .catch(async () => { throw await this.uiChanged('The agent chat still shows earlier results after starting a new session', 'session-not-cleared'); });
    await this.#waitForPromptBar();
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
    await this.dismissOverlays();
    const chips = this.page.locator('button.chip-container:has(mat-icon:text-is("cancel"))');
    // Bounded: a chip that survives its cancel click must not hold the browser lock forever.
    for (let attempt = 0; await chips.count(); attempt += 1) {
      if (attempt >= 20) throw await this.uiChanged('Old ingredient chips could not be removed from the prompt', 'chips-not-cleared');
      const chip = chips.first();
      await chip.hover();
      await chip.locator('mat-icon').filter({ hasText: /^cancel$/u }).click();
    }
    const box = this.page.locator('[contenteditable="true"]').last();
    await box.click();
    await this.page.keyboard.press('Control+A');
    await this.page.keyboard.press('Delete');
  }

  // "Add to prompt" adds the picker's active item, which stays on the previous asset after an
  // upload. Select the uploaded asset by its file name (upload-store names are unique) first.
  async attachIngredients(files) {
    for (const file of files) {
      const chipCount = await this.page.locator('button.chip-container:has(mat-icon:text-is("cancel"))').count();
      await this.dismissOverlays();
      await this.icon(ICONS.add).last().click();
      const upload = this.icon(ICONS.upload).first();
      await upload.waitFor({ state: 'visible', timeout: 15_000 })
        .catch(async () => { throw await this.uiChanged('Ingredient picker has no upload button', 'no-upload-button'); });
      await this.page.waitForTimeout(1_000);
      const name = path.basename(file);
      const named = this.page.locator('.asset-item').filter({ hasText: name });
      const before = await named.count();
      if (before === 0) {
        const chooser = this.page.waitForEvent('filechooser', { timeout: 15_000 });
        await upload.click();
        await (await chooser).setFiles(file);
        // A new entry appears at once as a placeholder; it is selectable only once its thumbnail loads.
        await this.page.waitForFunction(({ name, before }) => {
          const items = [...document.querySelectorAll('.asset-item')].filter((el) => el.innerText.includes(name));
          return items.length > before && items.every((el) => el.querySelector('img[src*="flow-content.google/"]'));
      }, { name, before }, { timeout: 120_000 })
        .catch(async () => { throw await this.uiChanged(`Uploaded ${name} never finished in the ingredient picker`, 'upload-not-listed'); });
      }
      const asset = named.first();
      await asset.click();
      const confirm = this.page.locator('button').filter({ hasText: exactText(LABELS.addToPrompt) }).first();
      // Selecting a previous upload attaches it immediately and closes the picker.
      if (before > 0 && !(await confirm.isVisible().catch(() => false))) {
        await this.page.waitForFunction((count) => [...document.querySelectorAll('button.chip-container')].filter(el => [...el.querySelectorAll('mat-icon')].some(icon => icon.textContent.trim() === 'cancel')).length === count + 1, chipCount, { timeout: 5_000 });
        continue;
      }
      await this.page.waitForFunction((el) => el.classList.contains('asset-item-active'), await asset.elementHandle(), { timeout: 5_000 })
        .catch(async () => { throw await this.uiChanged(`Could not select ${name} in the ingredient picker`, 'upload-not-selected'); });
      await this.page.waitForFunction((el) => !el.disabled, await confirm.elementHandle(), { timeout: 30_000 });
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
    // The button enables a moment after the text lands in the prompt box.
    const handle = await send.elementHandle();
    await this.page.waitForFunction((el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true', handle, { timeout: 10_000 })
      .catch(async () => { throw await this.uiChanged('Flow send button stayed disabled', 'send-disabled'); });
    await send.click();
  }

  // generatedOnly: agent results only, read from the chat's <flow-a2ui-image-option> and
  // <flow-a2ui-video-option> elements (uploaded ingredients also become project media and must
  // never count as results). A video option shows an image thumbnail with the video's uuid.
  async mediaSnapshot({ generatedOnly = false } = {}) {
    if (!generatedOnly) {
      const urls = await this.page.evaluate(() => [...document.querySelectorAll('img,video,source')]
        .flatMap((el) => [el.currentSrc, el.src, el.getAttribute('poster')]).filter(Boolean));
      return extractMedia(urls);
    }
    const options = await this.page.evaluate(() => [...document.querySelectorAll('flow-a2ui-image-option img, flow-a2ui-video-option img')]
      .map((img) => ({ kind: img.closest('flow-a2ui-video-option') ? 'video' : 'image', url: img.currentSrc || img.src })));
    const byUuid = new Map();
    for (const { kind, url } of options) {
      for (const item of extractMedia([url])) if (!byUuid.has(item.uuid)) byUuid.set(item.uuid, { ...item, kind });
    }
    return [...byUuid.values()];
  }

  // The signed video URL is only put on the grid tile's <video> once the tile is hovered.
  async #videoUrl(uuid) {
    await this.dismissOverlays();
    const tile = this.page.locator('flow-video-tile').filter({ has: this.page.locator(`img[src*="${uuid}"], video[src*="${uuid}"]`) }).first();
    await tile.hover({ timeout: 15_000 });
    const video = this.page.locator(`video[src*="/video/${uuid}"]`).first();
    await video.waitFor({ state: 'attached', timeout: 15_000 });
    return video.getAttribute('src');
  }

  async #busy() {
    const sendVisible = await this.icon(ICONS.send).last().isVisible().catch(() => false);
    const progressTile = await this.page.getByText(/^\d{1,3}%$/u).first().isVisible().catch(() => false);
    return !sendVisible || progressTile;
  }

  // Failed generations render a tile with <mat-icon class="error-icon">warning</mat-icon> and Flow's own message.
  async #errorTexts() {
    return this.page.evaluate(() => [...document.querySelectorAll('mat-icon.error-icon')]
      .map((icon) => (icon.closest('.error-tile') ?? icon.parentElement?.parentElement ?? icon).innerText.replace(/\s+/gu, ' ').trim()));
  }

  async waitForMedia(kind, baseline, { timeoutMs, progress }) {
    const deadline = Date.now() + timeoutMs;
    const errorsAtStart = (await this.#errorTexts()).length;
    let idleSince = null;
    while (Date.now() < deadline) {
      await this.page.waitForTimeout(3_000);
      const fresh = (await this.mediaSnapshot({ generatedOnly: true })).filter((item) => item.kind === kind && !baseline.has(item.uuid));
      if (fresh.length > 0) return fresh;
      const errors = await this.#errorTexts();
      if (errors.length > errorsAtStart) {
        const screenshot = await takeScreenshot(this.page, 'generation-failed').catch(() => null);
        throw new DaemonError(JobErrorCodes.GENERATION_FAILED,
          `Flow could not generate the ${kind}: ${errors[0].replace(/^warning\s*/u, '').replace(/\s*(refresh|undo|delete_forever)/gu, '')}`,
          { screenshot });
      }
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
    let url = media.url;
    if (media.kind === 'video' && !url.includes('/video/')) {
      url = await this.#videoUrl(media.uuid).catch((err) => {
        throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, `No playable video for ${media.uuid}: ${err.message}`, { mediaUuids: [media.uuid] });
      });
    }
    const response = await this.page.request.get(url, { timeout: 120_000 });
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
  // The account panel is a role=dialog without a backdrop; it closes through its own close icon.
  async credits() {
    await this.dismissOverlays();
    // Hovering an off-screen media tile scrolls the document and hides the account header.
    await this.page.evaluate(() => {
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
      document.querySelector('.cdk-virtual-scrollable.page-container')?.scrollTo({ top: 0, behavior: 'instant' });
    });
    await this.page.waitForTimeout(200);
    const panel = this.page.locator('[role="dialog"]').filter({ hasText: /tín dụng|credits/iu }).first();
    if (!(await panel.isVisible().catch(() => false))) {
      await this.page.locator('[role="button"]').filter({ hasText: /^\s*PRO\s*$/u }).first().click();
      await panel.waitFor({ state: 'visible', timeout: 10_000 });
    }
    const text = await panel.innerText();
    await panel.locator('button:has(:text-is("close"))').first().click();
    const match = /([\d.,]+)\s*(tín dụng|credits)/iu.exec(text);
    return match ? Number(match[1].replace(/[.,]/gu, '')) : null;
  }

  async verifyMediaModel(media, expected) {
    const url = media.kind === 'video' && !media.url.includes('/video/') ? await this.#videoUrl(media.uuid) : media.url;
    const models = new Map();
    let responses = 0;
    const onResponse = response => {
      const url = new URL(response.url());
      if (url.hostname !== 'flow.google.com' || !url.pathname.endsWith('/data/batchexecute') || responses++ >= 64) return;
      void response.text().then(text => {
        if (text.length > 8 * 1024 * 1024) return;
        for (const [id, model] of extractRenderedModels(text)) {
          models.set(id, models.has(id) && models.get(id) !== model ? null : model);
        }
      }).catch(() => {});
    };
    this.page.on('response', onResponse);
    try {
      // Reload the finished project's persisted history. This performs no generation;
      // model_display_name and media_id are server fields, never parsed from the prompt.
      await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
      const deadline = Date.now() + 15_000;
      while (!models.has(media.uuid) && Date.now() < deadline) await this.page.waitForTimeout(200);
      const actual = models.get(media.uuid);
      if (!actual) throw new DaemonError(JobErrorCodes.UI_CHANGED, 'Persisted media metadata has no unambiguous model', { mediaUuid: media.uuid });
      if (actual !== expected) throw new DaemonError(JobErrorCodes.UNSUPPORTED_INPUT, `Flow generated media with ${actual}, requested ${expected}; no automatic resubmission`, { mediaUuid: media.uuid, actualModel: actual, requestedModel: expected });
      return { ...media, url };
    } finally {
      this.page.off('response', onResponse);
    }
  }
}
