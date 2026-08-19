import { describe, expect, it } from 'vitest';
import {
  APPROVAL_CODE_ALPHABET,
  AUTHORITY_CLASSES,
  AUTHORITY_REFUSALS,
  bindApprovalDecision,
  CONVERSATIONALLY_APPROVABLE,
  extractApprovalCodes,
  isConversationallyApprovable,
  renderBindingClarification,
} from '@mac/protocol';

/**
 * Binding a conversational decision to a specific approval (Phase 4 Part B §8),
 * and the authority boundary it may never cross (§9).
 */

const pending = (...items: Array<[string, string, string]>) =>
  items.map(([id, code, title]) => ({ id, code, title }));

const ONE = pending(['id-1', 'AP-4F2K', 'Run the S7-300 migration investigation']);
const TWO = pending(
  ['id-1', 'AP-4F2K', 'Run the S7-300 migration investigation'],
  ['id-2', 'AP-9QRS', 'Open a pull request on forger'],
);

describe('binding a decision', () => {
  it('binds on a quoted code', () => {
    const binding = bindApprovalDecision({ text: 'yes, approve AP-4F2K', pending: TWO });

    expect(binding.outcome).toBe('bound');
    expect(binding.requestId).toBe('id-1');
    expect(binding.decision).toBe('approve');
  });

  it('binds a rejection on a quoted code', () => {
    const binding = bindApprovalDecision({ text: 'no — reject AP-9QRS please', pending: TWO });

    expect(binding.outcome).toBe('bound');
    expect(binding.requestId).toBe('id-2');
    expect(binding.decision).toBe('reject');
  });

  it('binds an interactive control by the id the button carried', () => {
    // A card action is unambiguous by construction: the identity travelled with
    // the button, so there is nothing to infer from the label.
    const binding = bindApprovalDecision({
      text: '',
      pending: TWO,
      explicitRequestId: 'id-2',
      explicitDecision: 'reject',
    });

    expect(binding.outcome).toBe('bound');
    expect(binding.requestId).toBe('id-2');
  });

  it('refuses a card action for something no longer outstanding', () => {
    const binding = bindApprovalDecision({ text: '', pending: ONE, explicitRequestId: 'id-gone' });
    expect(binding.outcome).toBe('unknown_code');
  });
});

describe('what must never bind', () => {
  it('refuses a bare affirmation even when exactly one approval is outstanding', () => {
    /*
     * The rule the phase brief names, applied more strictly than its letter.
     *
     * The softening — "only one is outstanding, so 'yes' is unambiguous" — is
     * wrong for a reason that is a race rather than a philosophy: the count
     * changes between Mac sending a card and a human reading it. Mac asks about
     * A, a night shift raises B, the human looking at a phone showing only A
     * types "yes". They did nothing wrong and would have authorised B.
     */
    const binding = bindApprovalDecision({ text: 'sounds good', pending: ONE });

    expect(binding.outcome).toBe('ambiguous');
    expect(binding.requestId).toBeNull();
    expect(binding.reason).toMatch(/changes between him asking and you answering/);
  });

  it('refuses a bare affirmation when several are outstanding', () => {
    const binding = bindApprovalDecision({ text: 'yep go ahead', pending: TWO });

    expect(binding.outcome).toBe('ambiguous');
    expect(binding.candidates).toHaveLength(2);
  });

  it('refuses a message that both approves and refuses', () => {
    // "yes, but don't deploy it" is a real sentence a real person types, and
    // choosing which half is the decision is exactly the guess this refuses.
    const binding = bindApprovalDecision({ text: "yes, but don't deploy it", pending: ONE });
    expect(binding.outcome).toBe('ambiguous');
  });

  it('refuses one decision applied to several named codes', () => {
    const binding = bindApprovalDecision({ text: 'approve AP-4F2K and AP-9QRS', pending: TWO });
    expect(binding.outcome).toBe('ambiguous');
  });

  it('refuses a code that is not outstanding rather than falling back to the nearest', () => {
    const binding = bindApprovalDecision({ text: 'approve AP-ZZZZ', pending: ONE });

    expect(binding.outcome).toBe('unknown_code');
    expect(binding.requestId).toBeNull();
  });

  it('says nothing is pending rather than inventing something to approve', () => {
    const binding = bindApprovalDecision({ text: 'go ahead', pending: [] });
    expect(binding.outcome).toBe('nothing_pending');
  });

  it('leaves an ordinary message alone', () => {
    const binding = bindApprovalDecision({ text: 'what is the status of the migration?', pending: ONE });
    expect(binding.outcome).toBe('not_a_decision');
  });
});

describe('the clarifying reply', () => {
  it('names every outstanding approval and its code', () => {
    const binding = bindApprovalDecision({ text: 'yes', pending: TWO });
    const reply = renderBindingClarification(binding);

    expect(reply).toContain('AP-4F2K');
    expect(reply).toContain('AP-9QRS');
    // A refusal has to tell somebody what to do next, or it is just a no.
    expect(reply).toMatch(/Reply with the code/);
  });
});

describe('approval codes', () => {
  it('finds codes anywhere in a message, case-insensitively, de-duplicated', () => {
    expect(extractApprovalCodes('ok ap-4f2k yes AP-4F2K')).toEqual(['AP-4F2K']);
  });

  it('uses an alphabet without the characters people confuse', () => {
    // The same reason every parcel-tracking code does it: somebody is typing
    // this on a phone, and O/0 and I/1 are how they get it wrong.
    for (const character of ['I', 'O', '0', '1']) {
      expect(APPROVAL_CODE_ALPHABET).not.toContain(character);
    }
  });

  it('does not match something that merely looks similar', () => {
    expect(extractApprovalCodes('AP-12')).toEqual([]);
    expect(extractApprovalCodes('APPROVE')).toEqual([]);
  });
});

describe('the authority boundary', () => {
  it('permits the ordinary classes to be approved conversationally', () => {
    expect(isConversationallyApprovable('execute_run')).toBe(true);
    expect(isConversationallyApprovable('accept_brief')).toBe(true);
    expect(isConversationallyApprovable('open_pull_request')).toBe(true);
  });

  it('refuses every hard V1 prohibition, from a chat window or anywhere else', () => {
    // Spec §16. Part B §9: Teams is a convenient approval interface, not an
    // authority bypass.
    for (const authority of [
      'merge_protected_branch',
      'deploy_live_system',
      'spend_money',
      'external_commitment',
      'destructive_action',
      'change_access_control',
      'release_pac_ip',
    ] as const) {
      expect(isConversationallyApprovable(authority), authority).toBe(false);
      // And the refusal names the rule rather than saying "not permitted".
      expect(AUTHORITY_REFUSALS[authority]).toBeTruthy();
    }
  });

  it('gives every authority class a decision about whether it may be approved', () => {
    // A class added later without being considered would otherwise default to
    // whichever branch the code happened to take.
    for (const authority of AUTHORITY_CLASSES) {
      const approvable = CONVERSATIONALLY_APPROVABLE.includes(authority);
      expect(approvable === (AUTHORITY_REFUSALS[authority] === null), authority).toBe(true);
    }
  });
});
