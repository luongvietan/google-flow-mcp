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
