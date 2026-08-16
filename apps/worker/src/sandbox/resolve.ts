import type { SandboxAttestation, SandboxKind } from '@mac/protocol';
import { BubblewrapSandbox } from './bubblewrap.js';
import { DockerSandbox } from './docker.js';
import type { ExecutionSandbox } from './index.js';

/**
 * Provider selection and attestation (Sprint 3 §3.4).
 *
 * Two properties this file exists to guarantee:
 *
 *  1. **There is no silent fallback to unconfined execution.** `auto` picks the
 *     best AVAILABLE provider; if none is available it reports that, and the
 *     coding job refuses the run. `none` is an explicit development setting
 *     that attests `available: false`, so the control plane can withhold coding
 *     work from that worker rather than trusting it not to accept any.
 *
 *  2. **Availability is measured, not configured.** A worker does not attest a
 *     sandbox because its `.env` says it has one; it attests because `probe()`
 *     ran and succeeded. The attestation is repeated on every heartbeat, so a
 *     sandbox that breaks at 02:00 stops coding work within one beat.
 */

export interface SandboxResolution {
  kind: SandboxKind;
  sandbox: ExecutionSandbox | null;
  available: boolean;
  version: string | null;
  detail: string | null;
}

export interface ResolveSandboxOptions {
  /** `auto` prefers bubblewrap, then docker. `none` disables containment. */
  provider: SandboxKind | 'auto';
  bubblewrapBinary?: string;
  dockerBinary?: string;
  image?: string;
}

export async function resolveSandbox(options: ResolveSandboxOptions): Promise<SandboxResolution> {
  if (options.provider === 'none') {
    return {
      kind: 'none',
      sandbox: null,
      available: false,
      version: null,
      detail:
        'Sandboxing is disabled (MAC_SANDBOX_PROVIDER=none). This worker attests no containment, ' +
        'so the control plane will withhold coding work from it while requireSandbox is on.',
    };
  }

  const candidates: ExecutionSandbox[] =
    options.provider === 'auto'
      ? [new BubblewrapSandbox(options.bubblewrapBinary), new DockerSandbox(options.dockerBinary, options.image)]
      : options.provider === 'bubblewrap'
        ? [new BubblewrapSandbox(options.bubblewrapBinary)]
        : [new DockerSandbox(options.dockerBinary, options.image)];

  const reasons: string[] = [];

  for (const candidate of candidates) {
    const probe = await candidate.probe();
    if (probe.available) {
      return {
        kind: candidate.kind,
        sandbox: candidate,
        available: true,
        version: probe.version ?? null,
        detail: null,
      };
    }
    reasons.push(`${candidate.kind}: ${probe.reason ?? 'unavailable'}`);
  }

  return {
    kind: candidates[0]?.kind ?? 'none',
    sandbox: null,
    available: false,
    version: null,
    detail: reasons.join(' | '),
  };
}

export function attestSandbox(resolution: SandboxResolution): SandboxAttestation {
  return {
    kind: resolution.kind,
    available: resolution.available,
    version: resolution.version,
    detail: resolution.detail,
  };
}
