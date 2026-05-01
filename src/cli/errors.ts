// Maps thrown errors and core ServiceResult error shapes to the CLI's stable
// stderr JSON contract: `{ "error": "<code>", "message": "<human>", ...details }`.
import { QuayError } from "../core/errors.ts";

export interface CliErrorPayload {
  error: string;
  message: string;
  [key: string]: unknown;
}

export function toCliError(err: unknown): CliErrorPayload {
  if (err instanceof QuayError) {
    return { error: err.code, message: err.message, ...(err.details ?? {}) };
  }
  if (err instanceof Error) {
    return { error: "internal_error", message: err.message };
  }
  return { error: "internal_error", message: String(err) };
}

export function serviceErrorToCli(error: {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}): CliErrorPayload {
  return { error: error.code, message: error.message, ...(error.details ?? {}) };
}
