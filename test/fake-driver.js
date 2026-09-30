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
