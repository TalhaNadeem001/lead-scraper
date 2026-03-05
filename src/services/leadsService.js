/**
 * leadsService.js
 * All database interactions for leads and scraped URL tracking.
 * Replaces the JSON file approach from the Python scripts.
 */

import crypto from 'crypto';
import pool from '../db/index.js';

// ── ID generation ──────────────────────────────────────────────────────────────

/**
 * Deterministic 16-char ID for a lead based on its Maps URL (or name+address).
 * @param {object} r
 * @returns {string}
 */
export function makeLeadId(r) {
  const key = r.maps_url || `${r.name ?? ''}|${r.address ?? ''}`;
  return crypto.createHash('md5').update(key).digest('hex').slice(0, 16);
}

// ── Queries ────────────────────────────────────────────────────────────────────

/**
 * Fetch all leads, newest first.
 * @returns {Promise<object[]>}
 */
export async function getAllLeads() {
  const { rows } = await pool.query(`
    SELECT
      l.*,
      COALESCE(vs.visit_count, 0)::int                          AS visit_count,
      vs.last_visited_at,
      vs.next_followup_at
    FROM leads l
    LEFT JOIN (
      SELECT
        lead_id,
        COUNT(*)                                                 AS visit_count,
        MAX(visited_at)                                          AS last_visited_at,
        MIN(followup_at) FILTER (WHERE followup_at IS NOT NULL)  AS next_followup_at
      FROM visits
      GROUP BY lead_id
    ) vs ON vs.lead_id = l.id
    ORDER BY l.icp_score DESC, l.created_at DESC
  `);
  return rows.map(formatRow);
}

/**
 * Insert or update a scraped lead.
 * CRM fields (met, notes) are preserved on conflict.
 * @param {object} detail - Scraped restaurant data with .pos and .icp sub-objects
 * @returns {Promise<string>} The lead id
 */
export async function upsert(detail) {
  const id = makeLeadId(detail);
  const pos = detail.pos ?? {};
  const icp = detail.icp ?? {};

  await pool.query(
    `INSERT INTO leads (
       id, name, address, phone, website, email,
       rating, review_count, maps_url, category_hint,
       pos_platform, pos_confidence, pos_all_detected,
       icp_match, icp_score, busy_score, youth_score, icp_reason,
       menu_signals, review_snippets, source
     ) VALUES (
       $1,$2,$3,$4,$5,$6,
       $7,$8,$9,$10,
       $11,$12,$13,
       $14,$15,$16,$17,$18,
       $19,$20,$21
     )
     ON CONFLICT (id) DO UPDATE SET
       name=$2, address=$3, phone=$4, website=$5, email=$6,
       rating=$7, review_count=$8, maps_url=$9, category_hint=$10,
       pos_platform=$11, pos_confidence=$12, pos_all_detected=$13,
       icp_match=$14, icp_score=$15, busy_score=$16, youth_score=$17, icp_reason=$18,
       menu_signals=$19, review_snippets=$20, source=$21,
       updated_at = NOW()`,
    [
      id,
      detail.name        ?? null,
      detail.address     ?? null,
      detail.phone       ?? null,
      detail.website     ?? null,
      detail.email       ?? null,
      detail.rating      ?? null,
      detail.review_count ?? null,
      detail.maps_url    ?? null,
      detail.category_hint ?? null,
      pos.platform       ?? 'Unknown',
      pos.confidence     ?? 'none',
      pos.allDetected    ?? [],
      icp.icp_match      ?? false,
      icp.score          ?? 0,
      icp.busy_score     ?? 0,
      icp.youth_score    ?? 0,
      icp.reason         ?? '',
      icp.menu_signals   ?? [],
      detail.review_snippets ?? [],
      detail.source      ?? '',
    ],
  );

  return id;
}

/**
 * Update CRM-managed fields for a lead.
 * @param {string} id
 * @param {{ met?: boolean, notes?: string }} updates
 */
export async function updateCRM(id, updates) {
  const setClauses = [];
  const values = [];
  let i = 1;

  if (updates.met !== undefined && updates.met !== null) {
    setClauses.push(`met = $${i++}`);
    values.push(updates.met);
  }
  if (updates.notes !== undefined && updates.notes !== null) {
    setClauses.push(`notes = $${i++}`);
    values.push(updates.notes);
  }

  if (setClauses.length === 0) return;

  setClauses.push(`updated_at = NOW()`);
  values.push(id);

  await pool.query(
    `UPDATE leads SET ${setClauses.join(', ')} WHERE id = $${i}`,
    values,
  );
}

// ── Scrape progress tracking ───────────────────────────────────────────────────

/**
 * Returns a Set of URLs already scraped for a given source location.
 * Equivalent to the Python _progress.json files.
 * @param {string} source
 * @returns {Promise<Set<string>>}
 */
export async function getScrapedUrls(source) {
  const { rows } = await pool.query(
    `SELECT url FROM scraped_urls WHERE source = $1`,
    [source],
  );
  return new Set(rows.map((r) => r.url));
}

/**
 * Mark a URL as scraped for a source.
 * @param {string} source
 * @param {string} url - Cleaned URL (no query string)
 */
export async function markScraped(source, url) {
  await pool.query(
    `INSERT INTO scraped_urls (url, source)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [url, source],
  );
}

/**
 * Delete all leads and scraped URL records for a source (reset).
 * @param {string} source
 */
export async function deleteBySource(source) {
  await pool.query(`DELETE FROM leads WHERE source = $1`, [source]);
  await pool.query(`DELETE FROM scraped_urls WHERE source = $1`, [source]);
}

// ── Row formatter ─────────────────────────────────────────────────────────────

/**
 * Shape a DB row into the API response format expected by the frontend.
 * Matches the structure the Python scripts produced in results JSON files.
 */
function formatRow(row) {
  return {
    _id:           row.id,
    name:          row.name,
    address:       row.address,
    phone:         row.phone,
    website:       row.website,
    email:         row.email,
    rating:        row.rating,
    review_count:  row.review_count,
    maps_url:      row.maps_url,
    category_hint: row.category_hint,
    pos: {
      platform:    row.pos_platform,
      confidence:  row.pos_confidence,
      allDetected: row.pos_all_detected ?? [],
    },
    icp: {
      icp_match:   row.icp_match,
      score:       row.icp_score,
      busy_score:  row.busy_score,
      youth_score: row.youth_score,
      reason:      row.icp_reason,
      menu_signals: row.menu_signals ?? [],
    },
    review_snippets: row.review_snippets ?? [],
    source:           row.source,
    met:              row.met,
    notes:            row.notes,
    drive_minutes:    row.drive_minutes,
    visit_count:      parseInt(row.visit_count) || 0,
    last_visited_at:  row.last_visited_at  ?? null,
    next_followup_at: row.next_followup_at ?? null,
    created_at:       row.created_at,
  };
}
