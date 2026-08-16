import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

/**
 * Persisted worker identity.
 *
 * The worker token is issued once at registration and never retrievable again,
 * so it has to survive a restart. It is written with mode 0600 — on the real
 * Linux VM that is the difference between "only the worker's service account
 * can read the credential" and "anyone with a shell can".
 */

const stateSchema = z.object({
  workerId: z.string().uuid(),
  workerToken: z.string().min(1),
  name: z.string(),
  controlPlaneUrl: z.string(),
  registeredAt: z.string(),
});

export type WorkerState = z.infer<typeof stateSchema>;

export async function readState(file: string): Promise<WorkerState | null> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = stateSchema.safeParse(JSON.parse(raw));
    // A corrupt or outdated state file is treated as absent rather than fatal:
    // the worker can always re-enroll, and refusing to start would need a
    // human on the VM at 3am.
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function writeState(file: string, state: WorkerState): Promise<void> {
  const resolved = path.resolve(file);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
  // mkdir/writeFile mode is affected by umask, so set it explicitly. chmod is a
  // no-op on Windows, which is why local development is not the security case.
  await fs.chmod(resolved, 0o600).catch(() => undefined);
}

export async function clearState(file: string): Promise<void> {
  await fs.rm(path.resolve(file), { force: true });
}
