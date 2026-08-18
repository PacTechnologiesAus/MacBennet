/**
 * Context precedence, as an executable ladder (Sprint 3.2 §11).
 *
 * ---------------------------------------------------------------------------
 * THE RULE THIS FILE EXISTS TO MAKE UNARGUABLE
 *
 * A task instruction may not grant Mac an authority PAC has not given him. Not
 * by being newer, not by being more specific, not by being emphatic, and not by
 * appearing in a document Mac loaded from the company repository.
 *
 * The mechanism is a two-stage decision. Stage one is a fixed list of
 * capabilities that no layer can grant, checked before anything else is even
 * read. Stage two, for everything else, lets the MOST SPECIFIC statement win —
 * which is how "more specific context may refine general policy" becomes real
 * rather than aspirational.
 * ---------------------------------------------------------------------------
 *
 * Pure. No I/O, no database, no configuration. It is consulted when classifying
 * evidence and when explaining a refusal; it does not replace the dispatch
 * guardrails in `guardrails.ts` or the git shim, both of which continue to be
 * the things that physically stop an action.
 */

/**
 * The layers, ordered from most to least authoritative.
 *
 * Index IS the rank: 0 outranks everything. The list mirrors Sprint 3.2 §11 of
 * the brief exactly, so a reader can compare them line by line.
 */
export const CONTEXT_LAYERS = [
  /** Enforced in this application's code. Outranks every document, including AUTHORITY.md. */
  'hard_guardrail',
  /** AUTHORITY.md, from the approved company context. */
  'company_authority',
  /** Mac's own role definition and authority (AGENTS.md § Mac, plus role config). */
  'mac_role',
  /** Authoritative project context. */
  'project_context',
  /** The current approved task instructions. */
  'task_instruction',
  /** Project/task learned knowledge. */
  'learned_knowledge',
  /** Assumptions. */
  'assumption',
] as const;
export type ContextLayer = (typeof CONTEXT_LAYERS)[number];

export const LAYER_RANK: Record<ContextLayer, number> = CONTEXT_LAYERS.reduce(
  (acc, layer, index) => ({ ...acc, [layer]: index }),
  {} as Record<ContextLayer, number>,
);

/**
 * Capabilities no layer may grant, ever.
 *
 * Declared HERE, in code, and deliberately NOT read from `AUTHORITY.md`.
 *
 * That is not a shortcut — it is the point. A document that can grant itself
 * authority is not a guardrail, it is a suggestion. If somebody edited
 * `AUTHORITY.md` tomorrow to permit autonomous deployment to a commissioned
 * plant, Mac would still refuse, because this prohibition is also a technical
 * control in this application (spec §16 "Hard V1 Prohibitions", Sprint 3.2 §11).
 *
 * The list is corroborated by the authoritative AUTHORITY.md rather than
 * derived from it, and a test asserts the two agree.
 */
export const PROHIBITED_CAPABILITIES = [
  /** Deploying to a live or commissioned customer system. */
  'live_deployment',
  /** Merging to a protected, default or release branch. */
  'protected_branch_merge',
  /** Spending PAC money, in any form. */
  'financial_commitment',
  /** Communicating directly with customers, suppliers, OEMs or other externals. */
  'external_communication',
  /** Promising dates, accepting scope, agreeing variations. */
  'customer_commitment',
  /** Weakening, bypassing or disabling a safety control, interlock or permissive. */
  'safety_control_change',
  /** Permanently deleting project, engineering, commercial or evidence records. */
  'destructive_action',
  /** Transferring IP, granting licences, or making binding warranty determinations. */
  'ip_or_warranty_authority',
] as const;
export type ProhibitedCapability = (typeof PROHIBITED_CAPABILITIES)[number];

export const isProhibitedCapability = (capability: string): capability is ProhibitedCapability =>
  (PROHIBITED_CAPABILITIES as readonly string[]).includes(capability);

export interface CapabilityStatement {
  layer: ContextLayer;
  effect: 'allow' | 'deny';
  /** Where this came from, for the explanation. `company:AUTHORITY.md@83ac4a0`, `task:brief`. */
  source: string;
}

export interface CapabilityDecision {
  allowed: boolean;
  decidedBy: ContextLayer;
  source: string;
  reason: string;
}

/**
 * Resolves whether Mac may do something, given everything that has been said
 * about it.
 *
 * Four rules, applied in order. The ordering is the whole design:
 *
 *  1. A prohibited capability is refused before any statement is read. Nothing
 *     downstream can reach this decision, which is why a task cannot argue its
 *     way to a live deployment and why a manifest cannot grant Mac approval
 *     authority over its own repository.
 *  2. A `deny` at company authority or stronger is final. Company policy may
 *     forbid something the prohibition list does not, and a project or task
 *     cannot undo that.
 *  3. Otherwise the most SPECIFIC statement wins — highest layer index among
 *     those present. This is refinement: a project may narrow or widen a
 *     company default, and a task may narrow or widen the project's.
 *  4. Silence is not permission.
 */
export function resolveCapability(input: {
  capability: string;
  statements: readonly CapabilityStatement[];
}): CapabilityDecision {
  if (isProhibitedCapability(input.capability)) {
    return {
      allowed: false,
      decidedBy: 'hard_guardrail',
      source: 'application guardrail',
      reason:
        `"${input.capability}" is a hard prohibition enforced in Mac's own code. ` +
        'No project context, task instruction or company document can grant it. ' +
        'Prepare and recommend the action instead; a human performs it.',
    };
  }

  const denials = input.statements.filter(
    (s) => s.effect === 'deny' && LAYER_RANK[s.layer] <= LAYER_RANK.company_authority,
  );
  if (denials.length > 0) {
    // The strongest denial explains it; a tie keeps the first stated.
    const strongest = denials.reduce((a, b) => (LAYER_RANK[b.layer] < LAYER_RANK[a.layer] ? b : a));
    return {
      allowed: false,
      decidedBy: strongest.layer,
      source: strongest.source,
      reason: `Refused by ${strongest.layer} (${strongest.source}), which a more specific context may not override.`,
    };
  }

  if (input.statements.length === 0) {
    return {
      allowed: false,
      decidedBy: 'hard_guardrail',
      source: 'application guardrail',
      reason:
        `Nothing grants "${input.capability}". Absence of a prohibition is not permission — ` +
        'Mac acts only within authority he has actually been given.',
    };
  }

  // Most specific wins. Ties at the same layer prefer `deny`, because between
  // two equally authoritative statements the cautious one is the right default.
  const mostSpecificRank = Math.max(...input.statements.map((s) => LAYER_RANK[s.layer]));
  const contenders = input.statements.filter((s) => LAYER_RANK[s.layer] === mostSpecificRank);
  const winner = contenders.find((s) => s.effect === 'deny') ?? contenders[0]!;

  return {
    allowed: winner.effect === 'allow',
    decidedBy: winner.layer,
    source: winner.source,
    reason:
      winner.effect === 'allow'
        ? `Permitted by ${winner.layer} (${winner.source}), the most specific context that addresses it.`
        : `Refused by ${winner.layer} (${winner.source}), the most specific context that addresses it.`,
  };
}

/**
 * Whether Mac may approve a change to the authoritative company context.
 *
 * Always false. It takes a manifest argument purely so the caller can pass what
 * the repository claims and be told, in the returned reason, that it does not
 * matter (Sprint 3.2 §6.3): governance flags are recorded as provenance, not
 * obeyed upward.
 */
export function mayApproveCompanyContext(manifestGovernance: { agents_may_approve_changes?: boolean } | null): CapabilityDecision {
  const claimed = manifestGovernance?.agents_may_approve_changes === true;
  return {
    allowed: false,
    decidedBy: 'hard_guardrail',
    source: 'application guardrail',
    reason: claimed
      ? 'The manifest declares agents_may_approve_changes: true, which Mac records but does not act on. ' +
        'Approving PAC company context is a human decision, and Mac has no verb that writes the repository.'
      : 'Approving PAC company context is a human decision. Mac may propose a change; only a person may accept it.',
  };
}

/**
 * Compares the manifest's declared precedence with the executable ladder.
 *
 * The manifest speaks in its own vocabulary (`AUTHORITY.md`,
 * `agent_specific_context`, `project_context`, `task_context`); this maps those
 * onto layers and reports whether the declared order is consistent with the
 * code's. A mismatch is worth surfacing — it means PAC changed the ladder and
 * Mac has not been updated — but it is not a load failure, because the code's
 * ladder is the one that governs either way.
 */
const MANIFEST_LAYER_ALIASES: Record<string, ContextLayer> = {
  'authority.md': 'company_authority',
  agent_specific_context: 'mac_role',
  project_context: 'project_context',
  task_context: 'task_instruction',
};

export function manifestPrecedenceMatches(declared: readonly string[]): boolean {
  const mapped = declared
    .map((entry) => MANIFEST_LAYER_ALIASES[entry.trim().toLowerCase()])
    .filter((layer): layer is ContextLayer => layer !== undefined);

  for (let i = 1; i < mapped.length; i += 1) {
    if (LAYER_RANK[mapped[i]!] <= LAYER_RANK[mapped[i - 1]!]) return false;
  }
  return mapped.length > 0;
}
