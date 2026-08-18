import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { asUser, closePool, createAndLogin, resetDatabase, startTestApp, TEST_PASSWORD } from '../helpers/harness.js';
import { queryAuditEvents } from '../../src/services/audit-query.js';

let app: FastifyInstance;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ fastify: app, close } = await startTestApp());
});

afterAll(async () => {
  await close();
  await closePool();
});

beforeEach(resetDatabase);

describe('authentication', () => {
  it('rejects every protected route without a session', async () => {
    for (const url of ['/api/projects', '/api/tasks', '/api/runs', '/api/workers', '/api/settings', '/api/audit']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(401);
      expect(response.json().error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('leaves the health endpoint open', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(true);
  });

  it('issues an HttpOnly session cookie on login', async () => {
    const session = await createAndLogin(app, { email: 'alice@pac.test', role: 'admin' });
    expect(session.cookie).toContain('mac_session=');

    const me = await asUser(app, session).get('/api/auth/me');
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe('alice@pac.test');
  });

  it('marks the session cookie HttpOnly so scripts cannot read it', async () => {
    await createAndLogin(app, { email: 'flags@pac.test', role: 'viewer' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'flags@pac.test', password: TEST_PASSWORD },
    });
    const raw = String(response.headers['set-cookie']);
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('SameSite=Lax');
  });

  it('rejects a wrong password without disclosing whether the account exists', async () => {
    await createAndLogin(app, { email: 'bob@pac.test', role: 'operator' });

    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'bob@pac.test', password: 'not-the-password' },
    });
    const noSuchUser = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'nobody@pac.test', password: 'not-the-password' },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(noSuchUser.statusCode).toBe(401);
    expect(wrongPassword.json().error.message).toBe(noSuchUser.json().error.message);
  });

  it('audits both successful and failed logins', async () => {
    await createAndLogin(app, { email: 'audited@pac.test', role: 'operator' });
    await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'audited@pac.test', password: 'wrong' },
    });

    const success = await queryAuditEvents({ eventType: 'auth.login', limit: 10, offset: 0 });
    const failure = await queryAuditEvents({ eventType: 'auth.login_failed', limit: 10, offset: 0 });

    expect(success.some((e) => e.actorLabel.includes('audited@pac.test'))).toBe(true);
    expect(failure.some((e) => (e.metadata as { email?: string }).email === 'audited@pac.test')).toBe(true);
  });

  it('revokes the session on logout', async () => {
    const session = await createAndLogin(app, { email: 'carol@pac.test', role: 'operator' });
    const api = asUser(app, session);

    expect((await api.get('/api/auth/me')).statusCode).toBe(200);
    expect((await api.post('/api/auth/logout')).statusCode).toBe(200);
    // Server-side revocation is the whole reason sessions are not JWTs.
    expect((await api.get('/api/auth/me')).statusCode).toBe(401);
  });

  it('ignores a forged session cookie', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: 'mac_session=mac_se_totally-made-up-token' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rate-limits repeated login attempts', async () => {
    // Built with a deliberately low limit: the shared suite app allows many
    // logins, so without this the limiter would ship untested.
    const limited = await startTestApp({ authRateLimitMax: 3 });
    try {
      await createAndLogin(limited.fastify, { email: 'target@pac.test', role: 'viewer' });

      const codes: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        const response = await limited.fastify.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { email: 'target@pac.test', password: 'guess' },
        });
        codes.push(response.statusCode);
      }

      expect(codes).toContain(429);
      // And a 429 must be reported as a 429, not smuggled out as a 500.
      expect(codes.every((c) => c === 401 || c === 429)).toBe(true);
    } finally {
      await limited.close();
    }
  });
});

describe('role enforcement', () => {
  it('lets a viewer read but not write', async () => {
    const viewer = await createAndLogin(app, { email: 'viewer@pac.test', role: 'viewer' });
    const api = asUser(app, viewer);

    expect((await api.get('/api/projects')).statusCode).toBe(200);

    const create = await api.post('/api/projects', { name: 'Should not be created' });
    expect(create.statusCode).toBe(403);
    expect(create.json().error.code).toBe('FORBIDDEN');
  });

  it('lets an operator manage work but not settings or worker credentials', async () => {
    const operator = await createAndLogin(app, { email: 'operator@pac.test', role: 'operator' });
    const api = asUser(app, operator);

    expect((await api.post('/api/projects', { name: 'Operator project' })).statusCode).toBe(201);

    // Settings govern the guardrails; enrollment tokens let a machine join the
    // control plane. Both are deliberately above an operator's authority.
    expect((await api.patch('/api/settings', { overnightCutoff: '09:00' })).statusCode).toBe(403);
    expect(
      (await api.post('/api/worker-enrollment-tokens', { label: 'nope', expiresInHours: 1 })).statusCode,
    ).toBe(403);
  });

  it('lets an admin do everything', async () => {
    const admin = await createAndLogin(app, { email: 'admin@pac.test', role: 'admin' });
    const api = asUser(app, admin);

    expect((await api.post('/api/projects', { name: 'Admin project' })).statusCode).toBe(201);
    expect((await api.patch('/api/settings', { overnightCutoff: '09:00' })).statusCode).toBe(200);
    expect(
      (await api.post('/api/worker-enrollment-tokens', { label: 'ok', expiresInHours: 1 })).statusCode,
    ).toBe(201);
  });
});
