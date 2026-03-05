import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';

import { migrate } from './db/migrate.js';
import app from './app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT      = process.env.PORT || 3000;

// ── Static files + SPA fallback (local dev only — Vercel serves public/ natively) ──
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (_req, res) =>
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html')),
);

// ── Boot ───────────────────────────────────────────────────────────────────────
await migrate();

app.listen(PORT, () => {
  console.log(`\n🚀 Lead CRM running → http://localhost:${PORT}\n`);
});
