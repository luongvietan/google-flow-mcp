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
    const found = (await session.mediaSnapshot({ generatedOnly: true })).find((item) => item.uuid === uuid && item.kind === kind);
    if (!found) throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, `Media ${uuid} is no longer on the Flow page`);
    return session.download(found, outputDir);
  }
}
