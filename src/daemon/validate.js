import { DaemonError, JobErrorCodes } from './errors.js';
import { ASPECT_RATIOS, WIRE_MODELS } from './models.js';

const RATIO = /^\d{1,2}:\d{1,2}$/u;
const KEY = /^[A-Za-z0-9._:-]{8,128}$/u;

function invalid(message) {
  return new DaemonError(JobErrorCodes.INVALID_REQUEST, message);
}

function idList(body, name) {
  const value = body[name];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw invalid(`${name} must be an array of upload ids`);
  }
  return [...value];
}

function oneId(body, name) {
  const value = body[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) throw invalid(`${name} must be an upload id`);
  return value;
}

export function validateJobRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw invalid('Body must be a JSON object');
  const { kind, model, prompt, aspectRatio } = body;
  if (kind !== 'image' && kind !== 'video') throw invalid('kind must be "image" or "video"');
  const entry = WIRE_MODELS[model];
  if (!entry) throw invalid(`Unknown model "${model}"; known: ${Object.keys(WIRE_MODELS).join(', ')}`);
  if (entry.kind !== kind) throw invalid(`Model ${model} is a ${entry.kind} model, not ${kind}`);
  if (typeof prompt !== 'string' || prompt.trim().length === 0) throw invalid('prompt is required');
  if (typeof aspectRatio !== 'string' || !RATIO.test(aspectRatio)) throw invalid('aspectRatio like "9:16" is required');
  if (!ASPECT_RATIOS[kind].includes(aspectRatio)) {
    throw invalid(`aspectRatio ${aspectRatio} is not available for ${kind}; use ${ASPECT_RATIOS[kind].join(', ')}`);
  }

  let duration;
  if (kind === 'video') {
    if (!Number.isInteger(body.duration) || body.duration <= 0) throw invalid('duration (whole seconds) is required for video');
    duration = body.duration;
  } else if (body.duration !== undefined) {
    throw invalid('duration applies only to video');
  }

  const references = idList(body, 'references');
  const ingredients = idList(body, 'ingredients');
  const firstFrame = oneId(body, 'firstFrame');
  const lastFrame = oneId(body, 'lastFrame');
  if (kind === 'image' && (ingredients.length > 0 || firstFrame !== undefined || lastFrame !== undefined)) {
    throw invalid('firstFrame, lastFrame and ingredients apply only to video');
  }
  if (kind === 'video' && references.length > 0) {
    throw invalid('references apply only to image; use firstFrame, lastFrame or ingredients for video');
  }

  if (typeof body.idempotencyKey !== 'string' || !KEY.test(body.idempotencyKey)) {
    throw invalid('idempotencyKey (8-128 characters of A-Z a-z 0-9 . _ : -) is required');
  }
  if (body.project !== undefined && (typeof body.project !== 'string' || body.project.trim().length === 0)) {
    throw invalid('project must be a non-empty string');
  }

  return {
    kind, model, prompt, aspectRatio, duration,
    references, firstFrame, lastFrame, ingredients,
    project: body.project,
    confirmCredits: body.confirmCredits === true,
    idempotencyKey: body.idempotencyKey,
  };
}
