import type { FastifyInstance } from 'fastify';
import { loginRequestSchema } from '@mac/protocol';
import { login, logout } from '../../services/auth.js';
import { clearSessionCookie, currentUser, requireAuth, setSessionCookie } from '../auth-plugin.js';

export async function authRoutes(
  app: FastifyInstance,
  opts: { authRateLimitMax?: number } = {},
): Promise<void> {
  app.post('/api/auth/login', {
    config: {
      // Brute-force protection. Login is the only unauthenticated write in the
      // human plane, so it is the only place this is worth the complexity.
      rateLimit: { max: opts.authRateLimitMax ?? 5, timeWindow: '5 minutes' },
    },
    handler: async (request, reply) => {
      const body = loginRequestSchema.parse(request.body);
      const result = await login({
        email: body.email,
        password: body.password,
        userAgent: request.headers['user-agent'],
        ip: request.ip,
      });
      setSessionCookie(reply, result.token, result.expiresAt);
      return reply.send({ user: result.user });
    },
  });

  app.post('/api/auth/logout', { preHandler: requireAuth }, async (request, reply) => {
    await logout(currentUser(request));
    clearSessionCookie(reply);
    return reply.send({ ok: true });
  });

  app.get('/api/auth/me', { preHandler: requireAuth }, async (request, reply) => {
    const user = currentUser(request);
    return reply.send({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  });
}
