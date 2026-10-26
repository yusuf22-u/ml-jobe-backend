import pool from '../config/db.js';
import { isValidDate, addDays } from '../utils/rosterRules.js';

const LEAVE_TYPES = ['ANNUAL', 'SICK', 'CASUAL', 'OTHER'];
const STATUSES = ['PENDING', 'APPROVED', 'REJECTED'];
export const ANNUAL_ALLOWANCE_DAYS = 30; // confirm with NAWEC HR
const MAX_LEAVE_DAYS = 90;
const SICK_BACKDATE_DAYS = 7;

const todayStr = () => new Date().toISOString().slice(0, 10);
const dayCount = (from, to) =>
  Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000) + 1;

async function annualDaysUsed(db, empId, year) {
  const [[row]] = await db.query(
    `SELECT COALESCE(SUM(DATEDIFF(to_date, from_date) + 1), 0) AS used
     FROM leave_request
     WHERE emp_id = ? AND leave_type = 'ANNUAL'
       AND status IN ('PENDING','APPROVED') AND YEAR(from_date) = ?`,
    [empId, year]
  );
  return Number(row.used);
}

const SELECT_LEAVE = `
  SELECT l.leave_id, l.leave_type, l.from_date, l.to_date, l.reason, l.status,
         l.created_at, l.reviewed_at,
         DATEDIFF(l.to_date, l.from_date) + 1 AS days,
         (SELECT COUNT(*) FROM duty_roster r
           WHERE r.emp_id = l.emp_id
             AND r.roster_date BETWEEN l.from_date AND l.to_date
             AND r.status = 'SCHEDULED'
             AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.roster_id = r.roster_id)
         ) AS shifts_affected,
         e.emp_id, e.first_name, e.last_name, d.name AS department,
         CONCAT(rv.first_name, ' ', rv.last_name) AS reviewed_by_name
  FROM leave_request l
  JOIN employee e   ON e.emp_id = l.emp_id
  JOIN department d ON d.dept_id = e.dept_id
  LEFT JOIN user ru     ON ru.user_id = l.reviewed_by
  LEFT JOIN employee rv ON rv.emp_id = ru.emp_id`;
// POST /api/leave
export async function submitLeave(req, res) {
  const { leaveType, fromDate, toDate, reason = null } = req.body;

  if (!LEAVE_TYPES.includes(leaveType)) return res.status(400).json({ message: 'Invalid leave type' });
  if (!isValidDate(fromDate) || !isValidDate(toDate)) {
    return res.status(400).json({ message: 'fromDate and toDate must be valid dates (YYYY-MM-DD)' });
  }
  if (toDate < fromDate) return res.status(400).json({ message: 'End date cannot be before start date' });
  if (fromDate.slice(0, 4) !== toDate.slice(0, 4)) {
    return res.status(400).json({ message: 'Leave cannot span two calendar years. Submit two requests.' });
  }
  if (reason && reason.length > 255) return res.status(400).json({ message: 'Reason is too long (max 255 characters)' });

  const today = todayStr();
  const earliest = leaveType === 'SICK' ? addDays(today, -SICK_BACKDATE_DAYS) : today;
  if (fromDate < earliest) {
    return res.status(400).json({
      message: leaveType === 'SICK'
        ? `Sick leave can be back-dated by at most ${SICK_BACKDATE_DAYS} days`
        : 'Leave cannot start in the past',
    });
  }

  const days = dayCount(fromDate, toDate);
  if (days > MAX_LEAVE_DAYS) return res.status(400).json({ message: `Leave cannot exceed ${MAX_LEAVE_DAYS} days` });

  try {
    const [overlap] = await pool.query(
      `SELECT leave_id FROM leave_request
       WHERE emp_id = ? AND status IN ('PENDING','APPROVED') AND from_date <= ? AND to_date >= ?`,
      [req.user.empId, toDate, fromDate]
    );
    if (overlap.length) {
      return res.status(409).json({ message: 'You already have a pending or approved leave request overlapping these dates' });
    }

    if (leaveType === 'ANNUAL') {
      const used = await annualDaysUsed(pool, req.user.empId, Number(fromDate.slice(0, 4)));
      const remaining = ANNUAL_ALLOWANCE_DAYS - used;
      if (days > remaining) {
        return res.status(400).json({ message: `Only ${remaining} day(s) of annual leave remaining; you requested ${days}` });
      }
    }

    const [r] = await pool.query(
      'INSERT INTO leave_request (emp_id, leave_type, from_date, to_date, reason) VALUES (?, ?, ?, ?, ?)',
      [req.user.empId, leaveType, fromDate, toDate, reason]
    );
    res.status(201).json({ leave_id: r.insertId, days, message: 'Leave request submitted for approval' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

// GET /api/leave/balance?year=2026
export async function leaveBalance(req, res) {
  try {
    const year = Number(req.query.year) || new Date().getUTCFullYear();
    const used = await annualDaysUsed(pool, req.user.empId, year);
    res.json({ year, allowance: ANNUAL_ALLOWANCE_DAYS, used, remaining: ANNUAL_ALLOWANCE_DAYS - used });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

// GET /api/leave/mine
export async function myLeave(req, res) {
  try {
    const [rows] = await pool.query(
      SELECT_LEAVE + ' WHERE l.emp_id = ? ORDER BY l.created_at DESC, l.leave_id DESC', [req.user.empId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

// GET /api/leave?status=PENDING
export async function listLeave(req, res) {
  const { status } = req.query;
  if (status && !STATUSES.includes(status)) return res.status(400).json({ message: 'Invalid status filter' });
  try {
    let sql = SELECT_LEAVE;
    const params = [];
    if (status) { sql += ' WHERE l.status = ?'; params.push(status); }
    sql += ' ORDER BY l.created_at DESC, l.leave_id DESC LIMIT 200';
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

// DELETE /api/leave/:id  (employee withdraws their own pending request)
export async function cancelLeave(req, res) {
  try {
    const [r] = await pool.query(
      "DELETE FROM leave_request WHERE leave_id = ? AND emp_id = ? AND status = 'PENDING'",
      [req.params.id, req.user.empId]
    );
    if (r.affectedRows === 0) return res.status(404).json({ message: 'No pending request of yours found with that ID' });
    res.json({ message: 'Leave request cancelled' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

// PUT /api/leave/:id/review   body: { decision: 'APPROVED' | 'REJECTED' }
export async function reviewLeave(req, res) {
  const { decision } = req.body;
  if (!['APPROVED', 'REJECTED'].includes(decision)) {
    return res.status(400).json({ message: 'decision must be APPROVED or REJECTED' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // FOR UPDATE locks the row so two reviewers can't act on it at once
    const [[lr]] = await conn.query('SELECT * FROM leave_request WHERE leave_id = ? FOR UPDATE', [req.params.id]);
    if (!lr) { await conn.rollback(); return res.status(404).json({ message: 'Leave request not found' }); }
    if (lr.status !== 'PENDING') { await conn.rollback(); return res.status(409).json({ message: `Request already ${lr.status.toLowerCase()}` }); }
    if (lr.emp_id === req.user.empId) { await conn.rollback(); return res.status(403).json({ message: 'You cannot review your own request' }); }

    await conn.query(
      'UPDATE leave_request SET status = ?, reviewed_by = ?, reviewed_at = UTC_TIMESTAMP() WHERE leave_id = ?',
      [decision, req.user.userId, lr.leave_id]
    );

    let cancelled = 0;
    if (decision === 'APPROVED') {
      const [r] = await conn.query(
        `UPDATE duty_roster r SET r.status = 'CANCELLED'
         WHERE r.emp_id = ? AND r.roster_date BETWEEN ? AND ? AND r.status = 'SCHEDULED'
           AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.roster_id = r.roster_id)`,
        [lr.emp_id, lr.from_date, lr.to_date]
      );
      cancelled = r.affectedRows;
    }

    await conn.commit();
    res.json({ message: `Leave request ${decision.toLowerCase()}`, rosterEntriesCancelled: cancelled });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  } finally {
    conn.release();
  }
}