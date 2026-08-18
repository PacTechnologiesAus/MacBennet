import type { FastifyRequest } from 'fastify';
import { WORKER_TOKEN_PREFIX } from '@mac/protocol';
import type { WorkerRow } from '../db/schema.js';
import { AppError } from './errors.js';
import { resolveWorkerToken } from '../services/workers.js';

/**
 * The worker authentication plane.
 *
 * Scoped exclusively to /api/worker/*. A worker token is meaningless anywhere
 * else, and a session cookie is meaningless here: this hook reads only the
 * Authorization header and never looks at cookies.
 *
 * Authorisation beyond authentication is enforced per-run in the run service
 * (`assertRunOwnedBy`) — an authenticated worker may still only touch runs
 * assigned to it.
 */

declare module 'fastify' {
  interface FastifyRequest {
    worker?: WorkerRow;
  }
}

export function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const [scheme, ...rest] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer') return null;
  const token = rest.join(' ').trim();
  return token || null;
}

export function currentWorker(request: FastifyRequest): WorkerRow {
  if (!request.worker) throw AppError.unauthorized('Worker authentication required.');
  return request.worker;
}

/** Authenticates an operating worker by its long-lived token. */
export async function requireWorkerAuth(request: FastifyRequest): Promise<void> {
  const token = bearerToken(request);
  if (!token) throw AppError.unauthorized('Worker authentication required.');

  // Cheap shape check before touching the database, so an enrollment token
  // presented on an operating endpoint is rejected on sight rather than being
  // hashed and looked up in the wrong table.
  if (!token.startsWith(WORKER_TOKEN_PREFIX)) {
    throw AppError.unauthorized('Invalid worker token.');
  }

  const worker = await resolveWorkerToken(token);
  if (!worker) throw AppError.unauthorized('Invalid worker token.');

  request.worker = worker;
}
