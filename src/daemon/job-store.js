import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const REUSABLE = new Set(['queued', 'running', 'succeeded']);

export class JobStore {
  constructor(file) {
    this.file = file;
    this.jobs = new Map();
    this.nextSeq = 1;
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const job of data.jobs) {
        this.jobs.set(job.id, job);
        this.nextSeq = Math.max(this.nextSeq, job.seq + 1);
      }
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version: 1, jobs: [...this.jobs.values()] }, null, 2));
    fs.renameSync(temp, this.file);
  }

  create(request, now = new Date()) {
    const job = {
      id: crypto.randomUUID(), seq: this.nextSeq++, state: 'queued', phase: 'queued', request,
      createdAt: now.toISOString(), startedAt: null, finishedAt: null, error: null, outputs: [], mediaUuids: [],
    };
    this.jobs.set(job.id, job);
    this.save();
    return job;
  }

  get(id) {
    return this.jobs.get(id);
  }

  update(id, patch) {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Unknown job ${id}`);
    Object.assign(job, patch);
    this.save();
    return job;
  }

  queued() {
    return [...this.jobs.values()].filter((job) => job.state === 'queued').sort((a, b) => a.seq - b.seq);
  }

  queuePosition(id) {
    const index = this.queued().findIndex((job) => job.id === id);
    return index < 0 ? null : index + 1;
  }

  findReusable(idempotencyKey) {
    for (const job of this.jobs.values()) {
      if (job.request.idempotencyKey === idempotencyKey && REUSABLE.has(job.state)) return job;
    }
    return undefined;
  }

  recoverInterrupted(now = new Date()) {
    const recovered = [];
    for (const job of this.jobs.values()) {
      if (job.state !== 'running') continue;
      Object.assign(job, {
        state: 'interrupted', phase: 'interrupted', finishedAt: now.toISOString(),
        error: { code: 'INTERRUPTED', details: {},
          message: 'The daemon restarted while this job was running. Flow credits may have been spent; the result may be in the Flow project.' },
      });
      recovered.push(job.id);
    }
    if (recovered.length > 0) this.save();
    return recovered;
  }
}
