/**
 * Data access for analyses. The only module that writes SQL.
 *
 * Two principles here:
 *
 *  1. PERSISTENCE IS BEST-EFFORT. Every function returns null instead of
 *     throwing when the database is down. Saving history must never be able to
 *     fail a fact-check the user already waited for.
 *
 *  2. WRITES ARE TRANSACTIONAL. An analysis spans four tables; a partial write
 *     would leave a claim with no verdict, or a verdict with no sources. So the
 *     whole tree commits or none of it does.
 */

const { query, getClient, isAvailable } = require('./pool');
const { createLogger } = require('../utils/logger');

const log = createLogger('repo');

/**
 * Persist a complete analysis and everything under it.
 *
 * @param {object} params
 * @param {string} params.inputType        - 'text' | 'url' | 'image' | 'video'
 * @param {string} params.submittedContent - what the user handed us
 * @param {string} [params.resolvedContent]- what we actually analysed
 * @param {string} [params.sourceSurface]  - 'web' | 'telegram' | 'extension' | 'api'
 * @param {Array}  params.results          - pipeline results
 * @returns {Promise<number|null>} the new analysis id, or null if not persisted
 */
async function saveAnalysis({ inputType, submittedContent, resolvedContent, sourceSurface = 'web', results }) {
  const client = await getClient();
  if (!client) return null;

  try {
    await client.query('BEGIN');

    const analysisResult = await client.query(
      `INSERT INTO analyses (input_type, submitted_content, resolved_content, source_surface)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      // Trim stored content: we want an audit trail, not a copy of the internet.
      [inputType, String(submittedContent).slice(0, 20000), resolvedContent ? String(resolvedContent).slice(0, 50000) : null, sourceSurface],
    );
    const analysisId = analysisResult.rows[0].id;

    for (let i = 0; i < results.length; i += 1) {
      const result = results[i];

      const claimResult = await client.query(
        `INSERT INTO claims (analysis_id, claim_text, position, start_seconds, timestamp_label)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [analysisId, result.claim, i, result.startSeconds ?? null, result.timestamp ?? null],
      );
      const claimId = claimResult.rows[0].id;

      const verdictResult = await client.query(
        `INSERT INTO verdicts (claim_id, verdict, confidence, reasoning, evidence_provider)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [claimId, result.verdict, result.confidence, result.reasoning, result.evidenceProvider || null],
      );
      const verdictId = verdictResult.rows[0].id;

      for (const source of result.sources || []) {
        await client.query(
          `INSERT INTO sources (verdict_id, url, title, domain)
           VALUES ($1, $2, $3, $4)`,
          [verdictId, source.url, source.title || null, source.domain || null],
        );
      }
    }

    await client.query('COMMIT');
    log.info(`Saved analysis #${analysisId} (${results.length} claim(s))`);
    return analysisId;
  } catch (error) {
    // Roll back so a half-written tree never survives.
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      log.error('Rollback failed', rollbackError.message);
    }
    log.error('Failed to save analysis; continuing without persistence', error.message);
    return null;
  } finally {
    client.release();
  }
}

/**
 * Fetch recent analyses, fully hydrated with claims, verdicts and sources.
 *
 * One query, not an N+1 loop: json_agg assembles the whole nested structure in
 * the database and hands the API a shape the UI can render directly.
 *
 * Structural notes, because the shape here is load-bearing:
 *  - We LEFT JOIN claims and verdicts and GROUP BY the analysis. Grouping by the
 *    primary key lets us select a.* and ORDER BY a.created_at without listing
 *    every column, via functional dependency.
 *  - FILTER (WHERE c.id IS NOT NULL) stops an analysis with no claims from
 *    aggregating into `[null]` instead of an empty array.
 *  - Sources are gathered by a CORRELATED SCALAR SUBQUERY rather than a third
 *    join, which would multiply the claim rows and duplicate every verdict.
 */
async function getHistory({ limit = 20, offset = 0 } = {}) {
  if (!isAvailable()) return { available: false, analyses: [] };

  const result = await query(
    `SELECT
       a.id,
       a.input_type        AS "inputType",
       a.submitted_content AS "submittedContent",
       a.source_surface    AS "sourceSurface",
       a.created_at        AS "createdAt",
       COALESCE(
         json_agg(
           json_build_object(
             'claim',            c.claim_text,
             'timestamp',        c.timestamp_label,
             'verdict',          v.verdict,
             'confidence',       v.confidence,
             'reasoning',        v.reasoning,
             'evidenceProvider', v.evidence_provider,
             'sources', COALESCE(
               (
                 SELECT json_agg(json_build_object('url', s.url, 'title', s.title, 'domain', s.domain))
                 FROM sources s
                 WHERE s.verdict_id = v.id
               ),
               '[]'::json
             )
           )
           ORDER BY c.position
         ) FILTER (WHERE c.id IS NOT NULL),
         '[]'::json
       ) AS results
     FROM analyses a
     LEFT JOIN claims   c ON c.analysis_id = a.id
     LEFT JOIN verdicts v ON v.claim_id    = c.id
     GROUP BY a.id
     ORDER BY a.created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );

  if (!result) return { available: false, analyses: [] };

  return { available: true, analyses: result.rows };
}

/** Aggregate counts for the stats strip in the history view. */
async function getStats() {
  if (!isAvailable()) return null;

  const result = await query(
    `SELECT
       (SELECT COUNT(*) FROM analyses)                            AS "totalAnalyses",
       (SELECT COUNT(*) FROM claims)                              AS "totalClaims",
       (SELECT COUNT(*) FROM verdicts WHERE verdict = 'TRUE')     AS "trueCount",
       (SELECT COUNT(*) FROM verdicts WHERE verdict = 'FALSE')    AS "falseCount",
       (SELECT COUNT(*) FROM verdicts WHERE verdict = 'MISLEADING') AS "misleadingCount",
       (SELECT COUNT(*) FROM verdicts WHERE verdict = 'UNVERIFIABLE') AS "unverifiableCount"`,
  );

  if (!result) return null;

  // pg returns COUNT(*) as a string (bigint safety); coerce for the UI.
  const row = result.rows[0];
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)]));
}

module.exports = { saveAnalysis, getHistory, getStats };
