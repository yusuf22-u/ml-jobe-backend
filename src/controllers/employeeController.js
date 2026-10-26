import bcrypt from 'bcrypt';
import pool from '../config/db.js';

const ROLES = ['EMPLOYEE', 'SUPERVISOR', 'HR_ADMIN', 'PLANT_MANAGER'];

function validateEmployee(b, { requireAccount }) {
  const errors = [];
  if (!b.firstName?.trim()) errors.push('First name is required');
  if (!b.lastName?.trim()) errors.push('Last name is required');
  if (!b.position?.trim()) errors.push('Position is required');
  if (!b.deptId || isNaN(Number(b.deptId))) errors.push('A valid department is required');
  if (!b.hireDate || !/^\d{4}-\d{2}-\d{2}$/.test(b.hireDate)) errors.push('Hire date must be YYYY-MM-DD');
  if (b.email && !/^\S+@\S+\.\S+$/.test(b.email)) errors.push('Email is not valid');
  if (b.role && !ROLES.includes(b.role)) errors.push('Invalid role');
  if (requireAccount) {
    if (!b.username?.trim() || b.username.trim().length < 3) errors.push('Username must be at least 3 characters');
    if (!b.password || b.password.length < 8) errors.push('Password must be at least 8 characters');
  }
  return errors;
}

const SELECT_EMPLOYEE = `
  SELECT e.emp_id, e.first_name, e.last_name, e.position, e.email, e.phone,
         e.hire_date, e.is_active, d.dept_id, d.name AS department,
         u.username, u.role
  FROM employee e
  JOIN department d ON d.dept_id = e.dept_id
  LEFT JOIN user u ON u.emp_id = e.emp_id`;

export async function listEmployees(req, res) {
  const { search = '', deptId, active = '1' } = req.query;
  let sql = SELECT_EMPLOYEE + ' WHERE 1=1';
  const params = [];

  if (search.trim()) {
    sql += ' AND (e.first_name LIKE ? OR e.last_name LIKE ? OR e.position LIKE ?)';
    const like = `%${search.trim()}%`;
    params.push(like, like, like);
  }
  if (deptId) { sql += ' AND e.dept_id = ?'; params.push(deptId); }
  if (active !== 'all') { sql += ' AND e.is_active = ?'; params.push(active === '0' ? 0 : 1); }
  sql += ' ORDER BY e.last_name, e.first_name';

  try {
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

export async function getEmployee(req, res) {
  const [rows] = await pool.query(SELECT_EMPLOYEE + ' WHERE e.emp_id = ?', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ message: 'Employee not found' });
  res.json(rows[0]);
}

export async function createEmployee(req, res) {
  const errors = validateEmployee(req.body, { requireAccount: true });
  if (errors.length) return res.status(400).json({ message: 'Validation failed', errors });

  const { firstName, lastName, position, deptId, hireDate, email = null, phone = null,
    username, password, role = 'EMPLOYEE' } = req.body;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [emp] = await conn.query(
      `INSERT INTO employee (first_name, last_name, position, email, phone, hire_date, dept_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [firstName.trim(), lastName.trim(), position.trim(), email || null, phone, hireDate, deptId]
    );
    const hash = await bcrypt.hash(password, 10);
    await conn.query(
      'INSERT INTO user (emp_id, username, password_hash, role) VALUES (?, ?, ?, ?)',
      [emp.insertId, username.trim(), hash, role]
    );

    await conn.commit();
    res.status(201).json({ emp_id: emp.insertId, message: 'Employee registered' });
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'Username or email already exists' });
    }
    if (err.code === 'ER_NO_REFERENCED_ROW_2') {
      return res.status(400).json({ message: 'Department does not exist' });
    }
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  } finally {
    conn.release();
  }
}

export async function updateEmployee(req, res) {
  const errors = validateEmployee(req.body, { requireAccount: false });
  if (errors.length) return res.status(400).json({ message: 'Validation failed', errors });

  const id = Number(req.params.id);
  const { firstName, lastName, position, deptId, hireDate, email = null, phone = null,
    role, isActive } = req.body;

  if (role && id === req.user.empId) {
    return res.status(400).json({ message: 'You cannot change your own role' });
  }
  if (isActive === false && id === req.user.empId) {
    return res.status(400).json({ message: 'You cannot deactivate your own account' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [r] = await conn.query(
      `UPDATE employee SET first_name=?, last_name=?, position=?, email=?, phone=?,
              hire_date=?, dept_id=?, is_active=COALESCE(?, is_active)
       WHERE emp_id=?`,
      [firstName.trim(), lastName.trim(), position.trim(), email || null, phone,
        hireDate, deptId, isActive === undefined ? null : (isActive ? 1 : 0), id]
    );
    if (r.affectedRows === 0) {
      await conn.rollback();
      return res.status(404).json({ message: 'Employee not found' });
    }
    if (role) await conn.query('UPDATE user SET role=? WHERE emp_id=?', [role, id]);
    if (isActive === false) await cancelFutureShifts(conn, id);
    await conn.commit();
    res.json({ message: 'Employee updated' });
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Email already in use' });
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  } finally {
    conn.release();
  }
}
async function cancelFutureShifts(db, empId) {
  const [r] = await db.query(
    `UPDATE duty_roster r SET r.status = 'CANCELLED'
     WHERE r.emp_id = ? AND r.roster_date >= UTC_DATE() AND r.status = 'SCHEDULED'
       AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.roster_id = r.roster_id)`,
    [empId]
  );
  return r.affectedRows;
}
export async function deactivateEmployee(req, res) {
  const id = Number(req.params.id);
  if (id === req.user.empId) {
    return res.status(400).json({ message: 'You cannot deactivate your own account' });
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [r] = await conn.query('UPDATE employee SET is_active = 0 WHERE emp_id = ?', [id]);
    if (r.affectedRows === 0) {
      await conn.rollback();
      return res.status(404).json({ message: 'Employee not found' });
    }
    const cancelled = await cancelFutureShifts(conn, id);
    await conn.commit();
    res.json({ message: 'Employee deactivated (records retained)', shiftsCancelled: cancelled });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  } finally {
    conn.release();
  }
}
export async function resetPassword(req, res) {
  const { password } = req.body;
  if (!password || password.length < 8) {
    return res.status(400).json({ message: 'Password must be at least 8 characters' });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const [r] = await pool.query('UPDATE user SET password_hash = ? WHERE emp_id = ?', [hash, req.params.id]);
    if (r.affectedRows === 0) return res.status(404).json({ message: 'Employee account not found' });
    res.json({ message: 'Password reset' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}
export async function listColleagues(req, res) {
  try {
    const [rows] = await pool.query(
      `SELECT emp_id, first_name, last_name, position FROM employee
       WHERE is_active = 1 AND emp_id <> ? ORDER BY last_name, first_name`,
      [req.user.empId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}