import pool from '../config/db.js';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function listShifts(req, res) {
  const [rows] = await pool.query(
    'SELECT shift_id, shift_name, start_time, end_time, min_staff FROM shift ORDER BY start_time'
  );
  res.json(rows);
}

export async function createShift(req, res) {
  const { shiftName, startTime, endTime } = req.body;
  if (!shiftName?.trim()) return res.status(400).json({ message: 'Shift name is required' });
  if (!TIME_RE.test(startTime || '') || !TIME_RE.test(endTime || '')) {
    return res.status(400).json({ message: 'Times must be in HH:MM format' });
  }
  if (startTime === endTime) return res.status(400).json({ message: 'Start and end time cannot be equal' });
  try {
    const minStaff = req.body.minStaff === undefined ? 1 : Number(req.body.minStaff);
    if (!Number.isInteger(minStaff) || minStaff < 1 || minStaff > 100) {
      return res.status(400).json({ message: 'minStaff must be a whole number between 1 and 100' });
    }
    // ...
    const [r] = await pool.query(
      'INSERT INTO shift (shift_name, start_time, end_time, min_staff) VALUES (?, ?, ?, ?)',
      [shiftName.trim(), `${startTime}:00`, `${endTime}:00`, minStaff]
    );
    res.status(201).json({ shift_id: r.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Shift name already exists' });
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

export async function updateShift(req, res) {
  const { shiftName, startTime, endTime } = req.body;
  if (!shiftName?.trim()) return res.status(400).json({ message: 'Shift name is required' });
  if (!TIME_RE.test(startTime || '') || !TIME_RE.test(endTime || '')) {
    return res.status(400).json({ message: 'Times must be in HH:MM format' });
  }
  try {
    let minStaff = null;
    if (req.body.minStaff !== undefined) {
      minStaff = Number(req.body.minStaff);
      if (!Number.isInteger(minStaff) || minStaff < 1 || minStaff > 100) {
        return res.status(400).json({ message: 'minStaff must be a whole number between 1 and 100' });
      }
    }
    // ...
    const [r] = await pool.query(
      'UPDATE shift SET shift_name = ?, start_time = ?, end_time = ?, min_staff = COALESCE(?, min_staff) WHERE shift_id = ?',
      [shiftName.trim(), `${startTime}:00`, `${endTime}:00`, minStaff, req.params.id]
    );
    if (r.affectedRows === 0) return res.status(404).json({ message: 'Shift not found' });
    res.json({ message: 'Shift updated' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Shift name already exists' });
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}