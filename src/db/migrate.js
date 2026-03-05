/**
 * migrate.js
 * Creates all required tables if they don't already exist.
 * Run manually: node src/db/migrate.js
 * Also called automatically on server startup.
 */

import 'dotenv/config';
import pool from './index.js';

export async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id                VARCHAR(16)   PRIMARY KEY,
      name              TEXT,
      address           TEXT,
      phone             TEXT,
      website           TEXT,
      email             TEXT,
      rating            TEXT,
      review_count      INTEGER,
      maps_url          TEXT,
      category_hint     TEXT,

      -- POS detection
      pos_platform      TEXT          DEFAULT 'Unknown',
      pos_confidence    TEXT          DEFAULT 'none',
      pos_all_detected  TEXT[]        DEFAULT '{}',

      -- ICP evaluation
      icp_match         BOOLEAN       DEFAULT FALSE,
      icp_score         INTEGER       DEFAULT 0,
      busy_score        INTEGER       DEFAULT 0,
      youth_score       INTEGER       DEFAULT 0,
      icp_reason        TEXT          DEFAULT '',
      menu_signals      TEXT[]        DEFAULT '{}',
      review_snippets   TEXT[]        DEFAULT '{}',

      -- CRM fields
      source            TEXT          NOT NULL DEFAULT '',
      met               BOOLEAN       DEFAULT FALSE,
      notes             TEXT          DEFAULT '',
      drive_minutes     INTEGER,

      created_at        TIMESTAMPTZ   DEFAULT NOW(),
      updated_at        TIMESTAMPTZ   DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS scraped_urls (
      url         TEXT          NOT NULL,
      source      TEXT          NOT NULL,
      scraped_at  TIMESTAMPTZ   DEFAULT NOW(),
      PRIMARY KEY (url, source)
    );

    CREATE TABLE IF NOT EXISTS visits (
      id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id      VARCHAR(16)   NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      visited_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      type         TEXT          NOT NULL DEFAULT 'in_person',
      notes        TEXT          NOT NULL DEFAULT '',
      outcome      TEXT          NOT NULL DEFAULT '',
      followup_at  TIMESTAMPTZ,
      created_at   TIMESTAMPTZ   DEFAULT NOW(),
      updated_at   TIMESTAMPTZ   DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS visits_lead_id_idx     ON visits (lead_id);
    CREATE INDEX IF NOT EXISTS visits_followup_at_idx ON visits (followup_at) WHERE followup_at IS NOT NULL;
  `);

  console.log('✅ Database schema ready');
}

// Allow running directly: node src/db/migrate.js
if (process.argv[1].endsWith('migrate.js')) {
  migrate()
    .then(() => process.exit(0))
    .catch((err) => { console.error(err); process.exit(1); });
}
