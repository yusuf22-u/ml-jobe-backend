import bcrypt from 'bcrypt';
import pool from './config/db.js';

async function seed() {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Departments
    for (const name of ['Operations', 'Maintenance', 'Control Room', 'Administration']) {
      await conn.query('INSERT IGNORE INTO department (name) VALUES (?)', [name]);
    }

    // Shift patterns
    const shifts = [
      ['Morning',   '06:00:00', '14:00:00'],
      ['Afternoon', '14:00:00', '22:00:00'],
      ['Night',     '22:00:00', '06:00:00'],
    ];
    for (const s of shifts) {
      await conn.query(
        'INSERT IGNORE INTO shift (shift_name, start_time, end_time) VALUES (?, ?, ?)', s
      );
    }

    // First HR Admin (only if no users exist yet)
    const [users] = await conn.query('SELECT COUNT(*) AS n FROM user');
    if (users[0].n === 0) {
      const [[dept]] = await conn.query("SELECT dept_id FROM department WHERE name = 'Administration'");
      const [emp] = await conn.query(
        `INSERT INTO employee (first_name, last_name, position, hire_date, dept_id)
         VALUES ('System', 'Admin', 'HR Administrator', CURDATE(), ?)`,
        [dept.dept_id]
      );
      const hash = await bcrypt.hash('Admin@12345', 10);
      await conn.query(
        "INSERT INTO user (emp_id, username, password_hash, role) VALUES (?, 'admin', ?, 'HR_ADMIN')",
        [emp.insertId, hash]
      );
      console.log('Created HR admin -> username: admin / password: Admin@12345 (change it!)');
    }

    await conn.commit();
    console.log('Seed complete');
  } catch (err) {
    await conn.rollback();
    console.error('Seed failed:', err);
  } finally {
    conn.release();
    await pool.end();
  }
}

seed();