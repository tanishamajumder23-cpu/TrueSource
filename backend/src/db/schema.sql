-- ============================================================================
--  TruthLens schema
--
--  Normalised into four tables that mirror the pipeline exactly:
--
--    analyses  1 --< claims  1 --1 verdicts  1 --< sources
--
--  One submission produces many claims; each claim gets exactly one verdict;
--  each verdict cites many sources. Modelling sources as rows rather than a
--  JSON blob is what makes questions like "which domains do we cite most?" or
--  "how often does the DuckDuckGo fallback get used?" a single GROUP BY.
--
--  Every child FK is ON DELETE CASCADE, so deleting an analysis cleanly removes
--  its whole subtree and no orphans can accumulate.
-- ============================================================================

CREATE TABLE IF NOT EXISTS analyses (
    id                 SERIAL PRIMARY KEY,
    -- How the content arrived: 'text' | 'url' | 'image' | 'video' | 'telegram' | 'extension'
    input_type         TEXT        NOT NULL,
    -- The raw thing the user gave us (the text, the URL, or a short label for media).
    submitted_content  TEXT        NOT NULL,
    -- For url/image/video: the text we actually derived and analysed.
    -- Kept separate from submitted_content so the audit trail shows both what the
    -- user handed us and what the model actually reasoned about.
    resolved_content   TEXT,
    -- Where the request came from: 'web' | 'telegram' | 'extension' | 'api'
    source_surface     TEXT        NOT NULL DEFAULT 'web',
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS claims (
    id           SERIAL PRIMARY KEY,
    analysis_id  INTEGER NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
    claim_text   TEXT    NOT NULL,
    -- Position within the analysis, so we can replay results in the original order.
    position     INTEGER NOT NULL DEFAULT 0,
    -- Video only: where in the timeline this claim was spoken (seconds / "4:12").
    start_seconds NUMERIC,
    timestamp_label TEXT
);

CREATE TABLE IF NOT EXISTS verdicts (
    id          SERIAL PRIMARY KEY,
    claim_id    INTEGER NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
    -- Constrained so a bug upstream can never write an unknown verdict label.
    verdict     TEXT    NOT NULL CHECK (verdict IN ('TRUE', 'FALSE', 'MISLEADING', 'UNVERIFIABLE')),
    confidence  INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
    reasoning   TEXT    NOT NULL,
    -- Which retrieval provider supplied the evidence: 'tavily' | 'duckduckgo' | 'none'
    evidence_provider TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sources (
    id         SERIAL PRIMARY KEY,
    verdict_id INTEGER NOT NULL REFERENCES verdicts(id) ON DELETE CASCADE,
    url        TEXT    NOT NULL,
    title      TEXT,
    domain     TEXT
);

-- --------------------------------------------------------------------------
--  Indexes on every foreign key + the column the history feed sorts by.
--  Postgres does NOT create these automatically for FKs, and the history query
--  joins all four tables, so without them the feed degrades to sequential scans.
-- --------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_analyses_created_at ON analyses (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_claims_analysis_id  ON claims (analysis_id);
CREATE INDEX IF NOT EXISTS idx_verdicts_claim_id   ON verdicts (claim_id);
CREATE INDEX IF NOT EXISTS idx_sources_verdict_id  ON sources (verdict_id);
