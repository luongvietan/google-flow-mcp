export const JobErrorCodes = Object.freeze({
  INVALID_REQUEST: 'INVALID_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  NOT_FOUND: 'NOT_FOUND',
  DAEMON_UNAVAILABLE: 'DAEMON_UNAVAILABLE',
  BROWSER_UNAVAILABLE: 'BROWSER_UNAVAILABLE',
  NOT_LOGGED_IN: 'NOT_LOGGED_IN',
  ACCOUNT_MISMATCH: 'ACCOUNT_MISMATCH',
  CREDITS_NOT_CONFIRMED: 'CREDITS_NOT_CONFIRMED',
  UNSUPPORTED_INPUT: 'UNSUPPORTED_INPUT',
  FLOW_CLARIFICATION: 'FLOW_CLARIFICATION',
  CONTENT_REJECTED: 'CONTENT_REJECTED',
  INSUFFICIENT_CREDITS: 'INSUFFICIENT_CREDITS',
  UI_CHANGED: 'UI_CHANGED',
  RENDER_TIMEOUT: 'RENDER_TIMEOUT',
  DOWNLOAD_FAILED: 'DOWNLOAD_FAILED',
  INTERRUPTED: 'INTERRUPTED',
  INTERNAL: 'INTERNAL',
});

export class DaemonError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DaemonError';
    this.code = code;
    this.details = details;
  }
}

// Legacy handler codes (src/utils/errors.js) → public daemon codes.
const LEGACY = {
  WRONG_GOOGLE_ACCOUNT: JobErrorCodes.ACCOUNT_MISMATCH,
  NOT_LOGGED_IN: JobErrorCodes.NOT_LOGGED_IN,
  FLOW_PAGE_NOT_FOUND: JobErrorCodes.UI_CHANGED,
  UNKNOWN_UI_CHANGE: JobErrorCodes.UI_CHANGED,
  GENERATION_BUTTON_DISABLED: JobErrorCodes.UI_CHANGED,
  GENERATION_TIMEOUT: JobErrorCodes.RENDER_TIMEOUT,
  DOWNLOAD_FAILED: JobErrorCodes.DOWNLOAD_FAILED,
  GOOGLE_LIMIT_REACHED: JobErrorCodes.INSUFFICIENT_CREDITS,
  MANUAL_VERIFICATION_REQUIRED: JobErrorCodes.NOT_LOGGED_IN,
  BROWSER_NOT_CONNECTED: JobErrorCodes.BROWSER_UNAVAILABLE,
  PLAYWRIGHT_ERROR: JobErrorCodes.BROWSER_UNAVAILABLE,
  MODEL_NOT_AVAILABLE: JobErrorCodes.INVALID_REQUEST,
  RATIO_NOT_AVAILABLE: JobErrorCodes.INVALID_REQUEST,
  INVALID_PARAMS: JobErrorCodes.INVALID_REQUEST,
};

export function redact(message) {
  return String(message).replace(/https?:\/\/\S+/giu, '[redacted-url]');
}

export function toJobError(err) {
  const raw = err?.code;
  const code = Object.values(JobErrorCodes).includes(raw) ? raw : (LEGACY[raw] ?? JobErrorCodes.INTERNAL);
  const details = err?.details && typeof err.details === 'object' ? err.details : {};
  return { code, message: redact(err?.message ?? String(err)), details };
}
