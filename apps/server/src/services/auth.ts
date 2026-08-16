import { and, eq, gt, isNull } from 'drizzle-orm';
import type { CurrentUser, UserRole } from '@mac/protocol';
import { ROLE_RANK } from '@mac/protocol';
import { db } from '../db/client.js';
import { sessions, users } from '../db/schema.js';
import { generateToken, hashPassword, hashToken, verifyPassword } from '../lib/crypto.js';
import { AppError } from '../http/errors.js';
import { config } from '../config.js';
import { record, type Actor } from './audit.js';

/**
 * Human authentication.
 *
 * Sessions are opaque random tokens stored server-side as SHA-256 hashes. This
 * is a deliberate rejection of JWTs: for a system that will eventually direct
 * autonomous agents, the ability to revoke a credential *now* matters more than
 * avoiding a database lookup per request.
 */

export interface SessionUser extends CurrentUser {
  sessionId: string;
}

export const toActor = (user: CurrentUser): Actor => ({
  type: 'user',
  id: user.id,
  label: `${user.name} <${user.email}>`,
});

export async function createUser(params: {
  email: string;
  name: string;
  password: string;
  role: UserRole;
}): Promise<CurrentUser> {
  const { hash, salt } = await hashPassword(params.password);
  const [row] = await db
    .insert(users)
    .values({
      email: params.email.toLowerCase().trim(),
      name: params.name,
      role: params.role,
      passwordHash: hash,
      passwordSalt: salt,
    })
    .returning();
  if (!row) throw new AppError(500, 'USER_CREATE_FAILED', 'Could not create user.');
  return { id: row.id, email: row.email, name: row.name, role: row.role as UserRole };
}

export interface LoginResult {
  user: CurrentUser;
  token: string;
  expiresAt: Date;
}

export async function login(params: {
  email: string;
  password: string;
  userAgent?: string;
  ip?: string;
}): Promise<LoginResult> {
  const email = params.email.toLowerCase().trim();
  const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);

  // Both the "no such user" and "wrong password" paths run a real scrypt
  // derivation, so response time does not disclose whether an account exists.
  const dummySalt = 'aa'.repeat(16);
  const passwordOk = row
    ? await verifyPassword(params.password, row.passwordHash, row.passwordSalt)
    : await verifyPassword(params.password, 'ff'.repeat(64), dummySalt).then(() => false);

  if (!row || !passwordOk || !row.isActive) {
    await db.transaction(async (tx) => {
      await record(tx, {
        actor: { type: 'system', id: null, label: `anonymous <${email}>` },
        eventType: 'auth.login_failed',
        metadata: {
          email,
          reason: !row ? 'unknown_user' : !passwordOk ? 'bad_password' : 'inactive_user',
          ip: params.ip ?? null,
        },
      });
    });
    throw AppError.unauthorized('Incorrect email or password.');
  }

  const token = generateToken('mac_se_');
  const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3600 * 1000);
  const user: CurrentUser = { id: row.id, email: row.email, name: row.name, role: row.role as UserRole };

  await db.transaction(async (tx) => {
    await tx.insert(sessions).values({
      userId: row.id,
      tokenHash: hashToken(token),
      expiresAt,
      userAgent: params.userAgent ?? null,
      ip: params.ip ?? null,
    });
    await record(tx, { actor: toActor(user), eventType: 'auth.login', metadata: { ip: params.ip ?? null } });
  });

  return { user, token, expiresAt };
}

export async function resolveSession(token: string): Promise<SessionUser | null> {
  const [row] = await db
    .select({
      sessionId: sessions.id,
      userId: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      isActive: users.isActive,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, hashToken(token)),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date()),
      ),
    )
    .limit(1);

  if (!row || !row.isActive) return null;

  // Best-effort activity tracking; a failure here must never fail the request.
  void db
    .update(sessions)
    .set({ lastSeenAt: new Date() })
    .where(eq(sessions.id, row.sessionId))
    .catch(() => undefined);

  return {
    sessionId: row.sessionId,
    id: row.userId,
    email: row.email,
    name: row.name,
    role: row.role as UserRole,
  };
}

export async function logout(user: SessionUser): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, user.sessionId));
    await record(tx, { actor: toActor(user), eventType: 'auth.logout' });
  });
}

export function hasRole(user: { role: UserRole }, required: UserRole): boolean {
  return ROLE_RANK[user.role] >= ROLE_RANK[required];
}

export function assertRole(user: { role: UserRole }, required: UserRole): void {
  if (!hasRole(user, required)) {
    throw AppError.forbidden(`This action requires the '${required}' role or higher.`);
  }
}
