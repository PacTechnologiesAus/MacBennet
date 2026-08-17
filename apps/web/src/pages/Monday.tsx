import { useCallback, useEffect, useState } from 'react';
import type { CurrentUser, MondayBoardDto, MondayItemDto, ProjectDto } from '@mac/protocol';
import { DEFAULT_MONDAY_STATUS_LABELS } from '@mac/protocol';
import { api, ApiError } from '../api.js';
import { Alert, Badge, Empty, Field, Time } from '../components/ui.js';

/**
 * monday.com mapping and eligibility (Sprint 3 §14).
 *
 * Two separate acts, presented as two separate acts: MAPPING a board is
 * technical — which column is status? — and APPROVING it decides whether a
 * machine may take work from it. A single form with an "enabled" checkbox would
 * make configuring the integration the same gesture as authorising it, which is
 * exactly the conflation the approval model exists to prevent.
 */
export function Monday({ user }: { user: CurrentUser }) {
  const [boards, setBoards] = useState<MondayBoardDto[]>([]);
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [items, setItems] = useState<MondayItemDto[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const isAdmin = user.role === 'admin';

  const load = useCallback(async () => {
    try {
      const [boardResponse, projectResponse, itemResponse] = await Promise.all([
        api.listMondayBoards(),
        api.listProjects(),
        api.listMondayItems(),
      ]);
      setBoards(boardResponse.boards);
      setProjects(projectResponse.projects);
      setItems(itemResponse.items);
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>, message: string) => {
    try {
      await fn();
      await load();
      setNotice(message);
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1>monday.com</h1>
          <p className="dim">
            The visible source of truth for work in progress. Mac reads only from boards mapped here, so he cannot
            roam every board the connected account can see.
          </p>
        </div>
      </div>

      <Alert kind="error">{error}</Alert>
      <Alert kind="ok">{notice}</Alert>

      {isAdmin && <MapBoardForm projects={projects} onCreated={() => void act(async () => undefined, 'Board mapped. It is not approved yet.')} />}

      {boards.length === 0 ? (
        <div className="card">
          <Empty>No boards are mapped. {isAdmin ? 'Map one above.' : 'Ask an administrator to map one.'}</Empty>
        </div>
      ) : (
        boards.map((board) => (
          <BoardCard
            key={board.id}
            board={board}
            items={items.filter((i) => i.boardRowId === board.id)}
            project={projects.find((p) => p.id === board.projectId)}
            isAdmin={isAdmin}
            canOperate={user.role !== 'viewer'}
            onAct={act}
          />
        ))
      )}
    </>
  );
}

function BoardCard({
  board,
  items,
  project,
  isAdmin,
  canOperate,
  onAct,
}: {
  board: MondayBoardDto;
  items: MondayItemDto[];
  project: ProjectDto | undefined;
  isAdmin: boolean;
  canOperate: boolean;
  onAct: (fn: () => Promise<unknown>, message: string) => Promise<void>;
}) {
  const projectApproved = Boolean(project?.nightShiftApproved);

  return (
    <div className="card">
      <div className="row-between">
        <h2>
          {board.name} <span className="dim">· {board.projectName}</span>
        </h2>
        <div className="actions">
          <Badge tone={board.isApproved ? 'ok' : 'idle'}>{board.isApproved ? 'approved' : 'not approved'}</Badge>
          <Badge tone={board.nightShiftEligible ? 'ok' : 'idle'}>
            {board.nightShiftEligible ? 'night-shift eligible' : 'day only'}
          </Badge>
          {board.mayComplete ? <Badge tone="warn">may mark Done</Badge> : <Badge tone="idle">Ready for Review is terminal</Badge>}
        </div>
      </div>

      <div className="stat-row">
        <Stat label="Board id" value={board.boardId} />
        <Stat label="Items cached" value={String(board.itemCount)} />
        <Stat label="Last synced" value={<Time value={board.lastSyncedAt} />} />
        <Stat label="Mac's identity" value={board.macUserId ?? <span className="dim">not set</span>} />
      </div>

      {/*
        Both gates, shown together. An approved board inside a project nobody
        approved for night shift yields no work, and the commonest configuration
        mistake is having exactly one of the two.
      */}
      {(!board.isApproved || !board.nightShiftEligible || !projectApproved) && (
        <p className="hint">
          Mac will not take autonomous work from this board until: the board is approved
          {board.isApproved ? ' ✓' : ' ✗'}, it is marked night-shift eligible{board.nightShiftEligible ? ' ✓' : ' ✗'},
          and the project is approved for night shift{projectApproved ? ' ✓' : ' ✗'}.
        </p>
      )}

      <details>
        <summary>Column mapping</summary>
        <table className="compact">
          <tbody>
            <Row label="Status" value={board.statusColumnId} note="Mac may write here." />
            <Row label="Assignee" value={board.assigneeColumnId} note="Mac may write here." />
            <Row label="Pull request" value={board.pullRequestColumnId} note="Mac may write here." />
            <Row label="Priority" value={board.priorityColumnId} note="Read only — Mac has no method that sets it." />
            <Row label="Due date" value={board.dueDateColumnId} note="Read only — recorded so a write to it can be refused by name." />
            <Row label="Dependency" value={board.dependencyColumnId} note="Read only." />
            <Row label="Night-shift flag" value={board.nightShiftFlagColumnId} note="Read only." />
            <Row label="Item type" value={board.itemTypeColumnId} note="Read only." />
            <Row label="Size" value={board.sizeColumnId} note="Read only — feeds the effort estimate." />
          </tbody>
        </table>
        <p className="hint">
          Startable statuses: {board.startableStatuses.join(', ') || 'none'} · Completed statuses:{' '}
          {board.completedStatuses.join(', ') || 'none'} · Item flag{' '}
          {board.requireItemFlag ? 'required' : 'not required'}
        </p>
      </details>

      <div className="actions">
        {isAdmin && (
          <>
            <button onClick={() => void onAct(() => api.approveMondayBoard(board.id, !board.isApproved), board.isApproved ? 'Approval revoked.' : 'Board approved.')}>
              {board.isApproved ? 'Revoke approval' : 'Approve board'}
            </button>
            <button
              className="small"
              onClick={() =>
                void onAct(
                  () => api.updateMondayBoard(board.id, { nightShiftEligible: !board.nightShiftEligible }),
                  'Updated.',
                )
              }
            >
              {board.nightShiftEligible ? 'Remove night-shift eligibility' : 'Mark night-shift eligible'}
            </button>
            <button
              className="small"
              onClick={() => void onAct(() => api.updateMondayBoard(board.id, { requireItemFlag: !board.requireItemFlag }), 'Updated.')}
            >
              {board.requireItemFlag ? 'Stop requiring the item flag' : 'Require an item flag'}
            </button>
            <button
              className="small"
              onClick={() => void onAct(() => api.updateMondayBoard(board.id, { mayComplete: !board.mayComplete }), 'Updated.')}
            >
              {board.mayComplete ? 'Stop letting Mac mark Done' : 'Let Mac mark Done'}
            </button>
            <button
              className="small"
              onClick={() =>
                void onAct(
                  () => api.approveProjectNightShift(board.projectId, !projectApproved),
                  projectApproved ? 'Project night-shift approval revoked.' : 'Project approved for night shift.',
                )
              }
            >
              {projectApproved ? 'Revoke project night-shift approval' : 'Approve project for night shift'}
            </button>
          </>
        )}
        {canOperate && (
          <button className="small" onClick={() => void onAct(() => api.syncMondayBoard(board.id), 'Synced.')}>
            Sync now
          </button>
        )}
      </div>

      {items.length > 0 && (
        <details>
          <summary>{items.length} cached item(s)</summary>
          <table className="compact">
            <thead>
              <tr>
                <th>Item</th>
                <th>Status</th>
                <th>Priority</th>
                <th>Flagged</th>
                <th>Task</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    {item.url ? (
                      <a href={item.url} target="_blank" rel="noreferrer">
                        {item.name}
                      </a>
                    ) : (
                      item.name
                    )}
                  </td>
                  <td>{item.status ?? '—'}</td>
                  <td>{item.priority ?? '—'}</td>
                  <td>{item.nightShiftFlag ? <Badge tone="ok">yes</Badge> : <span className="dim">no</span>}</td>
                  <td>{item.taskId ? <Badge tone="ok">linked</Badge> : <span className="dim">no brief yet</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">
            An item with no linked task has no handoff brief, so Mac has no understanding confidence for it and will
            not start it. Run discovery on it during the day and record the item id on the task.
          </p>
        </details>
      )}
    </div>
  );
}

function MapBoardForm({ projects, onCreated }: { projects: ProjectDto[]; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    projectId: '',
    boardId: '',
    name: '',
    statusColumnId: 'status',
    assigneeColumnId: 'person',
    priorityColumnId: 'priority',
    dueDateColumnId: 'date',
    pullRequestColumnId: '',
    nightShiftFlagColumnId: '',
    startableStatuses: 'Ready for Mac',
    completedStatuses: 'Done',
    macUserId: '',
  });

  const submit = async () => {
    try {
      await api.createMondayBoard({
        projectId: form.projectId,
        boardId: form.boardId.trim(),
        name: form.name.trim(),
        groupIds: [],
        statusColumnId: form.statusColumnId.trim(),
        assigneeColumnId: form.assigneeColumnId.trim() || null,
        priorityColumnId: form.priorityColumnId.trim() || null,
        dueDateColumnId: form.dueDateColumnId.trim() || null,
        pullRequestColumnId: form.pullRequestColumnId.trim() || null,
        dependencyColumnId: null,
        nightShiftFlagColumnId: form.nightShiftFlagColumnId.trim() || null,
        itemTypeColumnId: null,
        sizeColumnId: null,
        statusLabels: DEFAULT_MONDAY_STATUS_LABELS,
        startableStatuses: form.startableStatuses.split(',').map((s) => s.trim()).filter(Boolean),
        completedStatuses: form.completedStatuses.split(',').map((s) => s.trim()).filter(Boolean),
        allowedItemTypes: [],
        mayComplete: false,
        nightShiftEligible: false,
        requireItemFlag: true,
        macUserId: form.macUserId.trim() || null,
      });
      setOpen(false);
      setError('');
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  if (!open) {
    return (
      <div className="card">
        <button onClick={() => setOpen(true)}>Map a board</button>
      </div>
    );
  }

  return (
    <div className="card">
      <h2>Map a monday.com board</h2>
      <Alert kind="error">{error}</Alert>
      <Field label="Project">
        <select value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })}>
          <option value="">Select…</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Board id" hint="The numeric id in the board's URL.">
        <input value={form.boardId} onChange={(e) => setForm({ ...form, boardId: e.target.value })} />
      </Field>
      <Field label="Board name">
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      <Field label="Status column id" hint="Mac writes here.">
        <input value={form.statusColumnId} onChange={(e) => setForm({ ...form, statusColumnId: e.target.value })} />
      </Field>
      <Field label="Assignee column id" hint="Mac assigns work to himself here.">
        <input value={form.assigneeColumnId} onChange={(e) => setForm({ ...form, assigneeColumnId: e.target.value })} />
      </Field>
      <Field label="Priority column id" hint="Read only. Mac has no method that writes it.">
        <input value={form.priorityColumnId} onChange={(e) => setForm({ ...form, priorityColumnId: e.target.value })} />
      </Field>
      <Field
        label="Due-date column id"
        hint="Read only. Recorded so that a write aimed at it is refused by name rather than merely missing from the allowlist."
      >
        <input value={form.dueDateColumnId} onChange={(e) => setForm({ ...form, dueDateColumnId: e.target.value })} />
      </Field>
      <Field label="Pull-request column id" hint="Optional. Mac attaches the PR link here when present.">
        <input
          value={form.pullRequestColumnId}
          onChange={(e) => setForm({ ...form, pullRequestColumnId: e.target.value })}
        />
      </Field>
      <Field label="Night-shift flag column id" hint="Optional. The per-item marker that says Mac may take it.">
        <input
          value={form.nightShiftFlagColumnId}
          onChange={(e) => setForm({ ...form, nightShiftFlagColumnId: e.target.value })}
        />
      </Field>
      <Field label="Startable statuses" hint="Comma separated. Mac may only pick work up from these.">
        <input
          value={form.startableStatuses}
          onChange={(e) => setForm({ ...form, startableStatuses: e.target.value })}
        />
      </Field>
      <Field label="Completed statuses" hint="Comma separated. Used to decide whether a dependency is finished.">
        <input
          value={form.completedStatuses}
          onChange={(e) => setForm({ ...form, completedStatuses: e.target.value })}
        />
      </Field>
      <Field label="Mac's monday user id" hint="So he can assign work to himself.">
        <input value={form.macUserId} onChange={(e) => setForm({ ...form, macUserId: e.target.value })} />
      </Field>

      <p className="hint">
        A newly mapped board is <strong>not approved</strong> and not night-shift eligible. Both are separate,
        audited decisions.
      </p>

      <div className="actions">
        <button onClick={() => void submit()} disabled={!form.projectId || !form.boardId || !form.name}>
          Map board
        </button>
        <button className="small" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function Row({ label, value, note }: { label: string; value: string | null; note: string }) {
  return (
    <tr>
      <td style={{ width: 160 }}>{label}</td>
      <td style={{ width: 200 }}>{value ?? <span className="dim">not mapped</span>}</td>
      <td className="dim">{note}</td>
    </tr>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}
