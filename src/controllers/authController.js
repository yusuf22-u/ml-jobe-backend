import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import pool from '../config/db.js';

export async function login(req, res) {
  const { username, password } = req.body;
  if (!username?.trim() || !password) {
    return res.status(400).json({ message: 'Username and password are required' });
  }

  try {
    const [rows] = await pool.query(
      `SELECT u.user_id, u.emp_id, u.username, u.password_hash, u.role,
              e.first_name, e.last_name, e.is_active
       FROM user u JOIN employee e ON e.emp_id = u.emp_id
       WHERE u.username = ?`,
      [username.trim()]
    );

    const user = rows[0];
    // Same message for "no such user" and "wrong password" so attackers can't tell which
    if (!user || !user.is_active || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ message: 'Invalid username or password' });
    }

    const token = jwt.sign(
      { userId: user.user_id, empId: user.emp_id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '8h' } // one shift length
    );

    res.json({
      token,
      user: {
        empId: user.emp_id,
        username: user.username,
        role: user.role,
        name: `${user.first_name} ${user.last_name}`,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

export async function me(req, res) {
  res.json({ user: req.user });
}