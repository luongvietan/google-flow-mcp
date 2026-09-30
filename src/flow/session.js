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
