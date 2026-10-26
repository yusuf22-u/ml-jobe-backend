import pool from '../config/db.js';
import { isValidDate, addDays } from '../utils/rosterRules.js';
import { computeStatus } from '../utils/attendanceRules.js';
import { toCsv } from '../utils/csv.js';

const ANNUAL_ALLOWANCE_DAYS = 30; // keep in sync with leaveController
const todayStr = () => new Date().toISOString().slice(0, 10);

function parseRange(req, res, defaults = null) {
  let { from, to } = req.query;
  if (!from && !to && defaults) ({ from, to } = defaults);
  if (!isValidDate(from) || !isValidDate(to)) {
    res.status(400).json({ message: 'from and to must be valid dates (YYYY-MM-DD)' });
    return null;
  }
  if (to < from) { res.status(400).json({ message: '"to" cannot be before "from"' }); return null; }
  if (addDays(from, 62) < to) { res.status(400).json({ message: 'Date range cannot exceed 62 days' }); return null; }
  return { from, to };
}

function respond(req, res, rows, columns, name, range) {
  if (req.query.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}_${range.from}_${range.to}.csv"`);
    return res.send(toCsv(rows, columns));
  }
  res.json(rows);
}

async function loadAttendanceRows(from, to, deptId) {
  let sql = `
    SELECT r.roster_id, r.roster_date, e.emp_id, e.first_name, e.last_name,
           d.name AS department, s.shift_name, s.start_time, s.end_time,
           a.clock_in, a.clock_out
    FROM duty_roster r
    JOIN employee e   ON e.emp_id = r.emp_id
    JOIN department d ON d.dept_id = e.dept_id
    JOIN shift s      ON s.shift_id = r.shift_id
    LEFT JOIN attendance a ON a.roster_id = r.roster_id
    WHERE r.roster_date BETWEEN ? AND ? AND r.status <> 'CANCELLED'`;
  const params = [from, to];
  if (deptId) { sql += ' AND e.dept_id = ?'; params.push(deptId); }
  sql += ' ORDER BY r.roster_date, s.start_time, e.last_name';
  const [rows] = await pool.query(sql, params);
  const now = new Date();
  return rows.map((r) => ({ ...r, ...computeStatus(r, now) }));
}

// GET /api/reports/staffing?from=&to=&onlyUnderstaffed=1&format=csv
export async function staffingReport(req, res) {
  const range = parseRange(req, res);
  if (!range) return;
  try {
    const [shifts] = await pool.query(
      'SELECT shift_id, shift_name, min_staff FROM shift ORDER BY start_time'
    );
    const [counts] = await pool.query(
      `SELECT roster_date, shift_id, COUNT(*) AS assigned
       FROM duty_roster
       WHERE roster_date BETWEEN ? AND ? AND status <> 'CANCELLED'
       GROUP BY roster_date, shift_id`,
      [range.from, range.to]
    );
    const assignedMap = new Map(counts.map((c) => [`${c.roster_date}|${c.shift_id}`, Number(c.assigned)]));

    // Build every date x shift so days with nobody rostered still show up
    const rows = [];
    for (let d = range.from; d <= range.to; d = addDays(d, 1)) {
      for (const s of shifts) {
        const assigned = assignedMap.get(`${d}|${s.shift_id}`) || 0;
        const shortfall = Math.max(0, s.min_staff - assigned);
        rows.push({
          date: d, shift: s.shift_name, required: s.min_staff, assigned, shortfall,
          status: shortfall > 0 ? 'UNDERSTAFFED' : 'OK',
        });
      }
    }
    const result = req.query.onlyUnderstaffed === '1' ? rows.filter((r) => r.status === 'UNDERSTAFFED') : rows;
    respond(req, res, result, [
      { key: 'date', label: 'Date' }, { key: 'shift', label: 'Shift' },
      { key: 'required', label: 'Required' }, { key: 'assigned', label: 'Assigned' },
      { key: 'shortfall', label: 'Shortfall' }, { key: 'status', label: 'Status' },
    ], 'staffing', range);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

// GET /api/reports/attendance-summary?from=&to=&deptId=&format=csv
export async function attendanceSummary(req, res) {
  const range = parseRange(req, res);
  if (!range) return;
  try {
    const rows = await loadAttendanceRows(range.from, range.to, req.query.deptId);
    const byEmp = new Map();

    for (const r of rows) {
      // Skip shifts that haven't concluded yet
      if (r.status === 'UPCOMING' || r.status === 'NOT_CLOCKED_IN') continue;
      if (!byEmp.has(r.emp_id)) {
        byEmp.set(r.emp_id, {
          emp_id: r.emp_id, employee: `${r.first_name} ${r.last_name}`, department: r.department,
          scheduled: 0, attended: 0, late: 0, missing: 0, noClockOut: 0, hoursWorked: 0,
        });
      }
      const e = byEmp.get(r.emp_id);
      e.scheduled += 1;
      if (r.status === 'MISSING') e.missing += 1;
      else e.attended += 1;
      if (r.status === 'LATE') e.late += 1;
      if (r.status === 'NO_CLOCK_OUT') e.noClockOut += 1;
      if (r.workedHours) e.hoursWorked = Math.round((e.hoursWorked + r.workedHours) * 100) / 100;
    }

    const result = [...byEmp.values()]
      .map((e) => ({ ...e, attendanceRate: e.scheduled ? Math.round((e.attended / e.scheduled) * 100) : null }))
      .sort((a, b) => a.employee.localeCompare(b.employee));

    respond(req, res, result, [
      { key: 'employee', label: 'Employee' }, { key: 'department', label: 'Department' },
      { key: 'scheduled', label: 'Shifts scheduled' }, { key: 'attended', label: 'Attended' },
      { key: 'late', label: 'Late' }, { key: 'missing', label: 'Missing' },
      { key: 'noClockOut', label: 'No clock-out' }, { key: 'hoursWorked', label: 'Hours worked' },
      { key: 'attendanceRate', label: 'Attendance %' },
    ], 'attendance_summary', range);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

// GET /api/reports/missing-attendance   (defaults to the last 7 days)
export async function missingAttendance(req, res) {
  const today = todayStr();
  const range = parseRange(req, res, { from: addDays(today, -7), to: today });
  if (!range) return;
  try {
    const rows = await loadAttendanceRows(range.from, range.to, req.query.deptId);
    const result = rows.filter((r) => r.status === 'MISSING').map((r) => ({
      roster_id: r.roster_id, date: r.roster_date, employee: `${r.first_name} ${r.last_name}`,
      department: r.department, shift: r.shift_name, start: r.start_time, end: r.end_time,
    }));
    respond(req, res, result, [
      { key: 'date', label: 'Date' }, { key: 'employee', label: 'Employee' },
      { key: 'department', label: 'Department' }, { key: 'shift', label: 'Shift' },
      { key: 'start', label: 'Start' }, { key: 'end', label: 'End' },
    ], 'missing_attendance', range);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

// GET /api/reports/requests-summary?from=&to=   (requests created in the range)
export async function requestsSummary(req, res) {
  const range = parseRange(req, res);
  if (!range) return;
  try {
    const today = todayStr();
    const [leaveCounts] = await pool.query(
      'SELECT status, COUNT(*) AS n FROM leave_request WHERE DATE(created_at) BETWEEN ? AND ? GROUP BY status',
      [range.from, range.to]
    );
    const [swapCounts] = await pool.query(
      'SELECT status, COUNT(*) AS n FROM shift_swap_request WHERE DATE(created_at) BETWEEN ? AND ? GROUP BY status',
      [range.from, range.to]
    );
    const [onLeaveToday] = await pool.query(
      `SELECT e.emp_id, CONCAT(e.first_name, ' ', e.last_name) AS employee, d.name AS department,
              l.leave_type, l.from_date, l.to_date
       FROM leave_request l
       JOIN employee e   ON e.emp_id = l.emp_id
       JOIN department d ON d.dept_id = e.dept_id
       WHERE l.status = 'APPROVED' AND ? BETWEEN l.from_date AND l.to_date
       ORDER BY e.last_name`,
      [today]
    );
    const tally = (list) => {
      const t = { PENDING: 0, APPROVED: 0, REJECTED: 0 };
      for (const r of list) t[r.status] = Number(r.n);
      return t;
    };
    res.json({ from: range.from, to: range.to, leave: tally(leaveCounts), swaps: tally(swapCounts), onLeaveToday });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

// GET /api/dashboard   (any logged-in user; content depends on role)
export async function dashboard(req, res) {
  const today = todayStr();
  try {
    if (req.user.role === 'EMPLOYEE') {
      const year = Number(today.slice(0, 4));
      const [[next], [[pl]], [[ps]], [[used]]] = await Promise.all([
        pool.query(
          `SELECT r.roster_id, r.roster_date, s.shift_name, s.start_time, s.end_time
           FROM duty_roster r JOIN shift s ON s.shift_id = r.shift_id
           WHERE r.emp_id = ? AND r.roster_date >= ? AND r.status = 'SCHEDULED'
           ORDER BY r.roster_date, s.start_time LIMIT 3`,
          [req.user.empId, today]
        ),
        pool.query("SELECT COUNT(*) AS n FROM leave_request WHERE emp_id = ? AND status = 'PENDING'", [req.user.empId]),
        pool.query(
          "SELECT COUNT(*) AS n FROM shift_swap_request WHERE status = 'PENDING' AND (requested_by = ? OR swap_with = ?)",
          [req.user.empId, req.user.empId]
        ),
        pool.query(
          `SELECT COALESCE(SUM(DATEDIFF(to_date, from_date) + 1), 0) AS n FROM leave_request
           WHERE emp_id = ? AND leave_type = 'ANNUAL' AND status IN ('PENDING','APPROVED') AND YEAR(from_date) = ?`,
          [req.user.empId, year]
        ),
      ]);
      return res.json({
        view: 'EMPLOYEE',
        nextShifts: next,
        pendingLeave: Number(pl.n),
        pendingSwaps: Number(ps.n),
        leaveBalance: { allowance: ANNUAL_ALLOWANCE_DAYS, used: Number(used.n), remaining: ANNUAL_ALLOWANCE_DAYS - Number(used.n) },
      });
    }

    // Management view (supervisor, HR admin, plant manager)
    const [[shifts], [counts], [[emp]], [[pl]], [[ps]], [[ol]], missingRows] = await Promise.all([
      pool.query('SELECT shift_id, shift_name, min_staff FROM shift ORDER BY start_time'),
      pool.query(
        `SELECT shift_id, COUNT(*) AS assigned FROM duty_roster
         WHERE roster_date = ? AND status <> 'CANCELLED' GROUP BY shift_id`, [today]
      ),
      pool.query('SELECT COUNT(*) AS n FROM employee WHERE is_active = 1'),
      pool.query("SELECT COUNT(*) AS n FROM leave_request WHERE status = 'PENDING'"),
      pool.query("SELECT COUNT(*) AS n FROM shift_swap_request WHERE status = 'PENDING'"),
      pool.query(
        "SELECT COUNT(*) AS n FROM leave_request WHERE status = 'APPROVED' AND ? BETWEEN from_date AND to_date", [today]
      ),
      loadAttendanceRows(addDays(today, -7), today),
    ]);
    const assignedMap = new Map(counts.map((c) => [c.shift_id, Number(c.assigned)]));

    res.json({
      view: 'MANAGEMENT',
      date: today,
      todayStaffing: shifts.map((s) => {
        const assigned = assignedMap.get(s.shift_id) || 0;
        return {
          shift: s.shift_name, required: s.min_staff, assigned,
          status: assigned < s.min_staff ? 'UNDERSTAFFED' : 'OK',
        };
      }),
      activeEmployees: Number(emp.n),
      pendingLeave: Number(pl.n),
      pendingSwaps: Number(ps.n),
      onLeaveToday: Number(ol.n),
      missingAttendanceLast7Days: missingRows.filter((r) => r.status === 'MISSING').length,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}