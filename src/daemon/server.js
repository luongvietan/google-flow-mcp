import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { DaemonError, JobErrorCodes, toJobError } from './errors.js';
import { validateJobRequest } from './validate.js';
import { MAX_UPLOAD_BYTES } from './upload-store.js';

const MAX_JSON_BYTES = 1024 * 1024;
const STATUS = { INVALID_REQUEST: 400, UNAUTHORIZED: 401, NOT_FOUND: 404 };

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new DaemonError(JobErrorCodes.INVALID_REQUEST, `Request body exceeds ${limit} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const text = (await readBody(req, MAX_JSON_BYTES)).toString('utf8');
  if (text.trim().length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new DaemonError(JobErrorCodes.INVALID_REQUEST, 'Body is not valid JSON');
  }
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function authorized(req, token) {
  const header = req.headers.authorization ?? '';
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
  const expected = Buffer.from(token);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function publicJob(job, store) {
  return {
    id: job.id, state: job.state, phase: job.phase, queuePosition: store.queuePosition(job.id),
    createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt, error: job.error,
    outputs: job.outputs.map(({ index, mediaType, sha256, bytes }) => ({ index, mediaType, sha256, bytes })),
  };
}

export function createDaemonServer({ token, store, uploads, runner, mutex, driver, expectedAccount, callTool }) {
  let lastBrowser = { chrome: false, loggedIn: false };

  async function health() {
    // Never queue a probe behind a multi-minute render: report the last known state instead.
    let browser;
    if (mutex.busy) {
      browser = { ...lastBrowser, stale: true };
    } else {
      browser = await mutex.run(() => driver.health());
      lastBrowser = browser;
    }
    const accountMatches = expectedAccount && browser.account ? browser.account === expectedAccount : null;
    return { ok: true, ...browser, accountMatches, queue: runner.status() };
  }

  function requireJob(id) {
    const job = store.get(id);
    if (!job) throw new DaemonError(JobErrorCodes.NOT_FOUND, `Unknown job ${id}`);
    return job;
  }

  async function tool(req, res, name) {
    const args = await readJson(req);
    // Headers go out immediately and whitespace keeps the connection alive, so a
    // multi-minute tool call does not hit the client's header or body timeouts.
    res.writeHead(200, { 'content-type': 'application/json' });
    const keepAlive = setInterval(() => res.write(' '), 30_000);
    try {
      const result = await mutex.run(() => callTool(name, args));
      res.end(JSON.stringify({ ok: true, result }));
    } catch (err) {
      res.end(JSON.stringify({ ok: false, error: toJobError(err) }));
    } finally {
      clearInterval(keepAlive);
    }
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean);
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, await health());
    if (!authorized(req, token)) throw new DaemonError(JobErrorCodes.UNAUTHORIZED, 'Missing or wrong bearer token');

    if (req.method === 'POST' && url.pathname === '/uploads') {
      const mediaType = (req.headers['content-type'] ?? '').split(';')[0].trim();
      const upload = uploads.put(await readBody(req, MAX_UPLOAD_BYTES), mediaType);
      return send(res, 201, { id: upload.id, mediaType: upload.mediaType });
    }
    if (req.method === 'POST' && url.pathname === '/jobs') {
      const request = validateJobRequest(await readJson(req));
      for (const id of [...request.references, ...request.ingredients, request.firstFrame, request.lastFrame]) {
        if (id !== undefined && !uploads.resolve(id)) throw new DaemonError(JobErrorCodes.INVALID_REQUEST, `Unknown upload id ${id}`);
      }
      const { job, deduplicated } = runner.enqueue(request);
      return send(res, deduplicated ? 200 : 201, { id: job.id, state: job.state, deduplicated });
    }
    if (req.method === 'GET' && parts[0] === 'jobs' && parts.length === 2) {
      return send(res, 200, publicJob(requireJob(parts[1]), store));
    }
    if (req.method === 'GET' && parts[0] === 'jobs' && parts[2] === 'outputs' && parts.length === 4) {
      const output = requireJob(parts[1]).outputs[Number(parts[3])];
      if (!output) throw new DaemonError(JobErrorCodes.NOT_FOUND, `Job ${parts[1]} has no output ${parts[3]}`);
      res.writeHead(200, { 'content-type': output.mediaType, 'content-length': output.bytes, 'x-sha256': output.sha256 });
      return fs.createReadStream(output.file).pipe(res);
    }
    if (req.method === 'POST' && parts[0] === 'tools' && parts.length === 2) return tool(req, res, parts[1]);
    throw new DaemonError(JobErrorCodes.NOT_FOUND, `No route ${req.method} ${url.pathname}`);
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      const error = toJobError(err);
      if (res.headersSent) return res.end();
      send(res, STATUS[error.code] ?? 500, { error });
    });
  });
  server.requestTimeout = 0;
  return server;
}
