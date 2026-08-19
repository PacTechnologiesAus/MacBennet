import { z } from 'zod';

/**
 * Microsoft Teams as an interface to Mac (Phase 4 Part A).
 *
 * ---------------------------------------------------------------------------
 * IDENTITY, STATED HONESTLY
 *
 * Spec §2 says Mac will have "a Microsoft Teams identity", and Phase 4 Part A
 * §2 says he must appear professionally as "Mac Bennett / Automation Engineer"
 * WHERE THE PLATFORM GENUINELY SUPPORTS IT, and that a platform limitation must
 * be documented rather than faked.
 *
 * The limitation is real and it is worth being precise about:
 *
 *   Microsoft Teams has no mechanism by which a third-party application posts
 *   as a human user account. Applications post as BOT identities. A message
 *   from a bot is visibly a message from a bot, and there is no supported,
 *   unsupported or ill-advised API that changes this.
 *
 * That is also the right outcome. A reader must be able to tell that Mac is an
 * agent — not because the platform insists, but because a message that looks
 * like it came from a colleague and did not is a lie told by the system rather
 * than by anybody in particular.
 *
 * So: Mac appears as a bot application whose display name is "Mac Bennett", and
 * every card and every substantive message carries "Automation Engineer ·
 * PAC Technologies". The identity below is typed data rather than prose so the
 * claim is checkable by a test.
 * ---------------------------------------------------------------------------
 */

export const MAC_TEAMS_IDENTITY = Object.freeze({
  displayName: 'Mac Bennett',
  jobTitle: 'Automation Engineer',
  company: 'PAC Technologies',
  /** How Mac signs a substantive message, so attribution survives a forward. */
  signature: 'Mac Bennett · Automation Engineer · PAC Technologies',
  /**
   * What the platform cannot do, recorded next to what it can.
   *
   * Read by the settings page and by the completion report, so the limitation
   * is stated to an operator at the point they would otherwise assume
   * otherwise.
   */
  limitation:
    'Microsoft Teams does not permit an application to post as a human user account. Mac appears as an ' +
    'application (bot) identity named "Mac Bennett". This is a platform constraint, not a configuration ' +
    'choice, and human attribution is deliberately not simulated.',
} as const);

// ---------------------------------------------------------------------------
// Setup requirements
// ---------------------------------------------------------------------------

/**
 * What a human must do before Teams works.
 *
 * Typed data rather than a paragraph in a runbook, because the settings page
 * should be able to say exactly which of these is missing rather than reporting
 * "Teams is not configured" and leaving somebody to guess which of six things
 * that means.
 */
export const TEAMS_SETUP_REQUIREMENTS = Object.freeze([
  {
    key: 'MAC_TEAMS_APP_ID',
    label: 'Azure Bot application (client) ID',
    detail: 'From the Azure Bot resource registered for Mac. Also the expected JWT audience on inbound activities.',
    secret: false,
  },
  {
    key: 'MAC_TEAMS_APP_PASSWORD',
    label: 'Azure Bot client secret',
    detail: 'Used only to obtain a Bot Connector token. Never sent to a worker, a model or a research tool.',
    secret: true,
  },
  {
    key: 'MAC_TEAMS_TENANT_ID',
    label: 'PAC Azure AD tenant ID',
    detail: 'Single-tenant bots authenticate against this tenant and reject activities from any other.',
    secret: false,
  },
  {
    key: 'messaging endpoint',
    label: 'Bot messaging endpoint',
    detail: 'Set the Azure Bot messaging endpoint to https://<mac host>/api/teams/messages.',
    secret: false,
  },
  {
    key: 'teams channel',
    label: 'Microsoft Teams channel enabled',
    detail: 'Enable the Microsoft Teams channel on the Azure Bot resource and install the app in the PAC tenant.',
    secret: false,
  },
] as const);

// ---------------------------------------------------------------------------
// The wire: Bot Framework activities
// ---------------------------------------------------------------------------

/**
 * The subset of the Bot Framework Activity schema Mac actually reads.
 *
 * Deliberately a subset, and deliberately `passthrough`-free. An activity
 * carries a great deal Mac has no business acting on, and parsing only what is
 * used means a field nobody reviewed cannot influence behaviour by being
 * present.
 */
export const TEAMS_ACTIVITY_TYPES = [
  'message',
  'conversationUpdate',
  'invoke',
  'messageReaction',
  'installationUpdate',
  'typing',
] as const;
export type TeamsActivityType = (typeof TEAMS_ACTIVITY_TYPES)[number];

const accountSchema = z.object({
  id: z.string().min(1).max(300),
  name: z.string().max(300).optional(),
  /** The AAD object id, when Teams supplies it. Stable across renames. */
  aadObjectId: z.string().max(100).optional(),
});

export const teamsActivitySchema = z.object({
  type: z.string().min(1).max(60),
  id: z.string().max(300).optional(),
  timestamp: z.string().max(60).optional(),
  /**
   * Where a reply to this activity must be sent.
   *
   * ---------------------------------------------------------------------
   * THIS FIELD IS A CREDENTIAL SINK AND IS TREATED AS ONE
   *
   * Replying means POSTing to `serviceUrl` with Mac's Bot Connector bearer
   * token in the header. A `serviceUrl` an attacker controls is therefore an
   * instruction to hand that token to a host of their choosing.
   *
   * So it is accepted here only as part of a JWT-VERIFIED activity, stored on
   * the conversation from that verified activity, and validated against an
   * allowlist of Microsoft service hosts before anything is sent. It is never
   * read from an unverified request body, and never taken from a parameter.
   * ---------------------------------------------------------------------
   */
  serviceUrl: z.string().max(500).optional(),
  channelId: z.string().max(60).optional(),
  from: accountSchema.optional(),
  recipient: accountSchema.optional(),
  conversation: z
    .object({
      id: z.string().min(1).max(500),
      name: z.string().max(300).optional(),
      conversationType: z.string().max(60).optional(),
      tenantId: z.string().max(100).optional(),
      isGroup: z.boolean().optional(),
    })
    .optional(),
  text: z.string().max(32_000).optional(),
  textFormat: z.string().max(40).optional(),
  locale: z.string().max(40).optional(),
  replyToId: z.string().max(300).optional(),
  /** Adaptive Card action payloads arrive here on `invoke` and `message`. */
  value: z.unknown().optional(),
  channelData: z
    .object({
      tenant: z.object({ id: z.string().max(100).optional() }).optional(),
      team: z.object({ id: z.string().max(300).optional(), name: z.string().max(300).optional() }).optional(),
      channel: z.object({ id: z.string().max(300).optional(), name: z.string().max(300).optional() }).optional(),
    })
    .optional(),
});
export type TeamsActivity = z.infer<typeof teamsActivitySchema>;

/**
 * The payload an Adaptive Card approval button sends back.
 *
 * `requestId` is what makes a card action an unambiguous binding — the identity
 * travels with the button rather than being inferred from the message text.
 */
export const teamsCardActionSchema = z.object({
  macAction: z.enum(['approve', 'reject', 'answer']),
  requestId: z.string().uuid().optional(),
  questionId: z.string().max(80).optional(),
  answer: z.string().max(8000).optional(),
  notes: z.string().max(4000).optional(),
});
export type TeamsCardAction = z.infer<typeof teamsCardActionSchema>;

/**
 * Hosts a Bot Connector reply may be sent to.
 *
 * An allowlist rather than "whatever the activity said", for the reason set out
 * on `serviceUrl` above. Suffix matching is anchored on a leading dot so
 * `evil-botframework.com` cannot match `botframework.com`.
 */
export const TEAMS_SERVICE_HOSTS: readonly string[] = [
  'botframework.com',
  'botframework.azure.us',
  'skype.com',
  'microsoft.com',
];

export function isPermittedServiceUrl(serviceUrl: string, allowed: readonly string[] = TEAMS_SERVICE_HOSTS): boolean {
  let url: URL;
  try {
    url = new URL(serviceUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return allowed.some((entry) => {
    const domain = entry.trim().toLowerCase().replace(/^\./, '');
    return Boolean(domain) && (host === domain || host.endsWith(`.${domain}`));
  });
}

// ---------------------------------------------------------------------------
// Adaptive Cards
// ---------------------------------------------------------------------------

export const ADAPTIVE_CARD_CONTENT_TYPE = 'application/vnd.microsoft.card.adaptive';
export const ADAPTIVE_CARD_SCHEMA = 'http://adaptivecards.io/schemas/adaptive-card.json';
export const ADAPTIVE_CARD_VERSION = '1.4';

export interface AdaptiveCardAttachment {
  contentType: typeof ADAPTIVE_CARD_CONTENT_TYPE;
  content: Record<string, unknown>;
}

const textBlock = (text: string, options: { weight?: string; size?: string; wrap?: boolean; isSubtle?: boolean } = {}) => ({
  type: 'TextBlock',
  text,
  wrap: options.wrap ?? true,
  ...(options.weight ? { weight: options.weight } : {}),
  ...(options.size ? { size: options.size } : {}),
  ...(options.isSubtle ? { isSubtle: true } : {}),
});

/**
 * The approval card.
 *
 * The buttons carry `requestId`, which is the whole reason cards are preferred
 * over text: an interactive control binds the decision to the request by
 * construction, so there is nothing for `bindApprovalDecision` to infer.
 *
 * The code is shown anyway. Somebody reading this on a phone at 06:00 may reply
 * by text, and a card whose identity is invisible forces them to guess.
 */
export function buildApprovalCard(input: {
  code: string;
  title: string;
  detail: string;
  recommendation: string;
  risk: string;
  authority: string;
  project: string;
  task: string;
  confidence: number | null;
  expiresAt: string | null;
  requestId: string;
  /** False for authority classes a message may never authorise. */
  decidable: boolean;
  refusal: string | null;
}): AdaptiveCardAttachment {
  const facts = [
    { title: 'Reference', value: input.code },
    { title: 'Project', value: input.project },
    { title: 'Task', value: input.task },
    { title: 'Risk', value: input.risk },
    { title: 'Authority', value: input.authority.replace(/_/g, ' ') },
  ];
  if (input.confidence !== null) {
    facts.push({ title: 'Understanding confidence', value: `${(input.confidence * 100).toFixed(0)}%` });
  }
  if (input.expiresAt) facts.push({ title: 'Expires', value: input.expiresAt });

  const body: Record<string, unknown>[] = [
    textBlock(input.title, { weight: 'Bolder', size: 'Medium' }),
    textBlock(MAC_TEAMS_IDENTITY.signature, { isSubtle: true, size: 'Small' }),
    { type: 'FactSet', facts },
  ];

  if (input.detail.trim()) body.push(textBlock(input.detail));
  if (input.recommendation.trim()) {
    body.push(textBlock('**Mac recommends**', { weight: 'Bolder' }), textBlock(input.recommendation));
  }

  if (!input.decidable && input.refusal) {
    // The card still exists — recording that Mac asked and was refused is more
    // useful than pretending he never asked — but it offers no buttons.
    body.push(textBlock(`⚠ ${input.refusal}`, { weight: 'Bolder' }));
  }

  return {
    contentType: ADAPTIVE_CARD_CONTENT_TYPE,
    content: {
      $schema: ADAPTIVE_CARD_SCHEMA,
      type: 'AdaptiveCard',
      version: ADAPTIVE_CARD_VERSION,
      body,
      actions: input.decidable
        ? [
            {
              type: 'Action.Submit',
              title: 'Approve',
              data: { macAction: 'approve', requestId: input.requestId } satisfies TeamsCardAction,
            },
            {
              type: 'Action.Submit',
              title: 'Reject',
              data: { macAction: 'reject', requestId: input.requestId } satisfies TeamsCardAction,
            },
          ]
        : [],
    },
  };
}

/**
 * The question card (Phase 4 Part B §6).
 *
 * Carries everything the brief requires a question to carry: project/task, the
 * question, why Mac needs it, options where relevant, his current recommendation
 * and his confidence. A question without those is a question somebody has to
 * come and look something up to answer, which is how a question goes unanswered.
 */
export function buildQuestionCard(input: {
  question: string;
  why: string;
  project: string;
  task: string;
  options: readonly string[];
  recommendation: string;
  confidence: number | null;
  questionId: string;
}): AdaptiveCardAttachment {
  const body: Record<string, unknown>[] = [
    textBlock(input.question, { weight: 'Bolder', size: 'Medium' }),
    textBlock(MAC_TEAMS_IDENTITY.signature, { isSubtle: true, size: 'Small' }),
    {
      type: 'FactSet',
      facts: [
        { title: 'Project', value: input.project },
        { title: 'Task', value: input.task },
        ...(input.confidence !== null
          ? [{ title: 'Confidence so far', value: `${(input.confidence * 100).toFixed(0)}%` }]
          : []),
      ],
    },
  ];

  if (input.why.trim()) body.push(textBlock(`**Why Mac needs this:** ${input.why}`));
  if (input.options.length) {
    body.push(textBlock('**Options**', { weight: 'Bolder' }), textBlock(input.options.map((o) => `- ${o}`).join('\n')));
  }
  if (input.recommendation.trim()) body.push(textBlock(`**Mac's view:** ${input.recommendation}`));

  body.push({ type: 'Input.Text', id: 'answer', placeholder: 'Your answer', isMultiline: true });

  return {
    contentType: ADAPTIVE_CARD_CONTENT_TYPE,
    content: {
      $schema: ADAPTIVE_CARD_SCHEMA,
      type: 'AdaptiveCard',
      version: ADAPTIVE_CARD_VERSION,
      body,
      actions: [
        {
          type: 'Action.Submit',
          title: 'Send answer',
          data: { macAction: 'answer', questionId: input.questionId },
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Connection status
// ---------------------------------------------------------------------------

export const TEAMS_CONNECTION_STATES = ['disabled', 'unconfigured', 'ready', 'error'] as const;
export type TeamsConnectionState = (typeof TEAMS_CONNECTION_STATES)[number];

export interface TeamsStatusDto {
  state: TeamsConnectionState;
  enabled: boolean;
  /** Which of `TEAMS_SETUP_REQUIREMENTS` are still missing, by key. */
  missing: string[];
  identity: {
    displayName: string;
    jobTitle: string;
    signature: string;
    limitation: string;
  };
  conversations: number;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  pendingDeliveries: number;
  failedDeliveries: number;
  lastError: string | null;
}
