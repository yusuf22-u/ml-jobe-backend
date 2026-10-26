import { shiftWindow } from './rosterRules.js';

export const GRACE_MINUTES = 15;
export const EARLY_CLOCK_IN_MINUTES = 60;
export const CLOCK_OUT_WINDOW_HOURS = 4;
const MIN = 60 * 1000;

// mysql2 returns DATETIME as 'YYYY-MM-DD HH:MM:SS' (dateStrings: true). Stored as UTC.
export const parseDbDateTime = (s) => (s ? new Date(s.replace(' ', 'T') + 'Z') : null);

export function computeStatus(row, now = new Date()) {
  const { start, end } = shiftWindow(row.roster_date, row.start_time, row.end_time);
  const cin = parseDbDateTime(row.clock_in);
  const cout = parseDbDateTime(row.clock_out);

  let status;
  let lateMinutes = 0;
  let workedHours = null;

  if (cin) {
    lateMinutes = Math.max(0, Math.round((cin - start) / MIN));
    status = lateMinutes > GRACE_MINUTES ? 'LATE' : 'PRESENT';
    if (cout) {
      workedHours = Math.round(((cout - cin) / 3600000) * 100) / 100;
    } else if (now > new Date(end.getTime() + CLOCK_OUT_WINDOW_HOURS * 60 * MIN)) {
      status = 'NO_CLOCK_OUT';
    }
  } else if (now > end) {
    status = 'MISSING';
  } else if (now >= start) {
    status = 'NOT_CLOCKED_IN';
  } else {
    status = 'UPCOMING';
  }
  return { status, lateMinutes, workedHours };
}