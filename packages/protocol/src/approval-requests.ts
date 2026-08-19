import { z } from 'zod';

/**
 * Approval requests that can be answered from a chat window (Phase 4 Part B).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS NOT
 *
 * It is not a second approval system. `approvals` (Sprint 1) remains the record
 * of an authorisation against a run, with its confidence, its threshold and its
 * source. This is the REQUEST that precedes it: the thing Mac sends to a human,
 * which a human answers, and which then routes into the existing `approveRun`
 * path with the existing gates.
 *
 * The reason it needs to exist as a row at all is the binding problem. Spec:
 *
 *   "An ambiguous message such as 'sounds good' must not approve the wrong
 *    action if multiple approvals are outstanding."
 *
 * You cannot enforce that without an addressable object with an identity a
 * human can quote back. A pending approval that exists only as a run's
 * `approval_state` has no identity, so any affirmation in the vicinity is as
 * good as any other — which is precisely the failure mode.
 * ---------------------------------------------------------------------------
 */

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * The human-quotable code, e.g. `AP-4F2K`.
 *
 * Deliberately short, deliberately not a UUID, and deliberately not sequential.
 *
 * Short because somebody has to type it on a phone. Not a UUID for the same
 * reason. Not sequential because `AP-7` and `AP-8` are one keystroke apart and
 * the entire point of this object is that approving the wrong thing must be
 * hard.
 *
 * The alphabet omits I, O, 0, 1 for the same reason every parcel-tracking code
 * does.
 */
export const APPROVAL_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const APPROVAL_CODE_LENGTH = 4;
export const APPROVAL_CODE_PREFIX = 'AP-';

export const approvalCodePattern = new RegExp(
  `\\b${APPROVAL_CODE_PREFIX}([${APPROVAL_CODE_ALPHABET}]{${APPROVAL_CODE_LENGTH}})\\b`,
  'i',
);

/** Every code appearing in a message, uppercased and de-duplicated. */
export function extractApprovalCodes(text: string): string[] {
  const scan = new RegExp(approvalCodePattern.source, 'gi');
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = scan.exec(text)) !== null) {
    found.add(`${APPROVAL_CODE_PREFIX}${match[1]!.toUpperCase()}`);
  }
  return Array.from(found);
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/** What the request is asking permission to do something to. */
export const APPROVAL_SUBJECT_KINDS = ['run', 'brief', 'action'] as const;
export const approvalSubjectKindSchema = z.enum(APPROVAL_SUBJECT_KINDS);
export type ApprovalSubjectKind = z.infer<typeof approvalSubjectKindSchema>;

export const APPROVAL_REQUEST_STATES = [
  'pending',
  'approved',
  'rejected',
  'expired',
  /** The thing it was about changed underneath it. */
  'superseded',
  'cancelled',
] as const;
export const approvalRequestStateSchema = z.enum(APPROVAL_REQUEST_STATES);
export type ApprovalRequestState = z.infer<typeof approvalRequestStateSchema>;

export const isOpenApprovalState = (state: ApprovalRequestState): boolean => state === 'pending';

/**
 * What authority is being asked for.
 *
 * ---------------------------------------------------------------------------
 * THE DENY LIST IS THE POINT OF THIS ENUMERATION
 *
 * Phase 4 Part B §9: "Do not use conversational approval to weaken existing
 * technical gates." The classes below split into two groups, and the split is
 * not advisory:
 *
 *   * `CONVERSATIONALLY_APPROVABLE` — a person in a chat window may authorise
 *     this, and it routes into exactly the same gate the web UI uses.
 *
 *   * everything else — spec §16's hard V1 prohibitions. There is no code path
 *     that turns a message into one of these authorisations, and the check runs
 *     at DECISION time as well as at request time, so a request created before
 *     somebody edited a policy still cannot be approved into a prohibited act.
 *
 * A prohibited class can still be REQUESTED. That is not a hole: recording that
 * Mac wanted to do something and was refused is more useful than pretending he
 * never asked, and the refusal is audited.
 * ---------------------------------------------------------------------------
 */
export const AUTHORITY_CLASSES = [
  /** Start approved work. The ordinary case. */
  'execute_run',
  /** Accept a handoff brief as the contract for work. */
  'accept_brief',
  /** Widen what a run may touch, within existing guardrails. */
  'expand_scope',
  /** Proceed on Mac's stated assumption. */
  'proceed_on_assumption',
  /** Open a pull request for review. Never a merge. */
  'open_pull_request',

  // --- Beyond conversational authority (spec §16) --------------------------
  'merge_protected_branch',
  'deploy_live_system',
  'spend_money',
  'external_commitment',
  'destructive_action',
  'change_access_control',
  'release_pac_ip',
] as const;
export const authorityClassSchema = z.enum(AUTHORITY_CLASSES);
export type AuthorityClass = z.infer<typeof authorityClassSchema>;

/** The classes a conversational reply may actually authorise. */
export const CONVERSATIONALLY_APPROVABLE: readonly AuthorityClass[] = [
  'execute_run',
  'accept_brief',
  'expand_scope',
  'proceed_on_assumption',
  'open_pull_request',
];

/**
 * Why a class is refused, in words a human can act on.
 *
 * A refusal that says "not permitted" teaches nobody anything. These say which
 * rule is refusing and what the person should do instead.
 */
export const AUTHORITY_REFUSALS: Record<AuthorityClass, string | null> = {
  execute_run: null,
  accept_brief: null,
  expand_scope: null,
  proceed_on_assumption: null,
  open_pull_request: null,

  merge_protected_branch:
    'Merging a protected or default branch is a hard V1 prohibition (spec §16). It is enforced in the ' +
    'git shim before git sees the command, and no approval anywhere in this system lifts it. Merge it yourself.',
  deploy_live_system:
    'Deploying to a live customer system is a hard V1 prohibition (spec §16). Mac cannot be authorised into it ' +
    'from a chat window or anywhere else.',
  spend_money:
    'Financial commitments are a hard V1 prohibition (spec §16). A person with spending authority has to do this.',
  external_commitment:
    'Mac does not make commitments outside PAC (spec §16). Someone who can be held to it has to make it.',
  destructive_action:
    'Destructive operations outside Mac authority require a person to perform them, not to approve them.',
  change_access_control:
    'Changing access control is high-risk (spec §16) and is performed by an administrator, not approved by message.',
  release_pac_ip: 'Releasing PAC intellectual property is not something Mac may be authorised to do conversationally.',
};

export const isConversationallyApprovable = (authority: AuthorityClass): boolean =>
  CONVERSATIONALLY_APPROVABLE.includes(authority);

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

export interface ApprovalRequestDto {
  id: string;
  /** The human-quotable identifier. Unique while pending. */
  code: string;
  state: ApprovalRequestState;
  subjectKind: ApprovalSubjectKind;
  /**
   * The version of the thing being approved.
   *
   * A brief at version 3 and a brief at version 4 are different contracts. An
   * approval carrying the wrong one authorises work nobody read, which is why
   * this is a required part of the binding rather than a convenience.
   */
  subjectVersion: number;
  projectId: string;
  projectName: string;
  taskId: string;
  taskTitle: string;
  runId: string | null;
  briefId: string | null;
  title: string;
  detail: string;
  /** What Mac recommends, so an approver is not starting from nothing. */
  recommendation: string;
  risk: 'low' | 'medium' | 'high';
  authority: AuthorityClass;
  /** Mac's confidence in the underlying understanding, when there is one. */
  confidence: number | null;
  requestedAt: string;
  expiresAt: string | null;
  /** Where it was delivered, so a duplicate is not sent to three channels. */
  deliveredChannels: string[];
  decidedAt: string | null;
  decidedByUserId: string | null;
  decidedByName: string | null;
  decidedViaChannel: string | null;
  decisionNotes: string | null;
  supersededByRequestId: string | null;
  createdAt: string;
}

export const createApprovalRequestSchema = z.object({
  taskId: z.string().uuid(),
  runId: z.string().uuid().nullish(),
  briefId: z.string().uuid().nullish(),
  subjectKind: approvalSubjectKindSchema,
  subjectVersion: z.number().int().min(0).default(0),
  title: z.string().min(1).max(300),
  detail: z.string().max(8000).default(''),
  recommendation: z.string().max(4000).default(''),
  risk: z.enum(['low', 'medium', 'high']).default('medium'),
  authority: authorityClassSchema.default('execute_run'),
  confidence: z.number().min(0).max(1).nullish(),
  expiresInHours: z.number().int().min(1).max(24 * 30).nullish(),
});
export type CreateApprovalRequest = z.infer<typeof createApprovalRequestSchema>;

export const decideApprovalRequestSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  notes: z.string().max(4000).default(''),
  /**
   * Acknowledgement that the underlying confidence is below the configured
   * threshold. Passed straight through to `approveRun`, which owns the rule.
   * Present here so a conversational approval cannot bypass a decision the web
   * UI forces somebody to make explicitly.
   */
  acceptBelowThreshold: z.boolean().default(false),
});
export type DecideApprovalRequest = z.infer<typeof decideApprovalRequestSchema>;

// ---------------------------------------------------------------------------
// Binding
// ---------------------------------------------------------------------------

export const APPROVAL_BINDING_OUTCOMES = [
  /** Exactly one request identified, unambiguously. */
  'bound',
  /** The sender affirmed or refused something without saying what. */
  'ambiguous',
  /** A code was quoted that matches nothing outstanding. */
  'unknown_code',
  /** There is nothing outstanding to decide. */
  'nothing_pending',
  /** The message is not a decision at all. */
  'not_a_decision',
] as const;
export type ApprovalBindingOutcome = (typeof APPROVAL_BINDING_OUTCOMES)[number];

export interface ApprovalBinding {
  outcome: ApprovalBindingOutcome;
  /** Set only when `outcome === 'bound'`. */
  requestId: string | null;
  code: string | null;
  decision: 'approve' | 'reject' | null;
  /** Requests the sender might have meant, for the clarifying reply. */
  candidates: Array<{ id: string; code: string; title: string }>;
  /** Why it resolved this way, for the audit record and the reply. */
  reason: string;
}

/** Affirmations and refusals, as whole words so "nope" does not match "no". */
const AFFIRM = /\b(approve[d]?|approval|yes|yep|yeah|ok|okay|go ahead|proceed|do it|sounds good|lgtm|ship it|agreed|fine|please do)\b/i;
const REFUSE = /\b(reject(ed)?|no|nope|don'?t|do not|stop|hold off|cancel|decline[d]?|not yet|wait)\b/i;

/**
 * Works out which outstanding approval a message is answering, if any.
 *
 * ---------------------------------------------------------------------------
 * WHY A BARE AFFIRMATION BINDS TO NOTHING, EVER
 *
 * The obvious softening is: if exactly one approval is outstanding, "yes" is
 * unambiguous, so bind it. It is wrong, and the reason is a race rather than a
 * philosophy.
 *
 * The count of outstanding requests changes between Mac sending a card and a
 * human reading it. Mac asks about A; a night shift raises B; the human — who
 * is looking at a phone showing only A — types "yes". Under the softened rule
 * that is now ambiguous, and under a rule that resolves ambiguity by recency it
 * approves B. The human did nothing wrong and authorised something they never
 * saw.
 *
 * So the rule is: bind on an explicit code, or on a card action carrying an id,
 * and otherwise ask. Asking costs one message. The other thing costs an
 * authorisation nobody gave.
 * ---------------------------------------------------------------------------
 */
export function bindApprovalDecision(input: {
  text: string;
  pending: ReadonlyArray<{ id: string; code: string; title: string }>;
  /** Set when the message came from an interactive control carrying an id. */
  explicitRequestId?: string | null;
  explicitDecision?: 'approve' | 'reject' | null;
}): ApprovalBinding {
  const candidates = input.pending.map((p) => ({ id: p.id, code: p.code, title: p.title }));

  // An interactive control is unambiguous by construction: the id travelled
  // with the button, so there is nothing to infer.
  if (input.explicitRequestId) {
    const match = input.pending.find((p) => p.id === input.explicitRequestId);
    if (!match) {
      return {
        outcome: 'unknown_code',
        requestId: null,
        code: null,
        decision: null,
        candidates,
        reason: 'That approval is no longer outstanding — it may have been decided, expired or superseded.',
      };
    }
    return {
      outcome: 'bound',
      requestId: match.id,
      code: match.code,
      decision: input.explicitDecision ?? 'approve',
      candidates,
      reason: 'An interactive approval control carried the request identifier.',
    };
  }

  const text = input.text ?? '';
  const affirms = AFFIRM.test(text);
  const refuses = REFUSE.test(text);
  const codes = extractApprovalCodes(text);

  if (!affirms && !refuses && codes.length === 0) {
    return {
      outcome: 'not_a_decision',
      requestId: null,
      code: null,
      decision: null,
      candidates,
      reason: 'The message does not read as an approval or a refusal.',
    };
  }

  if (input.pending.length === 0) {
    return {
      outcome: 'nothing_pending',
      requestId: null,
      code: null,
      decision: null,
      candidates,
      reason: 'Nothing is waiting on a decision.',
    };
  }

  /*
   * Both an affirmation and a refusal in one message.
   *
   * "yes, but don't deploy it" is a real sentence a real person types, and
   * guessing which half is the decision is exactly the sort of guess this
   * function exists not to make.
   */
  if (affirms && refuses) {
    return {
      outcome: 'ambiguous',
      requestId: null,
      code: null,
      decision: null,
      candidates,
      reason: 'The message reads as both an approval and a refusal, so Mac will not choose between them.',
    };
  }

  const decision: 'approve' | 'reject' = affirms ? 'approve' : 'reject';

  if (codes.length === 1) {
    const match = input.pending.find((p) => p.code.toUpperCase() === codes[0]);
    if (!match) {
      return {
        outcome: 'unknown_code',
        requestId: null,
        code: codes[0]!,
        decision,
        candidates,
        reason: `${codes[0]} is not an approval that is currently outstanding.`,
      };
    }
    return {
      outcome: 'bound',
      requestId: match.id,
      code: match.code,
      decision,
      candidates,
      reason: `The message names ${match.code}.`,
    };
  }

  if (codes.length > 1) {
    return {
      outcome: 'ambiguous',
      requestId: null,
      code: null,
      decision,
      candidates,
      reason: 'The message names more than one approval, and Mac will not apply one decision to several.',
    };
  }

  return {
    outcome: 'ambiguous',
    requestId: null,
    code: null,
    decision,
    candidates,
    reason:
      candidates.length === 1
        ? 'The message does not say which approval it means. Mac does not infer it even when only one is ' +
          'outstanding, because what is outstanding changes between him asking and you answering.'
        : `${candidates.length} approvals are outstanding and the message does not say which one it means.`,
  };
}

/**
 * The clarifying reply Mac sends when a decision could not be bound.
 *
 * Kept here rather than in a service so the wording is testable without a
 * database, and so it cannot drift between the Teams path and the web path.
 */
export function renderBindingClarification(binding: ApprovalBinding): string {
  if (binding.outcome === 'nothing_pending') {
    return 'Nothing is waiting on your approval at the moment.';
  }
  if (binding.outcome === 'unknown_code') {
    const list = binding.candidates.map((c) => `${c.code} — ${c.title}`).join('\n');
    return list
      ? `${binding.reason}\n\nStill outstanding:\n${list}\n\nReply with the code.`
      : `${binding.reason} Nothing is outstanding now.`;
  }
  const list = binding.candidates.map((c) => `${c.code} — ${c.title}`).join('\n');
  return `${binding.reason}\n\nOutstanding:\n${list}\n\nReply with the code (for example "approve ${binding.candidates[0]?.code ?? APPROVAL_CODE_PREFIX + 'XXXX'}"), or use the buttons on the card.`;
}
