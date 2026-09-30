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
