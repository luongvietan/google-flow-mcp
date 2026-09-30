import { DaemonError, JobErrorCodes } from '../daemon/errors.js';
import { WIRE_MODELS } from '../daemon/models.js';

export const FLOW_HOME = 'https://flow.google.com/';

// Material icon ligatures are the same in every UI language.
export const ICONS = Object.freeze({
  add: 'add', upload: 'upload', settings: 'tune', send: 'arrow_forward', back: 'arrow_back', dropdown: 'arrow_drop_down',
});

export const RATIO_ICONS = Object.freeze({
  '16:9': 'crop_16_9', '4:3': 'crop_landscape', '1:1': 'crop_square', '3:4': 'crop_portrait', '9:16': 'crop_9_16',
});

// Text-labelled controls, per UI language seen so far.
export const LABELS = Object.freeze({
  save: ['Lưu', 'Save', 'Salva', 'Enregistrer'],
  addToPrompt: ['Thêm vào câu lệnh', 'Add to prompt'],
});

const PROJECT_URL = /^https:\/\/flow\.google\.com\/project\/[0-9a-f-]{36}/u;
const MEDIA_URL = /^https:\/\/flow-content\.google\/(image|video)\/([0-9a-f-]{36})\?\S*Signature=/u;

export function isProjectUrl(url) {
  return PROJECT_URL.test(url ?? '');
}

export function parseAccountLabel(label) {
  const match = /\(([^()\s]+@[^()\s]+)\)/u.exec(label ?? '');
  return match ? match[1] : null;
}

export function extractMedia(urls) {
  const seen = new Map();
  for (const url of urls) {
    const match = MEDIA_URL.exec(url ?? '');
    if (match && !seen.has(match[2])) seen.set(match[2], { kind: match[1], uuid: match[2], url });
  }
  return [...seen.values()];
}

export function orderIngredients(job) {
  const { firstFrame, lastFrame, ingredients = [], references = [] } = job.inputs;
  return [
    ...(firstFrame ? [{ role: 'firstFrame', file: firstFrame }] : []),
    ...(lastFrame ? [{ role: 'lastFrame', file: lastFrame }] : []),
    ...ingredients.map((file) => ({ role: 'ingredient', file })),
    ...references.map((file) => ({ role: 'reference', file })),
  ];
}

const ROLE_TEXT = {
  firstFrame: (n) => `Use attached image ${n} as the exact first frame of the video.`,
  lastFrame: (n) => `Use attached image ${n} as the exact last frame of the video.`,
  ingredient: (n) => `Use attached image ${n} as a visual ingredient (subject, character or object) that must appear in the video.`,
  reference: (n) => `Use attached image ${n} as a visual reference.`,
};

// One line only: the prompt box submits on Enter.
export function buildPrompt(job, ingredients) {
  const parts = [job.kind === 'video'
    ? `Generate exactly one ${job.duration}-second video now.`
    : 'Generate exactly one image now.'];
  parts.push('Do not ask questions and do not offer alternatives.');
  ingredients.forEach((item, index) => parts.push(ROLE_TEXT[item.role](index + 1)));
  parts.push('Follow the description exactly: include every element it mentions and add nothing it does not ask for.');
  parts.push(`Description: ${job.prompt}`);
  return parts.join(' ');
}

const LEGACY_VIDEO = { lite: 'veo-3.1-lite', test: 'veo-3.1-lite', fast: 'veo-3.1-fast', speed: 'veo-3.1-fast',
  quality: 'veo-3.1-quality', premium: 'veo-3.1-quality', flash: 'omni-flash', simple: 'omni-flash' };

export function legacyModel(kind, name) {
  if (name === undefined || name === 'auto') return kind === 'image' ? 'nano-banana-2' : 'veo-3.1-fast';
  const wire = (kind === 'video' ? LEGACY_VIDEO[name] : undefined)
    ?? (WIRE_MODELS[name] ? name : undefined)
    ?? Object.keys(WIRE_MODELS).find((id) => WIRE_MODELS[id].flowName === name);
  if (!wire || WIRE_MODELS[wire].kind !== kind) {
    const known = Object.entries(WIRE_MODELS).filter(([, m]) => m.kind === kind).map(([, m]) => m.flowName);
    throw new DaemonError(JobErrorCodes.INVALID_REQUEST, `Model "${name}" is not a Flow ${kind} model; use ${known.join(', ')}`);
  }
  return wire;
}

export function parseDuration(value) {
  if (value === undefined) return 8;
  const seconds = typeof value === 'number' ? value : Number(/^(\d+)s?$/u.exec(String(value))?.[1]);
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new DaemonError(JobErrorCodes.INVALID_REQUEST, `duration "${value}" must look like "8s"`);
  }
  return seconds;
}
