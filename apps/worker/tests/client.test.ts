import { describe, expect, it, vi } from 'vitest';
import { ControlPlaneClient, ControlPlaneError } from '../src/client.js';
import { silentLogger } from '../src/logger.js';

/**
 * Network resilience is the property that decides whether an unattended worker
 * on a VM is trustworthy. These tests drive the client against a stub fetch so
 * failure modes that are hard to reproduce for real — a dropped connection
 * mid-report, a control plane restarting — are covered deterministically.
 */

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const control = {
  protocolVersion: 1,
  serverTime: new Date().toISOString(),
  heartbeatIntervalSeconds: 10,
  cancelRequested: false,
  cancelRunId: null,
  cancelReason: null,
};

const makeClient = (fetchImpl: typeof fetch) =>
  new ControlPlaneClient({
    baseUrl: 'https://control.example',
    token: 'mac_wk_test',
    logger: silentLogger,
    retryBaseMs: 1,
    retryMaxMs: 4,
    fetchImpl,
  });

describe('retry behaviour', () => {
  it('recovers from a transient network failure', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValue(jsonResponse(200, { control, workerStatus: 'idle' }));

    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const result = await client.heartbeat({ status: 'idle', currentRunId: null });

    expect(result.workerStatus).toBe('idle');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('retries a 5xx, because the control plane may simply be restarting', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { error: { code: 'UNAVAILABLE', message: 'restarting' } }))
      .mockResolvedValue(jsonResponse(200, { control, workerStatus: 'idle' }));

    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await client.heartbeat({ status: 'idle', currentRunId: null });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a 4xx, because a rejected request stays rejected', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(403, { error: { code: 'FORBIDDEN', message: 'not your run' } }));

    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await expect(client.progress('run-1', { stage: 'x' })).rejects.toBeInstanceOf(ControlPlaneError);
    // Hammering a permanent rejection would just burn the rate limiter and
    // hide the real problem from whoever is reading the worker's log.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a 429, because that one really is temporary', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: { code: 'RATE_LIMITED', message: 'slow down' } }))
      .mockResolvedValue(jsonResponse(200, { control, workerStatus: 'idle' }));

    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await client.heartbeat({ status: 'idle', currentRunId: null });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('gives up after the attempt budget and surfaces the failure', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network unreachable'));
    const client = new ControlPlaneClient({
      baseUrl: 'https://control.example',
      token: 'mac_wk_test',
      logger: silentLogger,
      retryBaseMs: 1,
      retryMaxMs: 2,
      maxAttempts: 3,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.heartbeat({ status: 'idle', currentRunId: null })).rejects.toThrow('network unreachable');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('tries a completion report far harder than a heartbeat', async () => {
    // A lost heartbeat is recoverable; a lost completion leaves a run stuck
    // "running" until a human intervenes.
    const fetchImpl = vi.fn().mockRejectedValue(new Error('down'));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.complete('run-1', { outcome: 'succeeded' })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(10);
  });

  it('does not retry a lease, because the next poll is the retry', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('timeout'));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.lease({ waitSeconds: 1, capabilities: ['noop'] })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('control envelope', () => {
  it('captures the envelope from any response, not just heartbeats', async () => {
    const cancelling = {
      ...control,
      cancelRequested: true,
      cancelRunId: '11111111-1111-4111-8111-111111111111',
      cancelReason: 'overnight_cutoff',
    };

    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { control: cancelling, accepted: 1, highestSeq: 0 }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    expect(client.lastControl).toBeNull();
    // A log upload is what carries the stop most of the time, because it
    // happens roughly every second.
    await client.sendLogs('run-1', [{ seq: 0, ts: new Date().toISOString(), stream: 'stdout', message: 'x' }]);

    expect(client.lastControl?.cancelRequested).toBe(true);
    expect(client.lastControl?.cancelReason).toBe('overnight_cutoff');
  });
});

describe('credentials', () => {
  it('sends the worker token as a bearer credential', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { control, workerStatus: 'idle' }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await client.heartbeat({ status: 'idle', currentRunId: null });

    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer mac_wk_test');
  });

  it('uses the enrollment token for registration and the worker token thereafter', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(201, { control, workerId: 'w1', workerToken: 'mac_wk_issued' }))
      .mockResolvedValue(jsonResponse(200, { control, workerStatus: 'idle' }));

    const client = new ControlPlaneClient({
      baseUrl: 'https://control.example',
      token: null,
      logger: silentLogger,
      retryBaseMs: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.register('mac_en_enrollment', {
      name: 'w',
      capabilities: ['noop'],
      version: '0.1.0',
      platform: 'linux',
      protocolVersion: 1,
    });
    client.setToken('mac_wk_issued');
    await client.heartbeat({ status: 'idle', currentRunId: null });

    const headers = (i: number) => (fetchImpl.mock.calls[i]![1] as RequestInit).headers as Record<string, string>;
    expect(headers(0).authorization).toBe('Bearer mac_en_enrollment');
    expect(headers(1).authorization).toBe('Bearer mac_wk_issued');
  });

  it('refuses to call the control plane with no credential at all', async () => {
    const fetchImpl = vi.fn();
    const client = new ControlPlaneClient({
      baseUrl: 'https://control.example',
      token: null,
      logger: silentLogger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.heartbeat({ status: 'idle', currentRunId: null })).rejects.toThrow(/No credential/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
