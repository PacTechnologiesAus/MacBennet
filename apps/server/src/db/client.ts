import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import { config } from '../config.js';

/**
 * `numeric` columns come back from node-postgres as strings by default, to
 * avoid silent precision loss. Confidence values are numeric(4,3) and are
 * always converted explicitly at the service boundary, so we leave that
 * default alone rather than installing a global parser that would also affect
 * money columns.
 */

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  // Tests create and destroy pools frequently; a small pool keeps Postgres
  // connection counts sane when several test files run in sequence.
  max: config.isTest ? 5 : 10,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  // A pooled client erroring while idle must not take down the process.
  console.error('[db] idle client error', err.message);
});

export const db = drizzle(pool, { schema });

export type Db = typeof db;

/** Any Drizzle handle — the pool-backed one or a transaction. */
export type DbHandle = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export async function closeDb(): Promise<void> {
  await pool.end();
}
