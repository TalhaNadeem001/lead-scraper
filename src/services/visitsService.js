/**
 * visitsService.js
 * CRUD for visit/interaction tracking and follow-up scheduling.
 */

import pool from '../db/index.js';

/**
 * All visits for a lead, newest first.
 * @param {string} leadId
 */
export async function getVisitsForLead(leadId) {
  const { rows } = await pool.query(
    `SELECT * FROM visits WHERE lead_id = $1 ORDER BY visited_at DESC`,
    [leadId],
  );
  return rows;
}

/**
 * Log a new visit/interaction.
 * Automatically marks the lead as met on first save.
 *
 * @param {{ leadId, visitedAt?, type?, notes?, outcome?, followupAt? }} data
 */
export async function createVisit({ leadId, visitedAt, type, notes, outcome, followupAt }) {
  const { rows } = await pool.query(
    `INSERT INTO visits (lead_id, visited_at, type, notes, outcome, followup_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      leadId,
      visitedAt  || new Date(),
      type       || 'in_person',
      notes      || '',
      outcome    || '',
      followupAt || null,
    ],
  );

  // Auto-mark lead as met the moment any visit is logged
  await pool.query(
    `UPDATE leads SET met = true, updated_at = NOW() WHERE id = $1`,
    [leadId],
  );

  return rows[0];
}

/**
 * Update an existing visit (e.g. add outcome or reschedule follow-up).
 * @param {string} id  UUID of the visit
 * @param {{ visitedAt?, type?, notes?, outcome?, followupAt? }} updates
 */
export async function updateVisit(id, { visitedAt, type, notes, outcome, followupAt }) {
  const { rows } = await pool.query(
    `UPDATE visits
     SET
       visited_at  = COALESCE($2, visited_at),
       type        = COALESCE($3, type),
       notes       = COALESCE($4, notes),
       outcome     = COALESCE($5, outcome),
       followup_at = $6,
       updated_at  = NOW()
     WHERE id = $1
     RETURNING *`,
    [id, visitedAt || null, type || null, notes ?? null, outcome ?? null, followupAt || null],
  );
  return rows[0] ?? null;
}

/**
 * Remove a visit record.
 * @param {string} id
 */
export async function deleteVisit(id) {
  await pool.query(`DELETE FROM visits WHERE id = $1`, [id]);
}

/**
 * All scheduled follow-ups across every lead (past + future), sorted ascending.
 * Used for a CRM dashboard view.
 */
export async function getAllFollowups() {
  const { rows } = await pool.query(`
    SELECT
      v.*,
      l.name    AS lead_name,
      l.phone   AS lead_phone,
      l.address AS lead_address
    FROM visits v
    JOIN leads l ON l.id = v.lead_id
    WHERE v.followup_at IS NOT NULL
    ORDER BY v.followup_at ASC
  `);
  return rows;
}
