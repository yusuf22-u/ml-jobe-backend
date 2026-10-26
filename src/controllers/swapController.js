import pool from '../config/db.js';
import { findConflicts } from '../utils/rosterRules.js';

const STATUSES = ['PENDING', 'APPROVED', 'REJECTED'];
const PARK_DATE = '1000-01-01'; // temporary date used while two rows trade owners
const todayStr = () => new Date().toISOString().slice(0, 10);

async function loadRoster(db, id, lock = false) {
  const [[row]] = await db.query(
    `SELECT r.roster_id, r.emp_id, r.shift_id, r.roster_date, r.status,
            (SELECT COUNT(*) FROM attendance a WHERE a.roster_id = r.roster_id) AS has_attendance
     FROM duty_roster r WHERE r.roster_id = ?${lock ? ' FOR UPDATE' : ''}`,
    [id]
  );
  return row || null;
}

function swappableProblem(row, today) {
  if (!row) return 'Roster entry not found';
  if (row.status !== 'SCHEDULED' || row.has_attendance > 0) return 'Only scheduled shifts without attendance can be swapped';
  if (row.roster_date < today) return 'Cannot swap a shift in the past';
  return null;
}

// Applies the swap on `conn` (inside a transaction the caller controls) and returns
// a list of rule violations. The caller decides whether to commit or roll back.
async function applyAndCheck(conn, mine, theirs, colleagueId) {
  const problems = [];
  try {
    if (theirs) {
      // EXCHANGE: trade owners; park one row first so the unique (emp_id, roster_date) key never clashes
      await conn.query('UPDATE duty_roster SET roster_date = ? WHERE roster_id = ?', [PARK_DATE, mine.roster_id]);
      await conn.query('UPDATE duty_roster SET emp_id = ? WHERE roster_id = ?', [mine.emp_id, theirs.roster_id]);
      await conn.query('UPDATE duty_roster SET emp_id = ?, roster_date = ? WHERE roster_id = ?',
        [colleagueId, mine.roster_date, mine.roster_id]);

      for (const p of await findConflicts(conn, {
        empId: mine.emp_id, shiftId: theirs.shift_id, rosterDate: theirs.roster_date, excludeRosterId: theirs.roster_id,
      })) problems.push(`Requester: ${p}`);
    } else {
      // HANDOVER: colleague simply takes the shift
      await conn.query('UPDATE duty_roster SET emp_id = ? WHERE roster_id = ?', [colleagueId, mine.roster_id]);
    }

    for (const p of await findConflicts(conn, {
      empId: colleagueId, shiftId: mine.shift_id, rosterDate: mine.roster_date, excludeRosterId: mine.roster_id,
    })) problems.push(`Colleague: ${p}`);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') problems.push('One of the employees already has a different shift on the date they would take over');
    else throw err;
  }
  return problems;
}

const SELECT_SWAP = `
  SELECT w.swap_id, w.status, w.created_at, w.reviewed_at,
         IF(w.swap_roster_id IS NULL, 'HANDOVER', 'EXCHANGE') AS type,
         r.roster_id, r.roster_date, s.shift_name,
         rq.emp_id AS requested_by_id, CONCAT(rq.first_name, ' ', rq.last_name) AS requested_by,
         sw.emp_id AS swap_with_id,    CONCAT(sw.first_name, ' ', sw.last_name) AS swap_with,
         r2.roster_id AS swap_roster_id, r2.roster_date AS swap_date, s2.shift_name AS swap_shift
  FROM shift_swap_request w
  JOIN duty_roster r  ON r.roster_id = w.roster_id
  JOIN shift s        ON s.shift_id = r.shift_id
  JOIN employee rq    ON rq.emp_id = w.requested_by
  JOIN employee sw    ON sw.emp_id = w.swap_with
  LEFT JOIN duty_roster r2 ON r2.roster_id = w.swap_roster_id
  LEFT JOIN shift s2       ON s2.shift_id = r2.shift_id`;

// POST /api/swaps   body: { rosterId, swapWithEmpId, swapRosterId? }
export async function requestSwap(req, res) {
  const rosterId = Number(req.body.rosterId);
  const colleagueId = Number(req.body.swapWithEmpId);
  const swapRosterId = req.body.swapRosterId ? Number(req.body.swapRosterId) : null;

  if (!Number.isInteger(rosterId) || !Number.isInteger(colleagueId)) {
    return res.status(400).json({ message: 'rosterId and swapWithEmpId are required' });
  }
  if (swapRosterId !== null && !Number.isInteger(swapRosterId)) {
    return res.status(400).json({ message: 'swapRosterId must be a number' });
  }
  if (colleagueId === req.user.empId) return res.status(400).json({ message: 'You cannot swap with yourself' });

  const conn = await pool.getConnection();
  try {
    const today = todayStr();

    const mine = await loadRoster(conn, rosterId);
    if (!mine) return res.status(404).json({ message: 'Roster entry not found' });
    if (mine.emp_id !== req.user.empId) return res.status(403).json({ message: 'You can only request a swap for your own shift' });
    let problem = swappableProblem(mine, today);
    if (problem) return res.status(400).json({ message: problem });

    const [[colleague]] = await conn.query('SELECT is_active FROM employee WHERE emp_id = ?', [colleagueId]);
    if (!colleague || !colleague.is_active) return res.status(400).json({ message: 'Colleague not found or inactive' });

    let theirs = null;
    if (swapRosterId !== null) {
      theirs = await loadRoster(conn, swapRosterId);
      problem = swappableProblem(theirs, today);
      if (problem) return res.status(400).json({ message: problem });
      if (theirs.emp_id !== colleagueId) return res.status(400).json({ message: 'That roster entry does not belong to the selected colleague' });
      if (theirs.roster_id === mine.roster_id) return res.status(400).json({ message: 'Choose a different shift to exchange' });
    }

    // Don't allow two open requests touching the same roster entry
    const ids = [mine.roster_id, ...(theirs ? [theirs.roster_id] : [])];
    const [pending] = await conn.query(
      "SELECT swap_id FROM shift_swap_request WHERE status = 'PENDING' AND (roster_id IN (?) OR swap_roster_id IN (?))",
      [ids, ids]
    );
    if (pending.length) return res.status(409).json({ message: 'A pending swap request already involves one of these shifts' });

    // Dry run: apply, check the rules, then always roll back
    await conn.beginTransaction();
    const problems = await applyAndCheck(conn, mine, theirs, colleagueId);
    await conn.rollback();
    if (problems.length) {
      return res.status(409).json({ message: 'This swap would break scheduling rules', conflicts: problems });
    }

    const [r] = await conn.query(
      'INSERT INTO shift_swap_request (roster_id, requested_by, swap_with, swap_roster_id) VALUES (?, ?, ?, ?)',
      [mine.roster_id, req.user.empId, colleagueId, theirs ? theirs.roster_id : null]
    );
    res.status(201).json({
      swap_id: r.insertId, type: theirs ? 'EXCHANGE' : 'HANDOVER', message: 'Swap request submitted for approval',
    });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  } finally {
    conn.release();
  }
}

// GET /api/swaps/mine  (requests I made or that involve me)
export async function mySwaps(req, res) {
  try {
    const [rows] = await pool.query(
      SELECT_SWAP + ' WHERE w.requested_by = ? OR w.swap_with = ? ORDER BY w.created_at DESC, w.swap_id DESC',
      [req.user.empId, req.user.empId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

// GET /api/swaps?status=PENDING
export async function listSwaps(req, res) {
  const { status } = req.query;
  if (status && !STATUSES.includes(status)) return res.status(400).json({ message: 'Invalid status filter' });
  try {
    let sql = SELECT_SWAP;
    const params = [];
    if (status) { sql += ' WHERE w.status = ?'; params.push(status); }
    sql += ' ORDER BY w.created_at DESC, w.swap_id DESC LIMIT 200';
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

// DELETE /api/swaps/:id  (requester withdraws a pending request)
export async function cancelSwap(req, res) {
  try {
    const [r] = await pool.query(
      "DELETE FROM shift_swap_request WHERE swap_id = ? AND requested_by = ? AND status = 'PENDING'",
      [req.params.id, req.user.empId]
    );
    if (r.affectedRows === 0) return res.status(404).json({ message: 'No pending request of yours found with that ID' });
    res.json({ message: 'Swap request cancelled' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

// PUT /api/swaps/:id/review   body: { decision: 'APPROVED' | 'REJECTED' }
export async function reviewSwap(req, res) {
  const { decision } = req.body;
  if (!['APPROVED', 'REJECTED'].includes(decision)) {
    return res.status(400).json({ message: 'decision must be APPROVED or REJECTED' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[sw]] = await conn.query('SELECT * FROM shift_swap_request WHERE swap_id = ? FOR UPDATE', [req.params.id]);
    if (!sw) { await conn.rollback(); return res.status(404).json({ message: 'Swap request not found' }); }
    if (sw.status !== 'PENDING') { await conn.rollback(); return res.status(409).json({ message: `Request already ${sw.status.toLowerCase()}` }); }
    if (req.user.empId === sw.requested_by || req.user.empId === sw.swap_with) {
      await conn.rollback();
      return res.status(403).json({ message: 'You cannot review a swap you are part of' });
    }

    if (decision === 'APPROVED') {
      // Re-validate against the roster as it is NOW: it may have changed since the request
      const today = todayStr();
      const mine = await loadRoster(conn, sw.roster_id, true);
      const theirs = sw.swap_roster_id ? await loadRoster(conn, sw.swap_roster_id, true) : null;

      const stale =
        swappableProblem(mine, today) ||
        (mine && mine.emp_id !== sw.requested_by ? 'The requester no longer holds this shift' : null) ||
        (theirs ? swappableProblem(theirs, today) : null) ||
        (theirs && theirs.emp_id !== sw.swap_with ? 'The colleague no longer holds the shift to exchange' : null);
      if (stale) {
        await conn.rollback();
        return res.status(409).json({ message: 'This request is no longer valid', reason: stale });
      }

      const problems = await applyAndCheck(conn, mine, theirs, sw.swap_with);
      if (problems.length) {
        await conn.rollback();
        return res.status(409).json({ message: 'Cannot approve: scheduling rules would be broken', conflicts: problems });
      }
    }

    await conn.query(
      'UPDATE shift_swap_request SET status = ?, reviewed_by = ?, reviewed_at = UTC_TIMESTAMP() WHERE swap_id = ?',
      [decision, req.user.userId, sw.swap_id]
    );
    await conn.commit();
    res.json({ message: `Swap request ${decision.toLowerCase()}` });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  } finally {
    conn.release();
  }
}