/**
 * Typed errors. Never `throw new Error("string")` in this codebase.
 *
 * `expose` decides whether `message` may reach a response body. Default false:
 * an error is internal unless someone deliberately says otherwise.
 */

export abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;
  /** When false, `message` must never be sent to a client. */
  readonly expose: boolean = false;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * Configuration is missing or invalid. Not recoverable — the process must not
 * start. Never carries a configuration *value*, only key names and reasons.
 */
export class ConfigError extends AppError {
  readonly code = "CONFIG_INVALID";
  readonly httpStatus = 500;
  readonly keys: readonly string[];

  constructor(message: string, keys: readonly string[] = []) {
    super(message);
    this.keys = keys;
  }
}

/**
 * A database operation failed. Wraps the driver error as `cause` so it is
 * available server-side, while `expose` stays false — a Postgres error message
 * can carry table names, column values and the connection target.
 */
export class DatabaseError extends AppError {
  readonly code = "DATABASE_ERROR";
  readonly httpStatus = 500;

  constructor(operation: string, options?: { cause?: unknown }) {
    super(`database operation failed: ${operation}`, options);
  }
}

/** A migration could not be applied, or applied state is inconsistent. */
export class MigrationError extends AppError {
  readonly code = "MIGRATION_ERROR";
  readonly httpStatus = 500;
  readonly migration: string | undefined;

  constructor(message: string, migration?: string, options?: { cause?: unknown }) {
    super(message, options);
    this.migration = migration;
  }
}

/** A datastore or downstream service did not respond in time. */
export class DependencyUnavailableError extends AppError {
  readonly code = "DEPENDENCY_UNAVAILABLE";
  readonly httpStatus = 503;
  readonly dependency: string;

  constructor(dependency: string, options?: { cause?: unknown }) {
    super(`dependency unavailable: ${dependency}`, options);
    this.dependency = dependency;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/**
 * The only message safe to return to a client.
 * Internal errors collapse to a generic string — no stack, no path, no detail.
 */
export function clientMessage(error: unknown): string {
  return isAppError(error) && error.expose ? error.message : "Internal Server Error";
}

export function httpStatusFor(error: unknown): number {
  return isAppError(error) ? error.httpStatus : 500;
}

/**
 * The response an unhandled error becomes.
 *
 * Lives here rather than inline in the server so the security property — no stack
 * trace, no file path, no internal message — is directly testable.
 */
export function errorResponse(error: unknown): Response {
  return new Response(clientMessage(error), {
    status: httpStatusFor(error),
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
