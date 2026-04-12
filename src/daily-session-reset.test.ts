import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { msUntilNextMidnight, startDailySessionReset } from './daily-session-reset.js';

describe('msUntilNextMidnight', () => {
  it('returns a value in (0, 86400000]', () => {
    const ms = msUntilNextMidnight('UTC');
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(86_400_000);
  });

  it('returns smaller value closer to midnight', () => {
    vi.useFakeTimers();
    try {
      // 23:50 UTC → 10 minutes until midnight
      vi.setSystemTime(new Date('2026-04-12T23:50:00.000Z'));
      const nearMidnight = msUntilNextMidnight('UTC');

      // 08:00 UTC → 16 hours until midnight
      vi.setSystemTime(new Date('2026-04-12T08:00:00.000Z'));
      const morning = msUntilNextMidnight('UTC');

      expect(nearMidnight).toBeLessThan(morning);
      expect(nearMidnight).toBeLessThanOrEqual(10 * 60 * 1000);
      expect(morning).toBeGreaterThanOrEqual(15 * 3600 * 1000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('respects timezone offset', () => {
    vi.useFakeTimers();
    try {
      // 20:00 UTC = 23:00 Moscow (UTC+3) → 1h to midnight in Moscow
      vi.setSystemTime(new Date('2026-04-12T20:00:00.000Z'));
      const msMoscow = msUntilNextMidnight('Europe/Moscow');

      // 20:00 UTC → 4h to midnight in UTC
      const msUtc = msUntilNextMidnight('UTC');

      expect(msMoscow).toBeLessThan(msUtc);
      expect(msMoscow).toBeLessThanOrEqual(1 * 3600 * 1000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('startDailySessionReset', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears all sessions when timer fires', () => {
    const sessions: Record<string, string> = {
      telegram_main: 'session-abc',
      slack_dev: 'session-xyz',
    };
    const cleared: string[] = [];

    startDailySessionReset(
      () => sessions,
      (folder) => {
        delete sessions[folder];
        cleared.push(folder);
      },
    );

    // Advance past the first midnight
    vi.advanceTimersByTime(86_400_000);

    expect(cleared).toContain('telegram_main');
    expect(cleared).toContain('slack_dev');
    expect(Object.keys(sessions)).toHaveLength(0);
  });

  it('is a no-op when no sessions exist', () => {
    const sessions: Record<string, string> = {};
    const cleared: string[] = [];

    startDailySessionReset(
      () => sessions,
      (folder) => cleared.push(folder),
    );

    vi.advanceTimersByTime(86_400_000);

    expect(cleared).toHaveLength(0);
  });

  it('reschedules after each reset', () => {
    const sessions: Record<string, string> = {};
    let resetCount = 0;

    startDailySessionReset(
      () => {
        resetCount++;
        return sessions;
      },
      () => {},
    );

    // Advance through 3 midnights
    vi.advanceTimersByTime(86_400_000 * 3);

    expect(resetCount).toBe(3);
  });
});
