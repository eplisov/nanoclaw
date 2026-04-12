import { TIMEZONE } from './config.js';
import { logger } from './logger.js';

const MS_IN_DAY = 24 * 60 * 60 * 1000;

export function msUntilNextMidnight(timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date());

  const get = (type: string) =>
    parseInt(parts.find((p) => p.type === type)!.value, 10);

  const hours = get('hour') % 24;
  const minutes = get('minute');
  const seconds = get('second');

  const elapsedMs = (hours * 3600 + minutes * 60 + seconds) * 1000;
  return MS_IN_DAY - elapsedMs;
}

export function startDailySessionReset(
  getSessions: () => Record<string, string>,
  clearSession: (groupFolder: string) => void,
): void {
  function scheduleNext(): void {
    const delayMs = msUntilNextMidnight(TIMEZONE);
    const delayHours = (delayMs / 3_600_000).toFixed(1);

    logger.info(
      { timezone: TIMEZONE, delayHours },
      'Daily session reset scheduled',
    );

    setTimeout(() => {
      performReset();
      scheduleNext();
    }, delayMs);
  }

  function performReset(): void {
    const sessions = getSessions();
    const folders = Object.keys(sessions);

    if (folders.length === 0) {
      logger.info('Daily session reset: no active sessions');
      return;
    }

    for (const folder of folders) {
      clearSession(folder);
    }

    logger.info(
      { resetCount: folders.length, folders },
      'Daily session reset completed',
    );
  }

  scheduleNext();
}
