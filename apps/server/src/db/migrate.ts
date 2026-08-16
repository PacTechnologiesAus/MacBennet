import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from '../config.js';

/**
 * Minimal forward-only migration runner.
 *
 * Each numbered .sql file in ./drizzle is applied once, inside a transaction,
 * and recorded in `_migrations`. There is no rollback: for a system whose whole
 * point is an audit trail, "undo the schema automatically" is a worse answer
 * than "write a corrective migration".
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '../../drizzle');

export async function runMigrations(databaseUrl = config.databaseUrl): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query<{ name: string }>('SELECT name FROM _migrations');
    const done = new Set(rows.map((r) => r.name));

    const files = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }

  return applied;
}

// Executed directly via `npm run migrate`.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const target = process.argv.includes('--test') ? process.env.TEST_DATABASE_URL : config.databaseUrl;
  if (!target) {
    console.error('No database URL resolved.');
    process.exit(1);
  }
  runMigrations(target)
    .then((applied) => {
      if (applied.length === 0) console.log('Database already up to date.');
      else console.log(`Applied ${applied.length} migration(s): ${applied.join(', ')}`);
      process.exit(0);
    })
    .catch((err: Error) => {
      console.error(err.message);
      process.exit(1);
    });
}
