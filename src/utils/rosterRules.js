export const MIN_REST_HOURS = 11;
const HOUR = 3600 * 1000;

export function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Real start/end instants of a shift worked on dateStr. Night shifts end the next day.
export function shiftWindow(dateStr, startTime, endTime) {
  const start = new Date(`${dateStr}T${startTime}Z`);
  let end = new Date(`${dateStr}T${endTime}Z`);
  if (end <= start) end = new Date(end.getTime() + 24 * HOUR);
  return { start, end };
}

// Returns an array of human-readable problems. Empty array = assignment is allowed.
export async function findConflicts(db, { empId, shiftId, rosterDate, excludeRosterId = 0 }) {
  const problems = [];

  const [[emp]] = await db.query('SELECT is_active FROM employee WHERE emp_id = ?', [empId]);
  if (!emp) return ['Employee does not exist'];
  if (!emp.is_active) return ['Employee is deactivated'];

  const [[shift]] = await db.query(
    'SELECT start_time, end_time FROM shift WHERE shift_id = ?', [shiftId]
  );
  if (!shift) return ['Shift does not exist'];

  // Rule 1: already has a shift that day
  const [sameDay] = await db.query(
    'SELECT roster_id FROM duty_roster WHERE emp_id = ? AND roster_date = ? AND roster_id <> ?',
    [empId, rosterDate, excludeRosterId]
  );
  if (sameDay.length) problems.push('Employee is already rostered on this date');

  // Rule 3: approved leave
  const [leave] = await db.query(
    `SELECT leave_id FROM leave_request
     WHERE emp_id = ? AND status = 'APPROVED' AND ? BETWEEN from_date AND to_date`,
    [empId, rosterDate]
  );
  if (leave.length) problems.push('Employee is on approved leave on this date');

  // Rule 2: rest period against the previous and next day's shifts
  const prev = addDays(rosterDate, -1);
  const next = addDays(rosterDate, 1);
  const [neighbours] = await db.query(
    `SELECT r.roster_date, s.start_time, s.end_time
     FROM duty_roster r JOIN shift s ON s.shift_id = r.shift_id
     WHERE r.emp_id = ? AND r.roster_date IN (?, ?)
       AND r.roster_id <> ? AND r.status <> 'CANCELLED'`,
    [empId, prev, next, excludeRosterId]
  );

  const mine = shiftWindow(rosterDate, shift.start_time, shift.end_time);
  for (const nb of neighbours) {
    const other = shiftWindow(nb.roster_date, nb.start_time, nb.end_time);
    const gapHours = nb.roster_date === prev
      ? (mine.start - other.end) / HOUR
      : (other.start - mine.end) / HOUR;
    if (gapHours < MIN_REST_HOURS) {
      problems.push(
        `Only ${Math.max(gapHours, 0).toFixed(0)}h rest between this and the shift on ${nb.roster_date} (minimum ${MIN_REST_HOURS}h)`
      );
    }
  }

  return problems;
}

// Active employees who could take this shift. Used for suggestions.
export async function findAvailableEmployees(db, { rosterDate, shiftId, excludeEmpId = 0 }) {
  const [emps] = await db.query(
    `SELECT emp_id, first_name, last_name, position FROM employee
     WHERE is_active = 1 AND emp_id <> ? ORDER BY last_name, first_name`,
    [excludeEmpId]
  );
  const available = [];
  for (const e of emps) {
    const problems = await findConflicts(db, { empId: e.emp_id, shiftId, rosterDate });
    if (problems.length === 0) available.push(e);
  }
  return available;
}