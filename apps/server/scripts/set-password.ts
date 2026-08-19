import { eq } from 'drizzle-orm';
import { closeDb, db } from '../src/db/client.js';
import { users } from '../src/db/schema.js';
import { hashPassword } from '../src/lib/crypto.js';

/**
 * Sets an existing user's password.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * There is no way to change a password anywhere in the product. `createUser()`
 * is called from exactly one place — `seed.ts` — which is idempotent and
 * deliberately does not reset an existing password. There are no `/api/users`
 * routes and the only screen that mentions a password is the login form.
 *
 * That was survivable while the control plane sat on loopback. It is not
 * survivable now that it answers on the public internet, because it means a
 * leaked administrator credential cannot be rotated by any supported means.
 *
 * This script is the minimum that fixes the immediate problem. It is NOT a
 * substitute for the real thing, which is a change-password endpoint, a way to
 * create the other people who need accounts, and an `auth.password_changed`
 * audit event to go with them. Commissioning recorded that as a finding rather
 * than building it unasked.
 *
 * ---------------------------------------------------------------------------
 * THE PASSWORD IS READ FROM STDIN, NEVER FROM ARGV OR THE ENVIRONMENT
 *
 * An argument lands in `ps` output and in shell history; an environment
 * variable lands in `/proc/<pid>/environ` and in any crash dump. Standard input
 * lands in neither.
 *
 *   printf '%s' 'the new password' | npm run set-password -w @mac/server -- you@example.com
 *
 * Existing sessions are deliberately left alone. Ending them is the safer
 * default in general, but this script's first use is an operator rotating their
 * own password mid-session, and logging them out of the screen they are working
 * in is a poor way to repay that. Pass --end-sessions when rotating a
 * credential you believe has leaked, which is the case where it matters.
 * ---------------------------------------------------------------------------
 */

const MIN_LENGTH = 12;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const endSessions = args.includes('--end-sessions');
  const email = args.find((a) => !a.startsWith('--'))?.toLowerCase();

  if (!email) {
    console.error('Usage: printf %s <password> | npm run set-password -w @mac/server -- <email> [--end-sessions]');
    process.exit(1);
  }

  // Trailing newlines are what a pipe adds, not what the operator typed.
  const password = (await readStdin()).replace(/\r?\n$/, '');

  if (password.length < MIN_LENGTH) {
    console.error(`Refusing: the password must be at least ${MIN_LENGTH} characters (got ${password.length}).`);
    console.error('Nothing was changed.');
    process.exit(1);
  }

  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!existing) {
    console.error(`Refusing: no user with email ${email}. Nothing was changed.`);
    process.exit(1);
  }

  const { hash, salt } = await hashPassword(password);
  await db
    .update(users)
    .set({ passwordHash: hash, passwordSalt: salt, updatedAt: new Date() })
    .where(eq(users.id, existing.id));

  console.log(`Password updated for ${existing.email} (${existing.role}).`);

  if (endSessions) {
    const { sessions } = await import('../src/db/schema.js');
    await db.delete(sessions).where(eq(sessions.userId, existing.id));
    console.log('Existing sessions ended. Every device must sign in again.');
  } else {
    console.log('Existing sessions left active. Re-run with --end-sessions to force a re-login everywhere.');
  }

  console.log('');
  console.log('NOTE: this change is not recorded in the audit trail. There is no');
  console.log('      auth.password_changed event type, and inventing one here would');
  console.log('      mean a protocol change and a migration. Record it by hand.');
}

main()
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch(async (err: Error) => {
    console.error(err.message);
    await closeDb().catch(() => undefined);
    process.exit(1);
  });
