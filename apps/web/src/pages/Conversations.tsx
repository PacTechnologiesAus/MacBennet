import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type {
  ConversationDto,
  ConversationMessageDto,
  ConversationSummaryDto,
  CurrentUser,
  ProjectDto,
} from '@mac/protocol';
import {
  CONVERSATION_CHANNEL_LABELS,
  MESSAGE_INTENT_LABELS,
  type ConversationChannel,
  type MessageIntent,
} from '@mac/protocol';
import { api, ApiError } from '../api.js';
import { Alert, Badge, Time } from '../components/ui.js';

/**
 * Conversations (Phase 4 Part C, Part J).
 *
 * ---------------------------------------------------------------------------
 * ONE THREAD, WHATEVER CHANNEL IT ARRIVED ON
 *
 * The channel is shown per message rather than per conversation, because that
 * is the fact this screen exists to make visible: a thread begun in Teams and
 * continued here is ONE conversation, and a reader has to be able to see which
 * half arrived where without being told.
 *
 * Posting from this page calls the same handler the Teams webhook calls. If
 * this page had its own routing, "Mac knows what you told him in Teams" would
 * depend on somebody implementing every behaviour twice.
 * ---------------------------------------------------------------------------
 */
export function Conversations({ user }: { user: CurrentUser }) {
  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [threads, projectList] = await Promise.all([api.listConversations(), api.listProjects()]);
      setConversations(threads.conversations);
      setProjects(projectList.projects);
      setSelected((current) => current ?? threads.conversations[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="page">
      <header className="page-header">
        <h1>Conversations</h1>
        <p className="muted">
          One persistent thread per piece of work, whichever channel it arrived on. Mac answers status from his own
          records and never from memory.
        </p>
      </header>

      {error && <Alert kind="error">{error}</Alert>}

      <div className="split">
        <aside className="split-list">
          <NewConversation projects={projects} onStarted={(id) => { void load(); setSelected(id); }} />
          {conversations.length === 0 && <p className="muted">No conversations yet.</p>}
          <ul className="thread-list">
            {conversations.map((thread) => (
              <li key={thread.id}>
                <button
                  type="button"
                  className={thread.id === selected ? 'thread-item selected' : 'thread-item'}
                  onClick={() => setSelected(thread.id)}
                >
                  <span className="thread-title">{thread.title || 'Untitled conversation'}</span>
                  <span className="thread-meta">
                    <Badge tone="idle">{CONVERSATION_CHANNEL_LABELS[thread.channel]}</Badge>
                    {thread.projectName && <span className="muted"> {thread.projectName}</span>}
                    {thread.lastMessageAt && (
                      <span className="muted">
                        {' '}
                        <Time value={thread.lastMessageAt} />
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <section className="split-detail">
          {selected ? <Thread id={selected} user={user} onChanged={load} /> : <p className="muted">Pick a conversation.</p>}
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function NewConversation({ projects, onStarted }: { projects: ProjectDto[]; onStarted: (id: string) => void }) {
  const [projectId, setProjectId] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!message.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.startConversation({
        channel: 'web',
        ...(projectId ? { projectId } : {}),
        message: message.trim(),
      });
      setMessage('');
      onStarted(result.conversation.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={submit}>
      <h3>Talk to Mac</h3>
      <label>
        Project (optional)
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">— let Mac work it out —</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Message
        <textarea
          rows={3}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="What did you do last night? · Tonight investigate… · What needs my approval?"
        />
      </label>
      {error && <Alert kind="error">{error}</Alert>}
      <button type="submit" disabled={busy || !message.trim()}>
        {busy ? 'Sending…' : 'Send'}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------

function Thread({ id, user, onChanged }: { id: string; user: CurrentUser; onChanged: () => void }) {
  const [conversation, setConversation] = useState<ConversationDto | null>(null);
  const [messages, setMessages] = useState<ConversationMessageDto[]>([]);
  const [summaries, setSummaries] = useState<ConversationSummaryDto[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.getConversation(id);
      setConversation(result.conversation);
      setMessages(result.messages);
      setSummaries(result.summaries);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.sendConversationMessage(id, { message: draft.trim() });
      setDraft('');
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!conversation) return <p className="muted">Loading…</p>;

  const canPost = user.role !== 'viewer';

  return (
    <div className="thread">
      <header className="thread-header">
        <h2>{conversation.title || 'Conversation'}</h2>
        <p className="muted">
          Started in {CONVERSATION_CHANNEL_LABELS[conversation.channel]}
          {conversation.projectName && <> · {conversation.projectName}</>}
          {conversation.taskId && (
            <>
              {' · '}
              <Link to={`/tasks/${conversation.taskId}`}>{conversation.taskTitle ?? 'the task'}</Link>
            </>
          )}
          {conversation.companyContext && <> · PAC context {conversation.companyContext.shortSha}</>}
        </p>
      </header>

      {/*
        Summaries are shown ALONGSIDE the messages they cover, never instead of
        them. §11: a generated summary must not overwrite source messages, and
        the source history stays traceable — which is only true if a reader can
        see both.
      */}
      {summaries.length > 0 && (
        <details className="card">
          <summary>What Mac has carried forward ({summaries.length} summary/ies)</summary>
          {summaries.map((summary) => (
            <div key={summary.id} className="summary">
              <p className="muted">
                Covers messages {summary.coversFromSeq}–{summary.coversToSeq}
              </p>
              <SummaryList label="Decisions" items={summary.content.decisions} />
              <SummaryList label="Corrections" items={summary.content.corrections} />
              <SummaryList label="Project facts" items={summary.content.projectFacts} />
              <SummaryList label="Still unresolved" items={summary.content.unresolvedQuestions} />
            </div>
          ))}
        </details>
      )}

      <ol className="messages">
        {messages.map((message) => (
          <li key={message.id} className={message.authorKind === 'mac' ? 'message from-mac' : 'message from-human'}>
            <div className="message-meta">
              <strong>{message.authorKind === 'mac' ? 'Mac' : message.authorName || 'You'}</strong>
              {/* The channel per message: the thread spans them. */}
              <Badge tone="idle">{CONVERSATION_CHANNEL_LABELS[message.channel as ConversationChannel]}</Badge>
              {message.intent && (
                <Badge tone="info">{MESSAGE_INTENT_LABELS[message.intent as MessageIntent]}</Badge>
              )}
              {message.direction === 'outbound' && message.deliveryState !== 'not_required' && (
                <Badge tone={message.deliveryState === 'sent' ? 'ok' : message.deliveryState === 'dead' ? 'danger' : 'warn'}>
                  {message.deliveryState}
                </Badge>
              )}
              <Time value={message.createdAt} />
            </div>
            <p className="message-body">{message.body}</p>
            {message.deliveryError && <p className="muted">Delivery: {message.deliveryError}</p>}
          </li>
        ))}
      </ol>

      {error && <Alert kind="error">{error}</Alert>}

      {canPost ? (
        <form className="composer" onSubmit={send}>
          <textarea
            rows={3}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Reply, answer a question, or approve with a code (for example: approve AP-4F2K)"
          />
          <button type="submit" disabled={busy || !draft.trim()}>
            {busy ? 'Sending…' : 'Send'}
          </button>
        </form>
      ) : (
        <p className="muted">Viewers can read conversations but not post to them.</p>
      )}
    </div>
  );
}

function SummaryList({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <strong>{label}</strong>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
