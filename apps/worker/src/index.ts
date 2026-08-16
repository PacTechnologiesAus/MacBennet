import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { startWorker } from './worker.js';

/**
 * Worker entrypoint.
 *
 * Intended to run as a systemd service on Mac's dedicated Linux VM. It needs
 * no inbound network access — every exchange with the control plane is
 * outbound — so the VM's firewall can be egress-only.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel, config.name);

  logger.info(`Mac Bennett worker starting. Control plane: ${config.controlPlaneUrl}`);

  const worker = await startWorker({ config, logger });

  const shutdown = (signal: string) => {
    logger.info(`${signal} received. Finishing current work and stopping.`);
    void worker.stop().then(() => process.exit(0));
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: Error) => {
  console.error(`Worker failed to start: ${err.message}`);
  process.exit(1);
});
