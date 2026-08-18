import type { DbHandle } from '../../db/client.js';
import type { CompanyContextRevisionRow } from '../../db/schema.js';
import { record, type Actor } from '../audit.js';

/**
 * Recording that a piece of work was bound to a company context revision
 * (Sprint 3.2 §8.2, §20).
 *
 * One helper rather than four call sites writing the same event, because the
 * metadata shape is what makes the trail queryable — "which runs were governed
 * by commit abc1234" is a question somebody will ask after a policy change, and
 * it only has an answer if every binding event records the SHA the same way.
 *
 * A no-op when there is no revision: with company context switched off, nothing
 * is bound and nothing is claimed. An audit trail that recorded "bound to null"
 * would be noise pretending to be provenance.
 */
export async function recordContextBinding(
  tx: DbHandle,
  params: {
    actor: Actor;
    revision: CompanyContextRevisionRow | null;
    projectId?: string | null;
    taskId?: string | null;
    runId?: string | null;
    discoverySessionId?: string | null;
  },
): Promise<void> {
  if (!params.revision) return;

  await record(tx, {
    actor: params.actor,
    eventType: params.discoverySessionId ? 'company_context.bound_to_discovery' : 'company_context.bound_to_run',
    context: {
      projectId: params.projectId ?? null,
      taskId: params.taskId ?? null,
      runId: params.runId ?? null,
    },
    metadata: {
      revisionId: params.revision.id,
      commitSha: params.revision.commitSha,
      contextVersion: params.revision.contextVersion,
      ref: params.revision.ref,
      ...(params.discoverySessionId ? { discoverySessionId: params.discoverySessionId } : {}),
      // How this revision was obtained. A run grounded on cached policy is a
      // materially different claim from one grounded on freshly confirmed
      // policy, and the difference belongs in the record, not only in a status
      // page that shows the state right now rather than the state at the time.
      source: params.revision.source,
    },
  });
}
