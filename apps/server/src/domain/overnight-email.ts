import type { OvernightEmailContent } from '@mac/protocol';

/**
 * The morning email (Sprint 3 §9.4, brief §16).
 *
 * ---------------------------------------------------------------------------
 * SHORT BY CONSTRUCTION, NOT BY DISCIPLINE
 *
 * Spec §28 is blunt: "Engineers will ignore giant AI-generated novels." So the
 * shape here does the work rather than a reminder to be brief. Each completed
 * task contributes ONE line. Each blocker contributes three short fields. No
 * log content appears at all, and the detail lives behind links back to the Mac
 * UI.
 *
 * Every section the brief lists is present even when empty, because a missing
 * section reads as an oversight while "None." reads as an answer.
 * ---------------------------------------------------------------------------
 *
 * Pure: it renders a structure the caller assembled.
 */

export function renderOvernightEmailSubject(content: OvernightEmailContent): string {
  const parts: string[] = [];
  if (content.completed.length) parts.push(`${content.completed.length} done`);
  if (content.blocked.length) parts.push(`${content.blocked.length} blocked`);
  if (content.inProgress.length) parts.push(`${content.inProgress.length} in progress`);
  if (content.decisionsNeeded.length) parts.push(`${content.decisionsNeeded.length} for you`);

  const date = content.windowEnd.slice(0, 10);
  return parts.length ? `Mac overnight — ${parts.join(', ')} (${date})` : `Mac overnight — nothing to report (${date})`;
}

export function renderOvernightEmailText(content: OvernightEmailContent): string {
  const out: string[] = [];
  const bullets = (items: string[], empty = 'None.') =>
    items.length ? items.map((i) => `- ${i}`).join('\n') : empty;

  out.push('## Overnight Summary', '');
  out.push(`Completed: ${content.completed.length}`);
  out.push(`In progress: ${content.inProgress.length}`);
  out.push(`Blocked: ${content.blocked.length}`);
  out.push('');

  if (content.completed.length) {
    out.push(...content.completed.map((t) => `- DONE  ${t.task} (${t.project}) — ${t.summary}`));
  }
  if (content.inProgress.length) {
    out.push(...content.inProgress.map((t) => `- WIP   ${t.task} (${t.project}) — ${t.stage}`));
  }
  if (content.blocked.length) {
    out.push(...content.blocked.map((t) => `- STUCK ${t.task} (${t.project}) — ${t.blocker}`));
  }
  out.push('');

  out.push('## What Changed', '');
  out.push(bullets(content.whatChanged, 'Nothing was changed.'), '');

  out.push('## Pull Requests', '');
  out.push(
    content.pullRequests.length
      ? content.pullRequests.map((pr) => `- ${pr.url}\n  ${pr.title} — ${pr.summary}`).join('\n')
      : 'None opened.',
    '',
  );

  out.push('## Decisions Needed', '');
  out.push(bullets(content.decisionsNeeded), '');

  out.push('## Exceptions / Anomalies', '');
  out.push(bullets(content.exceptions), '');

  out.push('## Low-Confidence Assumptions', '');
  out.push(
    content.lowConfidenceAssumptions.length
      ? content.lowConfidenceAssumptions
          .map((a) => `- ${a.statement} (${(a.confidence * 100).toFixed(0)}%, ${a.task})`)
          .join('\n')
      : 'None below the threshold.',
    '',
  );

  out.push('## Estimated Human Hours', '');
  out.push(
    `~${content.estimatedHumanHours.total}h in total${
      content.estimatedHumanHours.byTask.length
        ? ` — ${content.estimatedHumanHours.byTask.map((t) => `${t.task}: ~${t.hours}h`).join('; ')}`
        : ''
    }. Rough order-of-magnitude estimate only.`,
    '',
  );

  out.push('## AI Usage', '');
  // Always carries its own source label. There is no branch here that prints a
  // bare number, and no branch that renders an estimate as a dollar cap.
  out.push(content.usage.label + (content.usage.note ? ` (${content.usage.note})` : ''), '');

  out.push('## monday.com', '');
  out.push(
    `${content.monday.itemsUpdated} item(s) updated · ${content.monday.statusChanges} status change(s) · ` +
      `${content.monday.updatesPosted} update(s) posted` +
      (content.monday.failures > 0 ? ` · ${content.monday.failures} write(s) failed or were refused` : ''),
    '',
  );

  out.push('---', '');
  out.push(`Full detail, logs and the Q&A record: ${content.dashboardUrl}`);
  out.push('Mac does not merge his own work. Every pull request above is waiting for a human.');

  return out.join('\n');
}

/**
 * The HTML version.
 *
 * Deliberately plain: inline styles, no images, no tracking, no external CSS.
 * It has to survive Outlook, and an engineer skimming it on a phone at 07:50
 * wants the same eight headings, not a layout.
 */
export function renderOvernightEmailHtml(content: OvernightEmailContent): string {
  const escape = (value: string): string =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const list = (items: string[], empty = 'None.') =>
    items.length
      ? `<ul style="margin:4px 0 12px 20px;padding:0">${items.map((i) => `<li>${escape(i)}</li>`).join('')}</ul>`
      : `<p style="margin:4px 0 12px 0;color:#666">${empty}</p>`;

  const heading = (text: string) =>
    `<h2 style="font-size:15px;margin:18px 0 4px 0;border-bottom:1px solid #e5e5e5;padding-bottom:4px">${escape(text)}</h2>`;

  const rows = [
    ...content.completed.map((t) => `<strong>Done</strong> — ${escape(t.task)} (${escape(t.project)}): ${escape(t.summary)}`),
    ...content.inProgress.map((t) => `<strong>In progress</strong> — ${escape(t.task)} (${escape(t.project)}): ${escape(t.stage)}`),
    ...content.blocked.map((t) => `<strong>Blocked</strong> — ${escape(t.task)} (${escape(t.project)}): ${escape(t.blocker)}`),
  ];

  return [
    `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1a1a1a;max-width:680px">`,
    heading('Overnight Summary'),
    `<p style="margin:4px 0">${content.completed.length} completed · ${content.inProgress.length} in progress · ${content.blocked.length} blocked</p>`,
    rows.length
      ? `<ul style="margin:4px 0 12px 20px;padding:0">${rows.map((r) => `<li>${r}</li>`).join('')}</ul>`
      : `<p style="color:#666">Nothing ran overnight.</p>`,
    heading('What Changed'),
    list(content.whatChanged, 'Nothing was changed.'),
    heading('Pull Requests'),
    content.pullRequests.length
      ? `<ul style="margin:4px 0 12px 20px;padding:0">${content.pullRequests
          .map(
            (pr) =>
              `<li><a href="${escape(pr.url)}">${escape(pr.title)}</a> — ${escape(pr.summary)}</li>`,
          )
          .join('')}</ul>`
      : `<p style="color:#666">None opened.</p>`,
    heading('Decisions Needed'),
    list(content.decisionsNeeded),
    heading('Exceptions / Anomalies'),
    list(content.exceptions),
    heading('Low-Confidence Assumptions'),
    list(
      content.lowConfidenceAssumptions.map(
        (a) => `${a.statement} (${(a.confidence * 100).toFixed(0)}%, ${a.task})`,
      ),
      'None below the threshold.',
    ),
    heading('Estimated Human Hours'),
    `<p style="margin:4px 0 12px 0">~${content.estimatedHumanHours.total}h in total. Rough order-of-magnitude estimate only.</p>`,
    heading('AI Usage'),
    `<p style="margin:4px 0 12px 0">${escape(content.usage.label)}</p>`,
    heading('monday.com'),
    `<p style="margin:4px 0 12px 0">${content.monday.itemsUpdated} item(s) updated · ${content.monday.statusChanges} status change(s) · ${content.monday.updatesPosted} update(s) posted${
      content.monday.failures > 0 ? ` · ${content.monday.failures} failed or refused` : ''
    }</p>`,
    `<p style="margin-top:20px;color:#666;font-size:12px">Full detail, logs and the Q&amp;A record: <a href="${escape(content.dashboardUrl)}">${escape(content.dashboardUrl)}</a><br>Mac does not merge his own work. Every pull request above is waiting for a human.</p>`,
    `</div>`,
  ].join('');
}
