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
