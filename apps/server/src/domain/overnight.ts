/**
 * Overnight cutoff arithmetic (spec §3, §26).
 *
 * The normal hard stop is 08:00 Australia/Sydney, and it must be configurable.
 * Sydney observes daylight saving, so a fixed UTC offset would drift by an hour
 * twice a year and silently let an overnight run continue past its cutoff. All
 * arithmetic therefore goes through the IANA zone database via Intl, with no
 * date library and no hard-coded offsets.
 */

export interface CutoffConfig {
  /** IANA timezone name, e.g. "Australia/Sydney". */
  timezone: string;
  /** Wall-clock time in that zone, "HH:MM" 24-hour. */
  overnightCutoff: string;
}

const CUTOFF_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseCutoff(cutoff: string): { hour: number; minute: number } {
  const match = CUTOFF_PATTERN.exec(cutoff);
  if (!match) throw new Error(`Invalid overnight cutoff "${cutoff}". Expected HH:MM in 24-hour form.`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock fields of an instant, as observed in `timezone`. */
interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(instantMs: number, timezone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const out: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(instantMs))) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return {
    year: out.year!,
    month: out.month!,
    day: out.day!,
    hour: out.hour!,
    minute: out.minute!,
    second: out.second!,
  };
}

/** Offset of `timezone` from UTC, in milliseconds, at a given instant. */
function offsetMsAt(instantMs: number, timezone: string): number {
  const p = zonedParts(instantMs, timezone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUtc - instantMs;
}

/**
 * Converts a wall-clock time in `timezone` to a UTC instant.
 *
 * Converged iteratively because the offset depends on the very instant we are
 * trying to find. Two passes settle every real case; a third guards against a
 * wall-clock time that falls inside a DST spring-forward gap, where we
 * deliberately land on the instant just after the gap rather than throwing —
 * a cutoff that does not exist on one particular night should still stop work.
 */
export function zonedWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  let instant = naive - offsetMsAt(naive, timezone);
  for (let i = 0; i < 2; i += 1) {
    const corrected = naive - offsetMsAt(instant, timezone);
    if (corrected === instant) break;
    instant = corrected;
  }
  return instant;
}

/**
 * The next occurrence of the cutoff wall-clock time strictly after `from`.
 *
 * This instant is stored on the run when it is queued (`overnight_deadline_at`)
 * rather than recomputed on demand, so the deadline is stable, inspectable, and
 * does not move if an operator edits settings while a run is in flight.
 */
export function nextCutoffAfter(from: Date, cfg: CutoffConfig): Date {
  const { hour, minute } = parseCutoff(cfg.overnightCutoff);
  const fromMs = from.getTime();
  const local = zonedParts(fromMs, cfg.timezone);

  let candidate = zonedWallClockToUtc(local.year, local.month, local.day, hour, minute, cfg.timezone);
  if (candidate <= fromMs) {
    // Step to the next calendar day in the target zone, not in UTC.
    const nextDay = new Date(Date.UTC(local.year, local.month - 1, local.day) + 24 * 60 * 60 * 1000);
    candidate = zonedWallClockToUtc(
      nextDay.getUTCFullYear(),
      nextDay.getUTCMonth() + 1,
      nextDay.getUTCDate(),
      hour,
      minute,
      cfg.timezone,
    );
  }
  return new Date(candidate);
}

/** The most recent occurrence of the cutoff at or before `from`. */
export function previousCutoffAtOrBefore(from: Date, cfg: CutoffConfig): Date {
  const { hour, minute } = parseCutoff(cfg.overnightCutoff);
  const fromMs = from.getTime();
  const local = zonedParts(fromMs, cfg.timezone);

  let candidate = zonedWallClockToUtc(local.year, local.month, local.day, hour, minute, cfg.timezone);
  if (candidate > fromMs) {
    const prevDay = new Date(Date.UTC(local.year, local.month - 1, local.day) - 24 * 60 * 60 * 1000);
    candidate = zonedWallClockToUtc(
      prevDay.getUTCFullYear(),
      prevDay.getUTCMonth() + 1,
      prevDay.getUTCDate(),
      hour,
      minute,
      cfg.timezone,
    );
  }
  return new Date(candidate);
}

/**
 * The current "night window": [previous cutoff, next cutoff).
 * Used as the accounting period for the nightly budget (spec §25).
 */
export function currentNightWindow(now: Date, cfg: CutoffConfig): { start: Date; end: Date } {
  const start = previousCutoffAtOrBefore(now, cfg);
  const end = nextCutoffAfter(start, cfg);
  return { start, end };
}

/** True when an overnight run holding this deadline must now stop. */
export function isPastDeadline(now: Date, deadline: Date | null): boolean {
  if (!deadline) return false;
  return now.getTime() >= deadline.getTime();
}
