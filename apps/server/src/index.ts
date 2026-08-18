import { buildApp } from './app.js';
import { config } from './config.js';
import { closeDb } from './db/client.js';
import { getSettings } from './services/settings.js';
import { refreshCompanyContext } from './services/company-context/service.js';

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

  /*
   * Sprint 3.2 section 9.1: load PAC company context at startup.
   *
   * Deliberately NOT fatal. A control plane that refuses to boot because GitHub
   * is unreachable is a control plane an operator cannot use to SEE that GitHub
   * is unreachable. The failure is recorded, audited and surfaced on the status
   * endpoint; context-dependent work then fails individually and loudly, which
   * is the honest division of labour between "Mac is up" and "Mac can safely
   * start work".
   */
  try {
    const result = await refreshCompanyContext({ reason: 'startup' });
    if (result.revision) {
      fastify.log.info(
        `PAC company context ${result.revision.commitSha.slice(0, 7)} ` +
          `(version ${result.revision.contextVersion}) loaded; status ${result.status}.`,
      );
    } else if (result.status !== 'disabled') {
      fastify.log.error(
        `PAC company context is ${result.status}: ${result.error ?? 'no valid revision'}. ` +
          'Work that requires company context will be refused until this is resolved.',
      );
    }
  } catch (err) {
    fastify.log.error(`Company context startup refresh failed: ${(err as Error).message}`);
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
