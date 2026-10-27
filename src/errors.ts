import type { z } from 'zod';

export type DbFailure = {
  code: DbError;
  message: string;
  issues: readonly z.core.$ZodIssue[];
};

export const DbError = Object.freeze({
  NotFound: 'not_found',
  InvalidDocument: 'invalid_document',
  InvalidFile: 'invalid_file',
} as const);

export type DbError = (typeof DbError)[keyof typeof DbError];

export function failure(
  code: DbError,
  message: string,
  issues: readonly z.core.$ZodIssue[] = [],
): DbFailure {
  return { code, message, issues };
}
