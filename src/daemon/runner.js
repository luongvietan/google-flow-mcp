import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DaemonError, JobErrorCodes, toJobError } from './errors.js';
import { WIRE_MODELS } from './models.js';

export class JobRunner {
  #draining = null;
  #running = null;

  #lastVideoEnd = 0;

  // videoCooldownMs: Flow rejected (and still charged) videos submitted back to back, so each video
  // waits this long after the previous one finished. The job stays queued while it waits.
  constructor({ store, uploads, driver, mutex, outputsDir, maxDownloadRetries = 3, videoCooldownMs = 0, log = () => {} }) {
    Object.assign(this, { store, uploads, driver, mutex, outputsDir, maxDownloadRetries, videoCooldownMs, log });
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
      // The job stays `queued` until it holds the browser: a restart while it waits behind a
      // tool call must re-run it, not report it as interrupted with credits possibly spent.
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
    if (this.store.get(id).request.kind === 'video') {
      const wait = this.#lastVideoEnd + this.videoCooldownMs - Date.now();
      if (wait > 0) {
        this.store.update(id, { phase: `cooling down ${Math.ceil(wait / 1000)}s` });
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
    try {
      await this.#run(id);
    } finally {
      if (this.store.get(id).request.kind === 'video') this.#lastVideoEnd = Date.now();
    }
  }

  async #run(id) {
    const { request } = this.store.update(id, { state: 'running', phase: 'starting', startedAt: new Date().toISOString() });
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
