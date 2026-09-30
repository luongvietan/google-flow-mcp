#!/usr/bin/env node
import path from 'node:path';
import { get, getFlowHome } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { JobStore } from './job-store.js';
import { UploadStore } from './upload-store.js';
import { Mutex } from './mutex.js';
import { JobRunner } from './runner.js';
import { createDaemonServer } from './server.js';
import { loadOrCreateToken } from './token.js';
import { PlaywrightFlowDriver } from './playwright-driver.js';
import { callTool } from './tool-handlers.js';

const home = getFlowHome();
const dataDir = path.join(home, 'data');
const token = loadOrCreateToken(path.join(home, 'config', 'daemon-token'));
const store = new JobStore(path.join(dataDir, 'jobs.json'));
const interrupted = store.recoverInterrupted();
const uploads = new UploadStore(path.join(dataDir, 'uploads'));
const mutex = new Mutex();
const driver = new PlaywrightFlowDriver({
  registryFile: path.join(dataDir, 'projects.json'),
  expectedAccount: get('expectedAccount'),
  renderTimeoutMs: get('videoGenerationTimeoutMs', 900_000),
  verifyModel: get('verifyModel', true),
});
const runner = new JobRunner({
  store, uploads, driver, mutex, outputsDir: path.join(dataDir, 'outputs'),
  log: (message, data) => logger.info(message, data),
});
const server = createDaemonServer({
  token, store, uploads, runner, mutex, driver, expectedAccount: get('expectedAccount'),
  callTool: (name, args) => callTool(name, args, {
    runnerStatus: () => runner.status(), driver, outputsDir: path.join(dataDir, 'outputs'),
  }),
});
const port = get('daemonPort', 47821);

server.on('error', (err) => {
  logger.error('Flow daemon could not start', { port, error: err.message });
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => {
  logger.info('Flow daemon listening', { port, interrupted: interrupted.length });
  runner.kick();
});
