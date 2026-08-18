import { eq } from 'drizzle-orm';
import { config } from '../src/config.js';
import { closeDb, db } from '../src/db/client.js';
import { users } from '../src/db/schema.js';
import { createUser } from '../src/services/auth.js';
import { getSettings } from '../src/services/settings.js';

/**
 * Creates the first administrator so the system is reachable.
 *
 * Idempotent: running it twice does not fail and does not reset a password.
 * The credentials come from .env and are printed with a warning, because a
 * seeded default password on a system that will control autonomous agents is
 * exactly the sort of thing that quietly survives to production.
 */
async function main(): Promise<void> {
  await getSettings(); // fails loudly if migrations have not been run

  const { email, password, name } = config.seedAdmin;
  if (!email || !password) {
    console.error('SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD must be set in .env before seeding.');
    process.exit(1);
  }

  const [existing] = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  if (existing) {
    console.log(`Administrator ${email} already exists — nothing to do.`);
    return;
  }

  await createUser({ email, name, password, role: 'admin' });

  console.log(`Created administrator: ${email}`);
  if (password === 'change-me-now' || password.length < 12) {
    console.log('');
    console.log('  ⚠  This account uses the example password from .env.example.');
    console.log('     Change SEED_ADMIN_PASSWORD and re-seed against a fresh database');
    console.log('     before this control plane is reachable by anyone else.');
    console.log('');
  }
}

main()
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch(async (err: Error) => {
    console.error(err.message);
    await closeDb().catch(() => undefined);
    process.exit(1);
  });
