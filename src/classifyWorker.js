'use strict';

const { classifyProductWithRetries, PROMPT_VERSION } = require('./ollamaProductClassify');

const SQL_EXC_YIYECEK = `t.tip = 'yiyecek'
  AND (t.stok_no IS DISTINCT FROM '__DUZELTME__' AND t.stok_no IS DISTINCT FROM '__KDV_ILAVE__')`;

/** Tekil çiftleri üret — tüketim + kuyruk */
function sqlAllPairsCTE() {
  return `
  WITH all_pairs AS (
    SELECT DISTINCT t.stok_mali, t.kategori
    FROM fb_cost.tuketim t
    WHERE ${SQL_EXC_YIYECEK}
    UNION
    SELECT q.stok_mali, q.kategori FROM fb_cost.product_classify_queue q
  )`;
}

async function countPairStats(pool, { skipExisting }) {
  const q = `
  ${sqlAllPairsCTE()}
  SELECT
    (SELECT COUNT(*)::int FROM all_pairs) AS total_pairs,
    (SELECT COUNT(*)::int FROM all_pairs ap WHERE NOT EXISTS (
      SELECT 1 FROM fb_cost.product_classifications p
      WHERE p.stok_mali = ap.stok_mali AND (p.kategori IS NOT DISTINCT FROM ap.kategori)
    )) AS unclassified_pairs,
    (SELECT COUNT(*)::int FROM fb_cost.product_classifications) AS saved_rows
  `;
  const { rows } = await pool.query(q);
  const r = rows[0] || { total_pairs: 0, unclassified_pairs: 0, saved_rows: 0 };
  const skip = !!skipExisting;
  return {
    total_pairs: parseInt(r.total_pairs, 10) || 0,
    unclassified_pairs: parseInt(r.unclassified_pairs, 10) || 0,
    saved_rows: parseInt(r.saved_rows, 10) || 0,
    pending_pairs: skip ? (parseInt(r.unclassified_pairs, 10) || 0) : (parseInt(r.total_pairs, 10) || 0)
  };
}

async function fetchNextPair(pool, skipExisting, cursor) {
  const skip = !!skipExisting;
  const lastStok = cursor && cursor.stok_mali != null ? cursor.stok_mali : null;
  const lastKatNorm =
    cursor && lastStok != null
      ? cursor.kategori == null || cursor.kategori === ''
        ? ''
        : String(cursor.kategori)
      : null;

  const q = `
  ${sqlAllPairsCTE()},
  todo AS (
    SELECT ap.stok_mali, ap.kategori
    FROM all_pairs ap
    WHERE (
      $1::boolean = true AND NOT EXISTS (
        SELECT 1 FROM fb_cost.product_classifications p
        WHERE p.stok_mali = ap.stok_mali AND (p.kategori IS NOT DISTINCT FROM ap.kategori)
      )
    ) OR (
      $1::boolean = false AND (
        $2::text IS NULL
        OR (ap.stok_mali, COALESCE(ap.kategori, '')) > ($2::text, COALESCE($3::text, ''))
      )
    )
    ORDER BY ap.stok_mali, COALESCE(ap.kategori, '')
    LIMIT 1
  )
  SELECT * FROM todo
  `;
  const p3 = lastStok == null ? '' : (lastKatNorm || '');
  const { rows } = await pool.query(q, [skip, lastStok, p3]);
  return rows[0] || null;
}

async function upsertClassification(pool, row) {
  const sql = `
  INSERT INTO fb_cost.product_classifications (
    stok_mali, kategori, protein_bucket, food_group, confidence, gerekce, notes,
    model_name, prompt_version, raw_response, updated_at
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
  ON CONFLICT (stok_mali, kategori_norm) DO UPDATE SET
    protein_bucket = EXCLUDED.protein_bucket,
    food_group = EXCLUDED.food_group,
    confidence = EXCLUDED.confidence,
    gerekce = EXCLUDED.gerekce,
    notes = EXCLUDED.notes,
    model_name = EXCLUDED.model_name,
    prompt_version = EXCLUDED.prompt_version,
    raw_response = EXCLUDED.raw_response,
    updated_at = NOW()
  `;
  await pool.query(sql, [
    row.stok_mali,
    row.kategori,
    row.protein_bucket,
    row.food_group,
    row.confidence,
    row.gerekce,
    row.notes,
    row.model_name,
    row.prompt_version,
    row.raw_response
  ]);
}

let jobState = {
  running: false,
  pauseRequested: false,
  skipExisting: true,
  processed: 0,
  success: 0,
  failed: 0,
  totalAtStart: 0,
  latenciesMs: [],
  startedAt: null,
  lastStokMali: null,
  lastError: null,
  pauseReason: null
};

function getJobState() {
  const lat = jobState.latenciesMs;
  const avgMs = lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null;
  const pendingGuess = Math.max(0, (jobState.totalAtStart || 0) - jobState.processed);
  return {
    ...jobState,
    avgMs,
    pendingEstimate: jobState.running ? pendingGuess : null
  };
}

function resetJobCounters() {
  jobState.processed = 0;
  jobState.success = 0;
  jobState.failed = 0;
  jobState.latenciesMs = [];
  jobState.lastError = null;
  jobState.pauseReason = null;
}

async function runJobLoop(pool, { skipExisting }) {
  if (jobState.running) return;
  jobState.running = true;
  jobState.pauseRequested = false;
  jobState.skipExisting = !!skipExisting;
  resetJobCounters();
  jobState.startedAt = Date.now();

  try {
    const stats = await countPairStats(pool, { skipExisting: jobState.skipExisting });
    jobState.totalAtStart = jobState.skipExisting
      ? (parseInt(stats.unclassified_pairs, 10) || 0)
      : (parseInt(stats.total_pairs, 10) || 0);

    let cursor = null;

    while (!jobState.pauseRequested) {
      const pair = await fetchNextPair(pool, jobState.skipExisting, cursor);
      if (!pair) break;

      cursor = { stok_mali: pair.stok_mali, kategori: pair.kategori };
      jobState.lastStokMali = pair.stok_mali;
      const t0 = Date.now();
      try {
        const result = await classifyProductWithRetries(pair.stok_mali, pair.kategori);
        await upsertClassification(pool, result);
        jobState.success++;
      } catch (e) {
        jobState.failed++;
        jobState.lastError = e.message || String(e);
        try {
          await upsertClassification(pool, {
            stok_mali: pair.stok_mali,
            kategori: pair.kategori,
            protein_bucket: 'diger',
            food_group: 'diger',
            confidence: 'düşük',
            gerekce: 'Veritabanı kaydı başarısız',
            notes: (e.message || String(e)).slice(0, 2000),
            model_name: null,
            prompt_version: PROMPT_VERSION,
            raw_response: null
          });
        } catch (_) { /* ignore */ }
      }
      const dt = Date.now() - t0;
      jobState.latenciesMs.push(dt);
      if (jobState.latenciesMs.length > 100) jobState.latenciesMs.shift();
      jobState.processed++;
    }

    if (jobState.pauseRequested) {
      jobState.pauseReason = 'Kullanıcı duraklattı';
    }
  } catch (err) {
    jobState.lastError = err.message || String(err);
    console.error('classify job:', err);
  } finally {
    jobState.running = false;
    jobState.pauseRequested = false;
  }
}

function requestPause() {
  jobState.pauseRequested = true;
}

module.exports = {
  sqlAllPairsCTE,
  countPairStats,
  fetchNextPair,
  upsertClassification,
  getJobState,
  runJobLoop,
  requestPause,
  SQL_EXC_YIYECEK
};
