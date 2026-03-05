import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import apiRouter from './routes/index.js';

const app = express();

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── API routes ─────────────────────────────────────────────────────────────────
app.use('/api', apiRouter);

// ── Global error handler ───────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: err.message });
});

export default app;
