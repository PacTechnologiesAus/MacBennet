import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { UserRole } from '@mac/protocol';
import { config } from '../config.js';
import { AppError } from './errors.js';
import { assertRole, resolveSession, toActor, type SessionUser } from '../services/auth.js';
import type { Actor } from '../services/audit.js';

/**
 * The human authentication plane.
 *
 * Registered only on the routes humans use. The worker plane is a separate
 * Fastify scope with its own hook, and the two prefixes do not overlap — so
 * "a session cookie cannot authenticate a worker call, and a worker token
 * cannot authenticate a human call" is structural rather than a convention
 * someone has to remember.
 */

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
    actor?: Actor;
  }
}

export function currentUser(request: FastifyRequest): SessionUser {
  if (!request.user) throw AppError.unauthorized();
  return request.user;
}

export function currentActor(request: FastifyRequest): Actor {
  return toActor(currentUser(request));
}

/** Attaches the session user if a valid cookie is present. Never rejects. */
export async function attachUser(request: FastifyRequest): Promise<void> {
  const token = request.cookies?.[config.sessionCookieName];
  if (!token) return;
  const user = await resolveSession(token);
  if (user) {
    request.user = user;
    request.actor = toActor(user);
  }
}

/** Rejects the request unless a session is present. */
export async function requireAuth(request: FastifyRequest): Promise<void> {
  await attachUser(request);
  if (!request.user) throw AppError.unauthorized();
}

/** Rejects unless the session holds at least `role`. */
export function requireRole(role: UserRole) {
  return async function roleGate(request: FastifyRequest): Promise<void> {
    await requireAuth(request);
    assertRole(currentUser(request), role);
  };
}

export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date): void {
  reply.setCookie(config.sessionCookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    // Secure is conditional purely so local http development works; every
    // non-development deployment sets NODE_ENV=production.
    secure: config.isProduction,
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(config.sessionCookieName, { path: '/' });
}

/**
 * Applies the human auth plane to a route scope. Every route registered inside
 * gets at least `viewer`; individual routes tighten it further.
 */
export function humanPlane(instance: FastifyInstance): void {
  instance.addHook('preHandler', requireAuth);
}
