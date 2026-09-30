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
