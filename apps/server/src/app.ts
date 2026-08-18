import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { config } from './config.js';
import { sendError } from './http/errors.js';
import { authRoutes } from './http/routes/auth.js';
import { projectRoutes } from './http/routes/projects.js';
import { taskRoutes } from './http/routes/tasks.js';
import { runRoutes } from './http/routes/runs.js';
import { adminRoutes } from './http/routes/admin.js';
import { repositoryRoutes } from './http/routes/repositories.js';
import { discoveryRoutes } from './http/routes/discovery.js';
import { workerRoutes } from './http/routes/worker.js';
import { nightShiftRoutes } from './http/routes/night-shift.js';
import { companyContextRoutes } from './http/routes/company-context.js';
import { artefactRoutes } from './http/routes/artefacts.js';
import { startSweepers, type Sweepers } from './jobs/sweepers.js';

export interface BuildOptions {
  /** Sweepers are disabled in tests so they can be driven deterministically. */
  startBackgroundJobs?: boolean;
  /**
   * Login attempts allowed per IP per 5 minutes. Overridable so the test suite
   * can log in freely while one dedicated test still asserts that the limiter
   * genuinely returns 429 when it trips.
   */
  authRateLimitMax?: number;
  /** Worker registration attempts allowed per IP per 5 minutes. */
  registerRateLimitMax?: number;
}

export interface App {
  fastify: FastifyInstance;
  sweepers: Sweepers | null;
}

export async function buildApp(options: BuildOptions = {}): Promise<App> {
  const fastify = Fastify({
    logger: { level: config.logLevel },
    // A hard ceiling on request bodies: the worker is a semi-trusted client and
    // log batches are the largest thing it sends.
    bodyLimit: config.bodyLimitBytes,
    trustProxy: true,
    // The long-poll lease holds a connection for up to 25s; the default
    // request timeout would abort it.
    requestTimeout: 60_000,
  });

  await fastify.register(helmet, {
    // The API serves JSON only; the UI is served separately by Vite in
    // development and by a static host later, so no CSP is needed here.
    contentSecurityPolicy: false,
  });

  await fastify.register(cors, {
    origin: config.webOrigin,
    credentials: true,
  });

  await fastify.register(cookie);

  await fastify.register(rateLimit, {
    global: false, // opted into per-route; see auth and worker registration
    max: 100,
    timeWindow: '1 minute',
  });

  // One place where errors become HTTP responses.
  fastify.setErrorHandler((err, request, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) request.log.error({ err }, 'unhandled error');
    return sendError(reply, err);
  });

  fastify.setNotFoundHandler((_request, reply) =>
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'No such endpoint.' } }),
  );

  fastify.get('/api/health', async () => ({ ok: true, service: 'mac-bennett-control-plane' }));

  // Two authentication planes, registered as separate route groups with
  // non-overlapping prefixes and separate preHandler hooks. Nothing in the
  // human plane can be reached with a worker token, and vice versa.
  const limits = {
    authRateLimitMax: options.authRateLimitMax ?? 5,
    registerRateLimitMax: options.registerRateLimitMax ?? 10,
  };

  await fastify.register(authRoutes, limits);
  await fastify.register(projectRoutes);
  await fastify.register(taskRoutes);
  await fastify.register(runRoutes);
  await fastify.register(adminRoutes);
  await fastify.register(repositoryRoutes);
  await fastify.register(discoveryRoutes);
  await fastify.register(nightShiftRoutes);
  await fastify.register(companyContextRoutes);
  await fastify.register(artefactRoutes);
  await fastify.register(workerRoutes, limits);

  const sweepers = options.startBackgroundJobs === false ? null : startSweepers(fastify.log);

  fastify.addHook('onClose', async () => {
    sweepers?.stop();
  });

  return { fastify, sweepers };
}
