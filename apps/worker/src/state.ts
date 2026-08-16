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
  /** When this credential was last replaced. Sprint 3; absent on older files. */
  rotatedAt: z.string().optional(),
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

/**
 * Writes the state file atomically.
 *
 * Sprint 3 made this matter: a credential rotation persists the new token
 * before adopting it, and a process killed part-way through a plain `writeFile`
 * would leave a truncated file — which `readState` treats as absent, which
 * means re-enrollment, which means a human on the VM. Write-then-rename makes
 * the file either wholly old or wholly new.
 */
export async function writeState(file: string, state: WorkerState): Promise<void> {
  const resolved = path.resolve(file);
  const temporary = `${resolved}.tmp`;
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(temporary, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
  // mkdir/writeFile mode is affected by umask, so set it explicitly. chmod is a
  // no-op on Windows, which is why local development is not the security case.
  await fs.chmod(temporary, 0o600).catch(() => undefined);
  await fs.rename(temporary, resolved);
  await fs.chmod(resolved, 0o600).catch(() => undefined);
}

export async function clearState(file: string): Promise<void> {
  await fs.rm(path.resolve(file), { force: true });
}
