import type { FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { InvalidTransitionError } from '../domain/run-lifecycle.js';

/**
 * One typed error class, mapped to HTTP in exactly one place.
 *
 * Handlers throw; the error handler translates. That keeps status-code policy
 * out of the services layer, which matters because the same service methods are
 * called from tests and (later) from Mac's own reasoning loop, where HTTP is
 * irrelevant.
 */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static badRequest(code: string, message: string, details?: unknown) {
    return new AppError(400, code, message, details);
  }
  static unauthorized(message = 'Authentication required.') {
    return new AppError(401, 'UNAUTHENTICATED', message);
  }
  static forbidden(message = 'You do not have permission to do that.') {
    return new AppError(403, 'FORBIDDEN', message);
  }
  static notFound(what = 'Resource') {
    return new AppError(404, 'NOT_FOUND', `${what} not found.`);
  }
  static conflict(code: string, message: string, details?: unknown) {
    return new AppError(409, code, message, details);
  }
  static tooManyRequests(message = 'Too many requests.') {
    return new AppError(429, 'RATE_LIMITED', message);
  }
}

/** Thrown when a request is blocked by a backend guardrail (spec Step 7). */
export class GuardrailError extends AppError {
  constructor(code: string, message: string, details?: unknown) {
    super(409, code, message, details);
    this.name = 'GuardrailError';
  }
}

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export function toErrorResponse(err: unknown): { status: number; body: ErrorBody } {
  if (err instanceof AppError) {
    return {
      status: err.statusCode,
      body: { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } },
    };
  }

  if (err instanceof InvalidTransitionError) {
    return {
      status: 409,
      body: { error: { code: err.code, message: err.message, details: { from: err.from, to: err.to } } },
    };
  }

  if (err instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Request validation failed.',
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      },
    };
  }

  // Unique-constraint violations are the one Postgres error worth translating,
  // because they are a normal outcome of concurrent creates rather than a bug.
  const pgCode = (err as { code?: string } | null)?.code;
  if (pgCode === '23505') {
    return { status: 409, body: { error: { code: 'ALREADY_EXISTS', message: 'That already exists.' } } };
  }

  /*
   * Fastify and its plugins raise errors that already carry a correct status
   * and code — rate limiting (429), body-limit overruns (413), malformed JSON
   * (400). Without this branch every one of them would be reported as an
   * opaque 500, which is how a working rate limiter first looked like a server
   * crash during development.
   */
  const fastifyError = err as { statusCode?: number; code?: string; message?: string } | null;
  if (fastifyError?.statusCode && fastifyError.statusCode >= 400 && fastifyError.statusCode < 500) {
    return {
      status: fastifyError.statusCode,
      body: {
        error: {
          code: fastifyError.code ?? 'REQUEST_REJECTED',
          message: fastifyError.message ?? 'Request rejected.',
        },
      },
    };
  }

  return {
    status: 500,
    body: { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } },
  };
}

export function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  const { status, body } = toErrorResponse(err);
  return reply.status(status).send(body);
}
