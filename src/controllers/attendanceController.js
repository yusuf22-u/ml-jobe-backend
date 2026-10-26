import pool from '../config/db.js';
import { isValidDate, addDays, shiftWindow } from '../utils/rosterRules.js';
import {
  computeStatus, parseDbDateTime,
  EARLY_CLOCK_IN_MINUTES, CLOCK_OUT_WINDOW_HOURS,
} from '../utils/attendanceRules.js';

const MIN = 60 * 1000;

// The roster entry this employee could be clocking against right now
async function findActiveRoster(db, empId, now) {
  const today = now.toISOString().slice(0, 10);
  const [rows] = await db.query(
    `SELECT r.roster_id, r.roster_date, s.shift_name, s.start_time, s.end_time,
            a.attendance_id, a.clock_in, a.clock_out
     FROM duty_roster r
     JOIN shift s ON s.shift_id = r.shift_id
     LEFT JOIN attendance a ON a.roster_id = r.roster_id
     WHERE r.emp_id = ? AND r.roster_date IN (?, ?) AND r.status <> 'CANCELLED'`,
    [empId, addDays(today, -1), today]
  );
  return rows.find((r) => {
    const { start, end } = shiftWindow(r.roster_date, r.start_time, r.end_time);
    return now >= new Date(start.getTime() - EARLY_CLOCK_IN_MINUTES * MIN)
        && now <= new Date(end.getTime() + CLOCK_OUT_WINDOW_HOURS * 60 * MIN);
  }) || null;
}

// GET /api/attendance/current  -> tells the UI which button to show
export async function currentShift(req, res) {
  try {
    const entry = await findActiveRoster(pool, req.user.empId, new Date());
    if (!entry) return res.json({ state: 'NONE' });
    let state = 'DONE';
    if (!entry.clock_in) state = 'CAN_CLOCK_IN';
    else if (!entry.clock_out) state = 'CAN_CLOCK_OUT';
    res.json({
      state,
      shift: entry.shift_name, date: entry.roster_date,
      start: entry.start_time, end: entry.end_time,
      clockIn: entry.clock_in, clockOut: entry.clock_out,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

// POST /api/attendance/clock-in
export async function clockIn(req, res) {
  try {
    const now = new Date();
    const entry = await findActiveRoster(pool, req.user.empId, now);
    if (!entry) {
      return res.status(400).json({ message: 'You have no scheduled shift to clock in to right now' });
    }
    if (entry.clock_in) return res.status(409).json({ message: 'You have already clocked in for this shift' });

    const { start, end } = shiftWindow(entry.roster_date, entry.start_time, entry.end_time);
    if (now > end) {
      return res.status(400).json({ message: 'This shift has ended. Ask your supervisor to record your attendance.' });
    }

    await pool.query(
      "INSERT INTO attendance (roster_id, clock_in, method) VALUES (?, UTC_TIMESTAMP(), 'SELF')",
      [entry.roster_id]
    );
    res.status(201).json({
      message: 'Clocked in',
      shift: entry.shift_name,
      lateMinutes: Math.max(0, Math.round((now - start) / MIN)),
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Attendance already recorded for this shift' });
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

// POST /api/attendance/clock-out
export async function clockOut(req, res) {
  const conn = await pool.getConnection();
  try {
    const entry = await findActiveRoster(conn, req.user.empId, new Date());
    if (!entry || !entry.clock_in) {
      return res.status(400).json({ message: 'You have not clocked in for a current shift' });
    }
    if (entry.clock_out) return res.status(409).json({ message: 'You have already clocked out' });

    await conn.beginTransaction();
    const [r] = await conn.query(
      'UPDATE attendance SET clock_out = UTC_TIMESTAMP() WHERE attendance_id = ? AND clock_out IS NULL',
      [entry.attendance_id]
    );
    if (r.affectedRows === 0) {
      await conn.rollback();
      return res.status(409).json({ message: 'You have already clocked out' });
    }
    await conn.query("UPDATE duty_roster SET status = 'COMPLETED' WHERE roster_id = ?", [entry.roster_id]);
    await conn.commit();
    res.json({ message: 'Clocked out' });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  } finally {
    conn.release();
  }
}

// PUT /api/attendance/manual   body: { rosterId, clockIn, clockOut? }  e.g. "2026-10-05T06:10"
const DT_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}$/;
const toDb = (s) => s.replace('T', ' ') + ':00';

export async function manualEntry(req, res) {
  const { rosterId, clockIn, clockOut } = req.body;
  if (!rosterId || !DT_RE.test(clockIn || '') || (clockOut && !DT_RE.test(clockOut))) {
    return res.status(400).json({ message: 'rosterId and clockIn (YYYY-MM-DDTHH:MM) are required; clockOut is optional' });
  }
  const cin = parseDbDateTime(toDb(clockIn));
  const cout = clockOut ? parseDbDateTime(toDb(clockOut)) : null;
  if (isNaN(cin) || (cout && isNaN(cout))) return res.status(400).json({ message: 'Invalid date/time' });
  if (cout && cout <= cin) return res.status(400).json({ message: 'Clock-out must be after clock-in' });
  if (cin > new Date() || (cout && cout > new Date())) {
    return res.status(400).json({ message: 'Times cannot be in the future' });
  }

  const conn = await pool.getConnection();
  try {
    const [[entry]] = await conn.query(
      `SELECT r.roster_id, r.roster_date, r.status, s.start_time, s.end_time
       FROM duty_roster r JOIN shift s ON s.shift_id = r.shift_id WHERE r.roster_id = ?`,
      [rosterId]
    );
    if (!entry) return res.status(404).json({ message: 'Roster entry not found' });
    if (entry.status === 'CANCELLED') return res.status(409).json({ message: 'This roster entry is cancelled' });

    // Sanity check: the times must be near the shift (within 12h either side)
    const { start, end } = shiftWindow(entry.roster_date, entry.start_time, entry.end_time);
    const lo = new Date(start.getTime() - 12 * 60 * MIN);
    const hi = new Date(end.getTime() + 12 * 60 * MIN);
    if (cin < lo || cin > hi || (cout && (cout < lo || cout > hi))) {
      return res.status(400).json({ message: 'Times are too far from the scheduled shift' });
    }

    await conn.beginTransaction();
    await conn.query(
      `INSERT INTO attendance (roster_id, clock_in, clock_out, method, recorded_by)
       VALUES (?, ?, ?, 'MANUAL', ?)
       ON DUPLICATE KEY UPDATE clock_in = VALUES(clock_in), clock_out = VALUES(clock_out),
                               method = 'MANUAL', recorded_by = VALUES(recorded_by)`,
      [rosterId, toDb(clockIn), clockOut ? toDb(clockOut) : null, req.user.userId]
    );
    await conn.query('UPDATE duty_roster SET status = ? WHERE roster_id = ?',
      [clockOut ? 'COMPLETED' : 'SCHEDULED', rosterId]);
    await conn.commit();
    res.json({ message: 'Attendance recorded' });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  } finally {
    conn.release();
  }
}

// GET /api/attendance?from=&to=&deptId=&status=
export async function listAttendance(req, res) {
  const { from, to, deptId, status } = req.query;
  if (!isValidDate(from) || !isValidDate(to)) {
    return res.status(400).json({ message: 'from and to must be valid dates (YYYY-MM-DD)' });
  }
  if (to < from) return res.status(400).json({ message: '"to" cannot be before "from"' });
  if (addDays(from, 62) < to) return res.status(400).json({ message: 'Date range cannot exceed 62 days' });

  let sql = `
    SELECT r.roster_id, r.roster_date, e.emp_id, e.first_name, e.last_name,
           d.name AS department, s.shift_name, s.start_time, s.end_time,
           a.clock_in, a.clock_out, a.method
    FROM duty_roster r
    JOIN employee e   ON e.emp_id = r.emp_id
    JOIN department d ON d.dept_id = e.dept_id
    JOIN shift s      ON s.shift_id = r.shift_id
    LEFT JOIN attendance a ON a.roster_id = r.roster_id
    WHERE r.roster_date BETWEEN ? AND ? AND r.status <> 'CANCELLED'`;
  const params = [from, to];
  if (deptId) { sql += ' AND e.dept_id = ?'; params.push(deptId); }
  sql += ' ORDER BY r.roster_date, s.start_time, e.last_name';

  try {
    const [rows] = await pool.query(sql, params);
    const now = new Date();
    let result = rows.map((r) => ({ ...r, ...computeStatus(r, now) }));
    if (status) result = result.filter((r) => r.status === String(status).toUpperCase());
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}
// GET /api/attendance/mine?from=&to=   (an employee's own history, default last 30 days)
export async function myAttendance(req, res) {
  const today = new Date().toISOString().slice(0, 10);
  const from = isValidDate(req.query.from) ? req.query.from : addDays(today, -30);
  const to = isValidDate(req.query.to) ? req.query.to : today;
  if (to < from) return res.status(400).json({ message: '"to" cannot be before "from"' });
  if (addDays(from, 62) < to) return res.status(400).json({ message: 'Date range cannot exceed 62 days' });

  try {
    const [rows] = await pool.query(
      `SELECT r.roster_id, r.roster_date, s.shift_name, s.start_time, s.end_time,
              a.clock_in, a.clock_out, a.method
       FROM duty_roster r
       JOIN shift s ON s.shift_id = r.shift_id
       LEFT JOIN attendance a ON a.roster_id = r.roster_id
       WHERE r.emp_id = ? AND r.roster_date BETWEEN ? AND ? AND r.status <> 'CANCELLED'
       ORDER BY r.roster_date DESC, s.start_time`,
      [req.user.empId, from, to]
    );
    const now = new Date();
    res.json(rows.map((r) => ({ ...r, ...computeStatus(r, now) })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}