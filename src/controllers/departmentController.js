import pool from '../config/db.js';

export async function listDepartments(req, res) {
  const [rows] = await pool.query('SELECT dept_id, name, description FROM department ORDER BY name');
  res.json(rows);
}

export async function createDepartment(req, res) {
  const { name, description = null } = req.body;
  if (!name?.trim()) return res.status(400).json({ message: 'Department name is required' });
  try {
    const [r] = await pool.query(
      'INSERT INTO department (name, description) VALUES (?, ?)', [name.trim(), description]
    );
    res.status(201).json({ dept_id: r.insertId, name: name.trim(), description });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Department already exists' });
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

export async function updateDepartment(req, res) {
  const { name, description = null } = req.body;
  if (!name?.trim()) return res.status(400).json({ message: 'Department name is required' });
  try {
    const [r] = await pool.query(
      'UPDATE department SET name = ?, description = ? WHERE dept_id = ?',
      [name.trim(), description, req.params.id]
    );
    if (r.affectedRows === 0) return res.status(404).json({ message: 'Department not found' });
    res.json({ message: 'Department updated' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Department name already used' });
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

export async function deleteDepartment(req, res) {
  try {
    const [[{ n }]] = await pool.query(
      'SELECT COUNT(*) AS n FROM employee WHERE dept_id = ?', [req.params.id]
    );
    if (n > 0) {
      return res.status(409).json({ message: 'Cannot delete a department that still has employees' });
    }
    const [r] = await pool.query('DELETE FROM department WHERE dept_id = ?', [req.params.id]);
    if (r.affectedRows === 0) return res.status(404).json({ message: 'Department not found' });
    res.json({ message: 'Department deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}