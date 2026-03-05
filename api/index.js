import app from '../src/app.js';
import { migrate } from '../src/db/migrate.js';

// Run DB migration on cold start (CREATE TABLE IF NOT EXISTS — safe to re-run)
migrate().catch(console.error);

export default app;
