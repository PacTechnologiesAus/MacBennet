import { describe, expect, it } from 'vitest';
import {
  currentNightWindow,
  isPastDeadline,
  isValidTimezone,
  nextCutoffAfter,
  parseCutoff,
  previousCutoffAtOrBefore,
  zonedWallClockToUtc,
  type CutoffConfig,
} from '../../src/domain/overnight.js';

const sydney: CutoffConfig = { timezone: 'Australia/Sydney', overnightCutoff: '08:00' };

/** Formats an instant as wall-clock time in a zone, for readable assertions. */
const wallClock = (d: Date, tz: string) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
    .format(d)
    .replace(',', '');

describe('cutoff parsing', () => {
  it('accepts valid 24-hour times', () => {
    expect(parseCutoff('08:00')).toEqual({ hour: 8, minute: 0 });
    expect(parseCutoff('00:00')).toEqual({ hour: 0, minute: 0 });
    expect(parseCutoff('23:59')).toEqual({ hour: 23, minute: 59 });
  });

  it('rejects malformed or out-of-range times', () => {
    for (const bad of ['24:00', '8:00', '08:60', '0800', '', 'morning', '-1:00']) {
      expect(() => parseCutoff(bad), bad).toThrow();
    }
  });

  it('validates timezone names', () => {
    expect(isValidTimezone('Australia/Sydney')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Not/AZone')).toBe(false);
  });
});

describe('next cutoff', () => {
  it('finds the same-day cutoff when it is still ahead', () => {
    // 2026-03-10 02:00 Sydney (AEDT, UTC+11) → 2026-03-09T15:00Z
    const from = new Date('2026-03-09T15:00:00Z');
    const next = nextCutoffAfter(from, sydney);
    expect(wallClock(next, 'Australia/Sydney')).toBe('10/03/2026 08:00');
  });

  it('rolls to the following day when the cutoff has already passed', () => {
    // 2026-03-10 09:00 Sydney → cutoff already gone today.
    const from = new Date('2026-03-09T22:00:00Z');
    const next = nextCutoffAfter(from, sydney);
    expect(wallClock(next, 'Australia/Sydney')).toBe('11/03/2026 08:00');
  });

  it('treats the cutoff instant itself as already passed', () => {
    const cutoff = nextCutoffAfter(new Date('2026-03-09T15:00:00Z'), sydney);
    const next = nextCutoffAfter(cutoff, sydney);
    expect(next.getTime()).toBeGreaterThan(cutoff.getTime());
    expect(wallClock(next, 'Australia/Sydney')).toBe('11/03/2026 08:00');
  });

  it('holds the wall-clock time across the Sydney daylight-saving end', () => {
    // DST ends 2026-04-05 03:00 AEDT → 02:00 AEST. A fixed UTC offset would
    // slip the 08:00 cutoff by an hour; the zone database must not.
    const before = new Date('2026-04-03T12:00:00Z'); // 3 Apr 23:00 Sydney, AEDT
    const across = nextCutoffAfter(before, sydney);
    expect(wallClock(across, 'Australia/Sydney')).toBe('04/04/2026 08:00');
    expect(across.toISOString()).toBe('2026-04-03T21:00:00.000Z'); // UTC+11

    const after = new Date('2026-04-05T12:00:00Z'); // 5 Apr 22:00 Sydney, now AEST
    const nextAfter = nextCutoffAfter(after, sydney);
    expect(wallClock(nextAfter, 'Australia/Sydney')).toBe('06/04/2026 08:00');
    expect(nextAfter.toISOString()).toBe('2026-04-05T22:00:00.000Z'); // UTC+10
  });

  it('holds the wall-clock time across the Sydney daylight-saving start', () => {
    // DST starts 2026-10-04 02:00 AEST → 03:00 AEDT.
    const before = new Date('2026-10-02T12:00:00Z'); // 2 Oct 22:00 Sydney, AEST
    expect(wallClock(nextCutoffAfter(before, sydney), 'Australia/Sydney')).toBe('03/10/2026 08:00');

    const after = new Date('2026-10-04T12:00:00Z'); // 4 Oct 23:00 Sydney, AEDT
    const next = nextCutoffAfter(after, sydney);
    expect(wallClock(next, 'Australia/Sydney')).toBe('05/10/2026 08:00');
    expect(next.toISOString()).toBe('2026-10-04T21:00:00.000Z'); // UTC+11
  });

  it('rolls the month and year correctly', () => {
    const from = new Date('2026-12-31T22:00:00Z'); // 1 Jan 2027 09:00 Sydney
    expect(wallClock(nextCutoffAfter(from, sydney), 'Australia/Sydney')).toBe('02/01/2027 08:00');
  });

  it('works in a northern-hemisphere zone too', () => {
    const london: CutoffConfig = { timezone: 'Europe/London', overnightCutoff: '06:30' };
    const from = new Date('2026-07-01T10:00:00Z'); // BST
    const next = nextCutoffAfter(from, london);
    expect(wallClock(next, 'Europe/London')).toBe('02/07/2026 06:30');
    expect(next.toISOString()).toBe('2026-07-02T05:30:00.000Z');
  });

  it('works in UTC where no offset arithmetic is involved', () => {
    const utc: CutoffConfig = { timezone: 'UTC', overnightCutoff: '08:00' };
    expect(nextCutoffAfter(new Date('2026-05-01T07:00:00Z'), utc).toISOString()).toBe('2026-05-01T08:00:00.000Z');
    expect(nextCutoffAfter(new Date('2026-05-01T09:00:00Z'), utc).toISOString()).toBe('2026-05-02T08:00:00.000Z');
  });
});

describe('previous cutoff and night window', () => {
  it('finds the most recent cutoff at or before an instant', () => {
    const from = new Date('2026-03-09T22:00:00Z'); // 10 Mar 09:00 Sydney
    expect(wallClock(previousCutoffAtOrBefore(from, sydney), 'Australia/Sydney')).toBe('10/03/2026 08:00');
  });

  it('reaches back to the previous day before the cutoff', () => {
    const from = new Date('2026-03-09T15:00:00Z'); // 10 Mar 02:00 Sydney
    expect(wallClock(previousCutoffAtOrBefore(from, sydney), 'Australia/Sydney')).toBe('09/03/2026 08:00');
  });

  it('produces a contiguous 24-hour accounting window', () => {
    const now = new Date('2026-03-09T18:00:00Z');
    const { start, end } = currentNightWindow(now, sydney);
    expect(start.getTime()).toBeLessThanOrEqual(now.getTime());
    expect(end.getTime()).toBeGreaterThan(now.getTime());
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('produces a 23-hour window for the night that contains the daylight-saving start', () => {
    // DST starts 2026-10-04 at 02:00, i.e. inside the window that runs from
    // 3 Oct 08:00 AEST to 4 Oct 08:00 AEDT. That window is genuinely 23 hours
    // long — the reason budget accounting must not assume a fixed 24 hours.
    const now = new Date('2026-10-03T10:00:00Z'); // 3 Oct 20:00 Sydney, still AEST
    const { start, end } = currentNightWindow(now, sydney);
    expect(start.toISOString()).toBe('2026-10-02T22:00:00.000Z'); // 3 Oct 08:00 +10
    expect(end.toISOString()).toBe('2026-10-03T21:00:00.000Z'); // 4 Oct 08:00 +11
    expect(end.getTime() - start.getTime()).toBe(23 * 60 * 60 * 1000);
  });

  it('produces a 25-hour window for the night that contains the daylight-saving end', () => {
    // DST ends 2026-04-05 at 03:00, inside the 4 Apr 08:00 → 5 Apr 08:00 window.
    const now = new Date('2026-04-04T12:00:00Z'); // 4 Apr 23:00 Sydney, AEDT
    const { start, end } = currentNightWindow(now, sydney);
    expect(end.getTime() - start.getTime()).toBe(25 * 60 * 60 * 1000);
  });
});

describe('deadline evaluation', () => {
  it('treats the deadline instant as reached', () => {
    const deadline = new Date('2026-03-10T21:00:00Z');
    expect(isPastDeadline(new Date('2026-03-10T20:59:59Z'), deadline)).toBe(false);
    expect(isPastDeadline(deadline, deadline)).toBe(true);
    expect(isPastDeadline(new Date('2026-03-10T21:00:01Z'), deadline)).toBe(true);
  });

  it('never fires for a run with no deadline (interactive mode)', () => {
    expect(isPastDeadline(new Date('2999-01-01T00:00:00Z'), null)).toBe(false);
  });
});

describe('wall-clock to UTC conversion', () => {
  it('resolves an unambiguous local time', () => {
    expect(new Date(zonedWallClockToUtc(2026, 6, 15, 8, 0, 'Australia/Sydney')).toISOString()).toBe(
      '2026-06-14T22:00:00.000Z',
    );
  });

  it('does not throw on a time inside the spring-forward gap', () => {
    // 2026-10-04 02:30 does not exist in Sydney. We must still return an
    // instant so that a cutoff configured there still stops work.
    const instant = zonedWallClockToUtc(2026, 10, 4, 2, 30, 'Australia/Sydney');
    expect(Number.isFinite(instant)).toBe(true);
  });
});
