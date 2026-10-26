import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import pool from './config/db.js';
import authRoutes from './routes/authRoutes.js';
import employeeRoutes from './routes/employeeRoutes.js';
import departmentRoutes from './routes/departmentRoutes.js';
import shiftRoutes from './routes/shiftRoutes.js';
import rosterRoutes from './routes/rosterRoutes.js';
import attendanceRoutes from './routes/attendanceRoutes.js';
import leaveRoutes from './routes/leaveRoutes.js';
import swapRoutes from './routes/swapRoutes.js';
import { authenticate } from './middleware/auth.js';
import reportRoutes from './routes/reportRoutes.js';
import { dashboard } from './controllers/reportController.js';



dotenv.config();
const app = express();



app.use(cors({ origin: 'http://localhost:5173' })); // Vite dev server
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/departments', departmentRoutes);
app.use('/api/shifts', shiftRoutes);
app.use('/api/roster', rosterRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/leave', leaveRoutes);
app.use('/api/swaps', swapRoutes);
app.use('/api/reports', reportRoutes);
app.get('/api/dashboard', authenticate, dashboard);

app.get('/api/health', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT COUNT(*) AS tables_count FROM information_schema.tables WHERE table_schema = ?', [process.env.DB_NAME]);
    res.json({ status: 'ok', tables: rows[0].tables_count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: 'error', message: 'Database connection failed' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));