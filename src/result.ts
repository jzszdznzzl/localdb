export type Result<T, E = string> = { data: T; error: null } | { data: null; error: E };

export function ok<T>(data: T): Result<T, never> {
  return { data, error: null };
}

export function err<E>(error: E): Result<never, E> {
  return { data: null, error };
}
