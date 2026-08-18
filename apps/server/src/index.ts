import { buildApp } from './app.js';
import { config } from './config.js';
import { closeDb } from './db/client.js';
import { getSettings } from './services/settings.js';

/**
 * Control-plane entrypoint.
 *
 * Fails fast on a database or migration problem rather than starting and
 * serving 500s: an operator would rather be told the schema is missing than
 * discover it when approving a run.
 */
async function main(): Promise<void> {
  const { fastify } = await buildApp();

  try {
    await getSettings();
  } catch (err) {
    fastify.log.error(
      `Could not read settings from the database: ${(err as Error).message}\n` +
        'Have you run `npm run db:up && npm run migrate`?',
    );
    process.exit(1);
  }

  await fastify.listen({ port: config.port, host: config.host });
  fastify.log.info(`Mac Bennett control plane listening on http://${config.host}:${config.port}`);

  const shutdown = async (signal: string) => {
    fastify.log.info(`${signal} received, shutting down`);
    try {
      await fastify.close();
      await closeDb();
      process.exit(0);
    } catch (err) {
      fastify.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: Error) => {
  console.error(err);
  process.exit(1);
});
