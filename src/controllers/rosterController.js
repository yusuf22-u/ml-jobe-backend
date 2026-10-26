import pool from '../config/db.js';
import { isValidDate, addDays, findConflicts, findAvailableEmployees } from '../utils/rosterRules.js';

const todayStr = () => new Date().toISOString().slice(0, 10);

const SELECT_ROSTER = `
  SELECT r.roster_id, r.roster_date, r.status,
         e.emp_id, e.first_name, e.last_name, d.name AS department,
         s.shift_id, s.shift_name, s.start_time, s.end_time
  FROM duty_roster r
  JOIN employee e   ON e.emp_id = r.emp_id
  JOIN department d ON d.dept_id = e.dept_id
  JOIN shift s      ON s.shift_id = r.shift_id`;

// GET /api/roster?from=YYYY-MM-DD&to=YYYY-MM-DD&deptId=
export async function listRoster(req, res) {
  const { from, to, deptId } = req.query;
  if (!isValidDate(from) || !isValidDate(to)) {
    return res.status(400).json({ message: 'from and to must be valid dates (YYYY-MM-DD)' });
  }
  if (to < from) return res.status(400).json({ message: '"to" cannot be before "from"' });
  if (addDays(from, 62) < to) return res.status(400).json({ message: 'Date range cannot exceed 62 days' });

  let sql = SELECT_ROSTER + ' WHERE r.roster_date BETWEEN ? AND ?';
  const params = [from, to];
  if (deptId) { sql += ' AND e.dept_id = ?'; params.push(deptId); }
  sql += ' ORDER BY r.roster_date, s.start_time, e.last_name';

  const [rows] = await pool.query(sql, params);
  res.json(rows);
}

// GET /api/roster/mine  (any logged-in user sees only their own)
export async function myRoster(req, res) {
  const from = isValidDate(req.query.from) ? req.query.from : todayStr();
  const to = isValidDate(req.query.to) ? req.query.to : addDays(from, 30);
  const [rows] = await pool.query(
    SELECT_ROSTER + ' WHERE r.emp_id = ? AND r.roster_date BETWEEN ? AND ? ORDER BY r.roster_date',
    [req.user.empId, from, to]
  );
  res.json(rows);
}

// GET /api/roster/available?date=&shiftId=
export async function availableEmployees(req, res) {
  const { date, shiftId } = req.query;
  if (!isValidDate(date) || !shiftId) {
    return res.status(400).json({ message: 'date (YYYY-MM-DD) and shiftId are required' });
  }
  const list = await findAvailableEmployees(pool, { rosterDate: date, shiftId });
  res.json(list);
}

// POST /api/roster
export async function createRoster(req, res) {
  const { empId, shiftId, rosterDate } = req.body;
  if (!empId || !shiftId || !isValidDate(rosterDate)) {
    return res.status(400).json({ message: 'empId, shiftId and a valid rosterDate are required' });
  }
  if (rosterDate < todayStr()) {
    return res.status(400).json({ message: 'Cannot assign a shift in the past' });
  }

  try {
    const conflicts = await findConflicts(pool, { empId, shiftId, rosterDate });
    if (conflicts.length) {
      const suggestions = (await findAvailableEmployees(pool, { rosterDate, shiftId, excludeEmpId: empId }))
        .slice(0, 5);
      return res.status(409).json({ message: 'Scheduling conflict', conflicts, suggestions });
    }

    const [r] = await pool.query(
      'INSERT INTO duty_roster (emp_id, shift_id, roster_date) VALUES (?, ?, ?)',
      [empId, shiftId, rosterDate]
    );
    res.status(201).json({ roster_id: r.insertId, message: 'Shift assigned' });
  } catch (err) {
    // Two supervisors saving at the same moment: the unique key is the final safety net
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'Scheduling conflict', conflicts: ['Employee is already rostered on this date'] });
    }
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

async function loadEditable(id, res) {
  const [[entry]] = await pool.query(
    `SELECT r.*, (SELECT COUNT(*) FROM attendance a WHERE a.roster_id = r.roster_id) AS has_attendance
     FROM duty_roster r WHERE r.roster_id = ?`, [id]
  );
  if (!entry) { res.status(404).json({ message: 'Roster entry not found' }); return null; }
  if (entry.status !== 'SCHEDULED' || entry.has_attendance > 0) {
    res.status(409).json({ message: 'Only scheduled entries without attendance can be changed' });
    return null;
  }
  return entry;
}

// PUT /api/roster/:id   (change shift and/or date)
export async function updateRoster(req, res) {
  const entry = await loadEditable(req.params.id, res);
  if (!entry) return;

  const shiftId = req.body.shiftId ?? entry.shift_id;
  const rosterDate = req.body.rosterDate ?? entry.roster_date;
  if (!isValidDate(rosterDate)) return res.status(400).json({ message: 'Invalid rosterDate' });
  if (rosterDate < todayStr()) return res.status(400).json({ message: 'Cannot move a shift into the past' });

  try {
    const conflicts = await findConflicts(pool, {
      empId: entry.emp_id, shiftId, rosterDate, excludeRosterId: entry.roster_id,
    });
    if (conflicts.length) return res.status(409).json({ message: 'Scheduling conflict', conflicts });

    await pool.query(
      'UPDATE duty_roster SET shift_id = ?, roster_date = ? WHERE roster_id = ?',
      [shiftId, rosterDate, entry.roster_id]
    );
    res.json({ message: 'Roster entry updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

// DELETE /api/roster/:id
export async function deleteRoster(req, res) {
  const entry = await loadEditable(req.params.id, res);
  if (!entry) return;
  try {
    await pool.query('DELETE FROM duty_roster WHERE roster_id = ?', [entry.roster_id]);
    res.json({ message: 'Roster entry removed' });
  } catch (err) {
    if (err.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(409).json({ message: 'This entry has a shift-swap request attached and cannot be deleted' });
    }
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}
// GET /api/roster/colleague/:empId  (upcoming, swappable shifts only: no personal data)
export async function colleagueRoster(req, res) {
  const id = Number(req.params.empId);
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'Invalid employee' });
  const today = todayStr();
  try {
    const [rows] = await pool.query(
      `SELECT r.roster_id, r.roster_date, s.shift_id, s.shift_name, s.start_time, s.end_time
       FROM duty_roster r
       JOIN shift s    ON s.shift_id = r.shift_id
       JOIN employee e ON e.emp_id = r.emp_id
       WHERE r.emp_id = ? AND e.is_active = 1 AND r.roster_date BETWEEN ? AND ?
         AND r.status = 'SCHEDULED'
         AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.roster_id = r.roster_id)
       ORDER BY r.roster_date, s.start_time`,
      [id, today, addDays(today, 60)]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}