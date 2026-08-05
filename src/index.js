'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const multer = require('multer');
const { parse: parseCsvSync } = require('csv-parse/sync');
const { buildTalepAnaliz, fetchParetoEsikUrunleri, PARETO_ESIK_ALLOWED } = require('./talepAnaliz');
const { parseExcelToRows, normalizeTuketimRowForDb } = require('./excelImport');
const {
  countPairStats,
  getJobState,
  runJobLoop,
  requestPause
} = require('./classifyWorker');
const menuEngineering = require('./menuEngineering');
const { normalizeTipInput, tipFilterSql } = require('./tipLabels');
const {
  ensureBootstrapUsers,
  isAuthed,
  attachUser,
  registerAuthRoutes,
} = require('./auth');

const app = express();
const PORT = parseInt(process.env.PORT) || 3010;

const PUBLIC_DIR = path.join(__dirname, '../public');

function sendNoStoreIndexHtml(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
}

// ── DB Bağlantısı ─────────────────────────────────────────────────────────────
const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'voyagestars',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

/** __DUZELTME__ / __KDV_ILAVE__: tutar toplamlarında dahil. Pax başı TL/EUR özetleri SUM(tutar)/pax (net). Gram/cl ve ürün sorgularında sanal tüketim yok. */
const STOK_NO_DUZELTME = '__DUZELTME__';
const STOK_NO_KDV_ILAVE = '__KDV_ILAVE__';
const SQL_EXC_FINANS_PP = `(stok_no IS DISTINCT FROM '${STOK_NO_DUZELTME}' AND stok_no IS DISTINCT FROM '${STOK_NO_KDV_ILAVE}')`;
const ALARM_METRIK_TUTAR = new Set(['tutar_tl', 'tutar_eur']);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

app.use(attachUser);

// Cost Analysis giriş: tüm API'ler oturumsuz bloklanır (upload / KPI / USDA proxy dahil)
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (req.path === '/api/auth/login' && req.method === 'POST') return next();
  if (req.path === '/api/auth/logout' && req.method === 'POST') return next();
  if (!isAuthed(req)) return res.status(401).json({ error: 'Oturum gerekli' });
  next();
});

registerAuthRoutes(app, pool);

// ── USDA besin servisi proxy (nutrition_service FastAPI, varsayılan 127.0.0.1:3012) ──
const NUTRITION_SERVICE_URL = (process.env.NUTRITION_SERVICE_URL || 'http://127.0.0.1:3012').replace(
  /\/+$/,
  ''
);

async function pingNutritionServiceHealth() {
  const base = NUTRITION_SERVICE_URL;
  const url = `${base}/api/nutrition/health`;
  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 5500);
    let r;
    try {
      r = await fetch(url, { signal: ac.signal });
    } finally {
      clearTimeout(to);
    }
    const body = await r.json().catch(() => null);
    return {
      nutrition_service_base: base,
      backend_reachable: r.ok === true,
      backend_http_status: r.status,
      health: body && typeof body === 'object' ? body : null,
      detail: r.ok ? null : (typeof body === 'object' ? body : `HTTP ${r.status}`),
    };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    return {
      nutrition_service_base: base,
      backend_reachable: false,
      backend_http_status: null,
      health: null,
      detail: msg,
      hint_tr:
        'Node bu URL\'ye bağlanamıyor. Sunucuda: curl -sS \'' +
        base +
        "/api/nutrition/health' — uvicorn (3012) çalışmalı. Docker ise `NUTRITION_SERVICE_URL` iç servis adresi olmalı (127.0.0.1 yalnız aynı process network'ünde).",
    };
  }
}

/** Giriş yapılmış istemci için: Python nutrition_service erişimi (502 teşhis). */
app.get('/api/nutrition/backend-status', async (req, res) => {
  const out = await pingNutritionServiceHealth();
  return res.json(out);
});

app.use(async (req, res, next) => {
  if (
    req.originalUrl &&
    typeof req.originalUrl === 'string' &&
    req.originalUrl.startsWith('/api/nutrition')
  ) {
    try {
      const target = `${NUTRITION_SERVICE_URL}${req.originalUrl}`;
      const headers = {
        Accept: req.headers.accept || 'application/json',
      };
      if (req.headers['accept-language']) {
        headers['Accept-Language'] = req.headers['accept-language'];
      }
      const init = {
        method: req.method,
        headers,
      };
      let signal;
      try {
        signal = AbortSignal.timeout(125000);
      } catch (_) {
        signal = undefined;
      }
      if (signal) init.signal = signal;

      const hasBody =
        !['GET', 'HEAD', 'OPTIONS'].includes(req.method || '') &&
        req.body !== undefined &&
        req.body !== null &&
        Object.keys(Object(req.body)).length > 0;
      if (hasBody) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(req.body);
      }

      const r = await fetch(target, init);
      const buf = Buffer.from(await r.arrayBuffer());
      const ct = r.headers.get('content-type');
      res.status(r.status);
      if (ct) res.setHeader('Content-Type', ct);
      return res.send(buf);
    } catch (err) {
      return res.status(502).json({
        error:
          'Besin (USDA) servisi kullanılamıyor — Python nutrition_service başlatın ve USDA_API_KEY tanımlayın.',
        detail: err && err.message ? err.message : String(err),
      });
    }
  }
  return next();
});

app.get('/', (req, res) => {
  if (!isAuthed(req)) return res.redirect(302, '/login.html');
  sendNoStoreIndexHtml(req, res);
});

app.get('/index.html', (req, res) => {
  if (!isAuthed(req)) return res.redirect(302, '/login.html');
  sendNoStoreIndexHtml(req, res);
});

/** Eski kısayol → oturumsuz ise giriş sayfası */
app.get('/login', (req, res) => res.redirect(302, '/login.html'));

app.use(
  express.static(PUBLIC_DIR, {
    index: false,
    setHeaders(res, filePath) {
      if (filePath.endsWith(`${path.sep}index.html`)) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      }
    },
  })
);

// ── CSV / Excel Yükle (tek veya çoklu dosya) ────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 200 }, // 50MB / dosya, en fazla 200 dosya
  fileFilter: (req, file, cb) => {
    const n = (file.originalname || '').toLowerCase();
    if (!/\.(csv|xlsx|xlsm|xls)$/.test(n)) {
      return cb(new Error('Sadece .csv, .xlsx, .xlsm, .xls yükleyin'));
    }
    cb(null, true);
  }
});

function parseUploadFileBuffer(buffer, name) {
  if (/\.csv$/i.test(name)) {
    const text = buffer.toString('utf8');
    return parseCsvSync(text, { columns: true, skip_empty_lines: true, bom: true });
  }
  const { rows: excelRows, error: excelError } = parseExcelToRows(buffer, name);
  if (excelError) {
    const err = new Error(excelError);
    err.code = 'PARSE';
    err.file = name;
    throw err;
  }
  return excelRows;
}

// ── API: CSV / Excel Yükle ───────────────────────────────────────────────────
app.post(
  '/api/upload',
  (req, res, next) => {
    // files[]: çoklu; file / csv: tek dosya (eski istemciler)
    upload.fields([{ name: 'files', maxCount: 200 }, { name: 'file', maxCount: 1 }, { name: 'csv', maxCount: 1 }])(
      req,
      res,
      (err) => {
        if (err) return res.status(400).json({ error: err.message || 'Dosya yüklenemedi' });
        next();
      }
    );
  },
  async (req, res) => {
  const bag = req.files || {};
  const fromMulti = Array.isArray(bag.files) ? bag.files : [];
  const fromSingle = (Array.isArray(bag.file) ? bag.file[0] : null) || (Array.isArray(bag.csv) ? bag.csv[0] : null);
  const fileList = fromMulti.length
    ? fromMulti
    : fromSingle
      ? [fromSingle]
      : [];
  if (!fileList.length) {
    return res.status(400).json({ error: 'Dosya bulunamadı' });
  }

  let rows = [];

  try {
    for (const f of fileList) {
      const name = f.originalname || 'dosya';
      let part;
      try {
        part = parseUploadFileBuffer(f.buffer, name);
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        return res.status(400).json({ error: `${name}: ${msg}` });
      }
      if (!part.length) {
        return res.status(400).json({ error: `${name}: boş veya hatalı format` });
      }
      rows = rows.concat(part);
    }

    rows = rows.map(normalizeTuketimRowForDb);

    // Yüklenen dönemleri bul ve sil (yeniden yükleme desteği)
    const donemler = [...new Set(rows.map(r => `${r.tarih_str}__${r.tip}`))];
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      for (const d of donemler) {
        const [tarih_str, tip] = d.split('__');
        await client.query(
          'DELETE FROM fb_cost.tuketim WHERE tarih_str = $1 AND tip = $2',
          [tarih_str, tip]
        );
      }

      // Toplu insert
      const BATCH = 500;
      let inserted = 0;

      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        const values = [];
        const params = [];
        let p = 1;

        for (const r of batch) {
          values.push(`($${p},$${p+1},$${p+2},$${p+3},$${p+4},$${p+5},$${p+6},$${p+7},$${p+8},$${p+9},$${p+10},$${p+11},$${p+12},$${p+13},$${p+14},$${p+15})`);
          params.push(
            r.dosya, r.tip, r.tarih_str,
            parseInt(r.yil) || null, parseInt(r.ay_no) || null, r.ay, parseInt(r.gun) || null,
            parseFloat(r.cost_pax) || null, parseFloat(r.kur) || null,
            r.kategori || null, r.grup || null, r.stok_mali, r.stok_no || null, r.birim || null,
            parseFloat(r.tuk_miktar) || 0, parseFloat(r.birim_fiyat) || 0
          );
          p += 16;
        }

        await client.query(
          `INSERT INTO fb_cost.tuketim
           (dosya,tip,tarih_str,yil,ay_no,ay,gun,cost_pax,kur,kategori,grup,stok_mali,stok_no,birim,
            tuk_miktar,birim_fiyat)
           VALUES ${values.join(',')}`,
          params
        );
        inserted += batch.length;
      }

      await client.query('COMMIT');

      res.json({
        ok: true,
        inserted,
        donemler: donemler.length,
        dosya_sayisi: fileList.length,
        mesaj: `${fileList.length} dosya, ${inserted} satır, ${donemler.length} dönem yüklendi`
      });

    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

  } catch (err) {
    console.error('Upload hatası:', err);
    res.status(500).json({ error: err.message });
  }
  }
);

// ── API: Özet KPI'lar ─────────────────────────────────────────────────────────
app.get('/api/ozet', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        tarih_str, yil, ay_no, tip,
        MAX(cost_pax) AS cost_pax,
        MAX(kur)      AS kur,
        SUM(tutar_tl) AS toplam_tl,
        SUM(tutar_eur) AS toplam_eur,
        SUM(CASE WHEN ${SQL_EXC_FINANS_PP} AND tip='yiyecek' THEN pp_gr ELSE 0 END) AS toplam_pp_gr,
        CASE
          WHEN tip IN ('icenek', 'icecek') THEN
            (100.0 * SUM(CASE WHEN ${SQL_EXC_FINANS_PP} THEN tuk_miktar ELSE 0 END)
             / NULLIF(MAX(cost_pax), 0))
          ELSE 0::numeric
        END AS toplam_pp_cl,
        (SUM(tutar_tl)  / NULLIF(MAX(cost_pax), 0)) AS toplam_pp_tl,
        (SUM(tutar_eur) / NULLIF(MAX(cost_pax), 0)) AS toplam_pp_eur
      FROM fb_cost.tuketim
      GROUP BY tarih_str, yil, ay_no, tip
      ORDER BY yil, ay_no, tip
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: Kategori içi ürünler (pax başı TL/EUR, dönem + tip + tam kategori adı) ─
app.get('/api/kategoriler/urunler', async (req, res) => {
  const { tarih, tip, kategori } = req.query;
  if (!tarih || !tip || kategori == null || String(kategori).trim() === '') {
    return res.status(400).json({ error: 'tarih, tip ve kategori parametreleri gerekli' });
  }
  const tipN = normalizeTipInput(String(tip).trim());
  if (!tipN || (tipN !== 'yiyecek' && tipN !== 'icenek')) {
    return res.status(400).json({ error: 'tip: yiyecek veya içecek olmalı' });
  }
  try {
    /** Tek şablon: tip $2 ile filtre ve pp_gr / pp_cl (önceki ayrı string parçası AS hatasına yol açıyordu). */
    const params = [tarih, tipN, String(kategori).trim()];
    const { rows } = await pool.query(
      `
      SELECT
        stok_mali,
        SUM(tutar_tl) AS tutar_tl,
        SUM(tutar_eur) AS tutar_eur,
        (SUM(tutar_tl) / NULLIF(MAX(cost_pax), 0)) AS pp_tl,
        (SUM(tutar_eur) / NULLIF(MAX(cost_pax), 0)) AS pp_eur,
        (SUM(CASE WHEN ${SQL_EXC_FINANS_PP} THEN COALESCE(birim_fiyat, 0) * COALESCE(tuk_miktar, 0) ELSE 0 END)
          / NULLIF(SUM(CASE WHEN ${SQL_EXC_FINANS_PP} THEN COALESCE(tuk_miktar, 0) ELSE 0 END), 0))::numeric AS birim_fiyat_ort_tl,
        (SUM(CASE WHEN ${SQL_EXC_FINANS_PP} AND COALESCE(kur, 0) > 0
              THEN (COALESCE(birim_fiyat, 0) / NULLIF(kur, 0)) * COALESCE(tuk_miktar, 0) ELSE 0 END)
          / NULLIF(SUM(CASE WHEN ${SQL_EXC_FINANS_PP} THEN COALESCE(tuk_miktar, 0) ELSE 0 END), 0))::numeric AS birim_fiyat_ort_eur,
        CASE
          WHEN $2::text = 'yiyecek' THEN
            (SUM(CASE WHEN ${SQL_EXC_FINANS_PP} THEN tuk_miktar ELSE 0 END) / NULLIF(MAX(cost_pax), 0))::numeric
          ELSE NULL::numeric
        END AS pp_gr,
        CASE
          WHEN $2::text = 'icenek' THEN
            (100.0 * SUM(CASE WHEN ${SQL_EXC_FINANS_PP} THEN tuk_miktar ELSE 0 END)
              / NULLIF(MAX(cost_pax), 0))::numeric
          ELSE NULL::numeric
        END AS pp_cl
      FROM fb_cost.tuketim
      WHERE tarih_str = $1
        AND kategori = $3
        AND (${SQL_EXC_FINANS_PP})
        AND (
          ($2::text = 'yiyecek' AND tip = 'yiyecek')
          OR ($2::text = 'icenek' AND tip IN ('icenek', 'icecek'))
        )
      GROUP BY stok_mali
      HAVING COALESCE(ABS(SUM(tutar_tl)), 0) + COALESCE(ABS(SUM(tutar_eur)), 0) > 0
      ORDER BY (SUM(tutar_tl) / NULLIF(MAX(cost_pax), 0)) DESC NULLS LAST
      `,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('kategoriler/urunler:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Kategori Dağılımı ────────────────────────────────────────────────────
app.get('/api/kategoriler', async (req, res) => {
  const { tarih, tip } = req.query;
  try {
    let where = 'WHERE kategori IS NOT NULL';
    const params = [];
    if (tarih) { where += ` AND tarih_str = $${params.length+1}`; params.push(tarih); }
    const tipF = tipFilterSql(params, tip);
    where += tipF.clause;

    const { rows } = await pool.query(`
      SELECT kategori, SUM(tutar_tl) AS tutar_tl, SUM(tutar_eur) AS tutar_eur
      FROM fb_cost.tuketim ${where}
      GROUP BY kategori ORDER BY tutar_tl DESC
    `, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: Ürün — dönemler boyunca kişi başı hacim (içecek: cL → gösterimde ×10 mL; yiyecek: kg tabanı → g/pax).
// Tip atlanırsa her iki seri de döner. Tam ay ve −15g kısmi dönemler birlikte gelir (15g filtresi yok).
app.get('/api/urun/pax-hacim-seri', async (req, res) => {
  const tipRaw = String(req.query.tip || '').trim();
  const tipNorm = tipRaw ? normalizeTipInput(tipRaw) : null;
  const stok_mali = String(req.query.stok_mali || '').trim();
  if (!stok_mali) {
    return res.status(400).json({ error: 'stok_mali gerekli' });
  }
  if (tipRaw && !tipNorm) {
    return res.status(400).json({ error: 'tip geçersiz (yiyecek veya içecek)' });
  }
  try {
    if (tipNorm === 'yiyecek' || tipNorm === 'icenek') {
      const { rows } = await pool.query(
        `
        SELECT
          tarih_str,
          yil,
          ay_no,
          MAX(ay) AS ay,
          MAX(cost_pax) AS cost_pax,
          CASE
            WHEN $2::text = 'icenek' THEN
              (100.0 * SUM(CASE WHEN ${SQL_EXC_FINANS_PP} THEN tuk_miktar ELSE 0 END) / NULLIF(MAX(cost_pax), 0))
            ELSE NULL::numeric
          END AS pp_cl,
          CASE
            WHEN $2::text = 'yiyecek' THEN
              (SUM(CASE WHEN ${SQL_EXC_FINANS_PP} THEN tuk_miktar ELSE 0 END) / NULLIF(MAX(cost_pax), 0))
            ELSE NULL::numeric
          END AS pp_gr
        FROM fb_cost.tuketim
        WHERE stok_mali = $1
          AND (
            ($2::text = 'icenek' AND tip IN ('icenek', 'icecek'))
            OR ($2::text = 'yiyecek' AND tip = 'yiyecek')
          )
        GROUP BY tarih_str, yil, ay_no
        HAVING SUM(CASE WHEN ${SQL_EXC_FINANS_PP} THEN 1 ELSE 0 END) > 0
        ORDER BY yil ASC, ay_no ASC, tarih_str ASC
        `,
        [stok_mali, tipNorm]
      );
      return res.json(rows);
    }

    const { rows } = await pool.query(
      `
      SELECT
        tarih_str,
        yil,
        ay_no,
        MAX(ay) AS ay,
        MAX(cost_pax) AS cost_pax,
        (100.0 * SUM(CASE WHEN tip IN ('icenek', 'icecek') AND ${SQL_EXC_FINANS_PP} THEN tuk_miktar ELSE 0 END)
          / NULLIF(MAX(cost_pax), 0))::numeric AS pp_cl,
        (SUM(CASE WHEN tip = 'yiyecek' AND ${SQL_EXC_FINANS_PP} THEN tuk_miktar ELSE 0 END)
          / NULLIF(MAX(cost_pax), 0))::numeric AS pp_gr
      FROM fb_cost.tuketim
      WHERE stok_mali = $1
      GROUP BY tarih_str, yil, ay_no
      HAVING SUM(CASE WHEN ${SQL_EXC_FINANS_PP} THEN 1 ELSE 0 END) > 0
      ORDER BY yil ASC, ay_no ASC, tarih_str ASC
      `,
      [stok_mali]
    );
    res.json(rows);
  } catch (err) {
    console.error('urun/pax-hacim-seri:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Ürün Arama ───────────────────────────────────────────────────────────
app.get('/api/urun', async (req, res) => {
  const { q, tip } = req.query;
  if (!q) return res.json([]);
  try {
    const params = [`%${q}%`];
    const tipF = tipFilterSql(params, tip);
    const { rows } = await pool.query(`
      SELECT tarih_str, yil, ay_no, tip, stok_mali, kategori, grup,
             tuk_miktar, birim, birim_fiyat, tutar_tl, tutar_eur,
             pp_gr, pp_cl, pp_tl, pp_eur, cost_pax, kur
      FROM fb_cost.tuketim
      WHERE stok_mali ILIKE $1 ${tipF.clause}
        AND tutar_tl > 0
      ORDER BY yil DESC, ay_no DESC
      LIMIT 200
    `, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: Dönem Listesi ────────────────────────────────────────────────────────
app.get('/api/donemler', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT tarih_str, yil, ay_no, ay,
             MAX(cost_pax) AS cost_pax, MAX(kur) AS kur,
             SUM(CASE WHEN tip = 'yiyecek' AND ${SQL_EXC_FINANS_PP} THEN 1 ELSE 0 END)::int AS yiyecek_satir,
             SUM(CASE WHEN tip IN ('icenek', 'icecek') AND ${SQL_EXC_FINANS_PP} THEN 1 ELSE 0 END)::int AS icenek_satir
      FROM fb_cost.tuketim
      GROUP BY tarih_str, yil, ay_no, ay
      ORDER BY yil DESC, ay_no DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Belirli dönem (tarih_str) için satırları siler. tip=yiyecek|icenek → yalnız o veri seti; tip yok → tümü
app.delete('/api/donemler', async (req, res) => {
  const tarih_str = (req.query.tarih_str || '').trim();
  const tipQ = String(req.query.tip || '').trim();
  const tipN = tipQ ? normalizeTipInput(tipQ) : null;
  if (!tarih_str) {
    return res.status(400).json({ error: 'tarih_str parametresi gerekli' });
  }
  if (!/^\d{4}-\d{2}(-15g)?$/.test(tarih_str)) {
    return res.status(400).json({ error: 'Geçersiz tarih_str' });
  }
  if (tipQ && !tipN) {
    return res.status(400).json({ error: 'tip: yiyecek veya içecek olmalı' });
  }
  try {
    let sql = 'DELETE FROM fb_cost.tuketim WHERE tarih_str = $1';
    const params = [tarih_str];
    if (tipN === 'yiyecek') {
      sql += ' AND tip = $2';
      params.push('yiyecek');
    } else if (tipN === 'icenek') {
      sql += ' AND tip IN ($2, $3)';
      params.push('icenek', 'icecek');
    }
    const { rowCount } = await pool.query(sql, params);
    return res.json({ ok: true, silinen: rowCount, tarih_str, tip: tipN || null });
  } catch (err) {
    console.error('donemler DELETE:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── API: Alarmlar ─────────────────────────────────────────────────────────────
app.get('/api/alarmlar', async (req, res) => {
  try {
    // Son dönem verisiyle alarm kontrolü
    const { rows: son } = await pool.query(`
      SELECT tarih_str FROM fb_cost.tuketim
      ORDER BY yil DESC, ay_no DESC LIMIT 1
    `);
    if (!son.length) return res.json([]);

    const sonDonem = son[0].tarih_str;
    const { rows: esikler } = await pool.query(
      'SELECT * FROM fb_cost.alarm_esikleri WHERE aktif = TRUE'
    );

    const tetiklenenler = [];

    for (const esik of esikler) {
      let where = `WHERE tarih_str = $1`;
      const params = [sonDonem];
      if (esik.tip) { where += ` AND tip = $${params.length+1}`; params.push(esik.tip); }
      if (esik.kategori) { where += ` AND kategori = $${params.length+1}`; params.push(esik.kategori); }
      if (esik.stok_mali) { where += ` AND stok_mali ILIKE $${params.length+1}`; params.push(esik.stok_mali); }
      if (!ALARM_METRIK_TUTAR.has(esik.metrik)) {
        where += ` AND (${SQL_EXC_FINANS_PP})`;
      }

      const { rows } = await pool.query(
        `SELECT SUM(${esik.metrik}) AS deger FROM fb_cost.tuketim ${where}`,
        params
      );

      const deger = parseFloat(rows[0]?.deger) || 0;
      const tetiklendi = esik.yon === 'yukari' ? deger > esik.esik_deger : deger < esik.esik_deger;

      if (tetiklendi) {
        tetiklenenler.push({
          alarm: esik.ad,
          metrik: esik.metrik,
          esik: esik.esik_deger,
          gerceklesen: deger,
          yon: esik.yon,
          donem: sonDonem
        });
      }
    }

    res.json(tetiklenenler);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Alarm eşiği ekle/listele
app.get('/api/alarmlar/esikler', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM fb_cost.alarm_esikleri ORDER BY id');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/alarmlar/esikler', async (req, res) => {
  const { ad, tip, metrik, kategori, stok_mali, esik_deger, yon } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO fb_cost.alarm_esikleri (ad, tip, metrik, kategori, stok_mali, esik_deger, yon)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [ad, tip || null, metrik, kategori || null, stok_mali || null, esik_deger, yon || 'yukari']
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/alarmlar/esikler/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM fb_cost.alarm_esikleri WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: Fiyat Analizi — arama kutusu için ürün adayları (chip) ───────────────
app.get('/api/fiyat-analizi/urun-adaylari', async (req, res) => {
  const q = (req.query.q || '').trim();
  const tip = req.query.tip;
  if (!q) return res.json([]);
  try {
    const params = [`%${q}%`];
    let where = `WHERE stok_mali ILIKE $1 AND birim_fiyat > 0 AND (${SQL_EXC_FINANS_PP})`;
    const tipF = tipFilterSql(params, tip);
    where += tipF.clause;
    const { rows } = await pool.query(
      `
      SELECT DISTINCT ON (stok_mali) stok_mali, tip, kategori
      FROM fb_cost.tuketim
      ${where}
      ORDER BY stok_mali, yil DESC, ay_no DESC
      LIMIT 35
      `,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('fiyat-analizi/urun-adaylari:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Fiyat Analizi — ürün bazında dönemsel birim fiyat serisi ────────────
app.get('/api/fiyat-analizi', async (req, res) => {
  const { stok_mali, tip } = req.query;
  const tam = req.query.tam === '1' || req.query.tam === 'true';
  if (!stok_mali || !stok_mali.trim()) {
    return res.status(400).json({ error: 'stok_mali parametresi zorunlu' });
  }
  try {
    const raw = stok_mali.trim();
    const params = [];
    let where = '';
    if (tam) {
      params.push(raw);
      where = `WHERE stok_mali = $1 AND birim_fiyat > 0 AND (${SQL_EXC_FINANS_PP})`;
    } else {
      params.push(`%${raw}%`);
      where = `WHERE stok_mali ILIKE $1 AND birim_fiyat > 0 AND (${SQL_EXC_FINANS_PP})`;
    }
    const tipF = tipFilterSql(params, tip);
    where += tipF.clause;

    const { rows } = await pool.query(`
      SELECT
        tarih_str, yil, ay_no, tip, kategori, stok_mali, birim,
        AVG(birim_fiyat)::NUMERIC AS birim_fiyat,
        AVG(NULLIF(kur, 0))::NUMERIC AS kur,
        CASE
          WHEN AVG(NULLIF(kur, 0)) > 0
          THEN (AVG(birim_fiyat) / AVG(NULLIF(kur, 0)))::NUMERIC
          ELSE NULL
        END AS birim_fiyat_eur
      FROM fb_cost.tuketim
      ${where}
      GROUP BY tarih_str, yil, ay_no, tip, kategori, stok_mali, birim
      ORDER BY yil, ay_no, stok_mali
    `, params);

    res.json(rows);
  } catch (err) {
    console.error('fiyat-analizi hatası:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Fiyat Analizi — kategori bazında dönemler arası değişim ─────────────
app.get('/api/fiyat-analizi/kategoriler', async (req, res) => {
  const { tarih_baslangic, tarih_bitis, tip } = req.query;
  try {
    const params = [];
    let where = `WHERE birim_fiyat > 0 AND kategori IS NOT NULL AND tarih_str NOT LIKE '%-15g' AND (${SQL_EXC_FINANS_PP})`;
    if (tarih_baslangic) {
      where += ` AND tarih_str >= $${params.length + 1}`;
      params.push(tarih_baslangic);
    }
    let bitisParamNum = null;
    if (tarih_bitis) {
      bitisParamNum = params.length + 1;
      where += ` AND tarih_str <= $${bitisParamNum}`;
      params.push(tarih_bitis);
    }
    const tipF = tipFilterSql(params, tip);
    where += tipF.clause;

    const histBitisClause = bitisParamNum != null ? ` AND t.tarih_str <= $${bitisParamNum}` : '';
    const tipHistAliased = tipF.clause ? tipF.clause.replace(/\btip\b/g, 't.tip') : '';

    // Dönem etiketleri: aralıkta kategori başına en erken / en geç ay (önceki mantık).
    // Rakamlar: yalnızca hem "referans" hem son dönem fiyatı olan SKU'lar;
    // referans = ilk_dönemde fiyat varsa o, yoksa son_dönemden önceki en yakın ay (tarih_bitis’e kadar).
    const { rows } = await pool.query(
      `
      WITH donemler AS (
        SELECT
          kategori,
          tarih_str,
          yil, ay_no,
          AVG(birim_fiyat)::NUMERIC AS ort_tl,
          CASE WHEN AVG(NULLIF(kur, 0)) > 0
               THEN (AVG(birim_fiyat) / AVG(NULLIF(kur, 0)))::NUMERIC
               ELSE NULL END AS ort_eur
        FROM fb_cost.tuketim
        ${where}
        GROUP BY kategori, tarih_str, yil, ay_no
      ),
      siralanmis AS (
        SELECT
          kategori, tarih_str, yil, ay_no, ort_tl, ort_eur,
          ROW_NUMBER() OVER (PARTITION BY kategori ORDER BY yil, ay_no) AS rn_ilk,
          ROW_NUMBER() OVER (PARTITION BY kategori ORDER BY yil DESC, ay_no DESC) AS rn_son
        FROM donemler
      ),
      ilk AS (SELECT kategori, tarih_str AS ilk_donem, ort_tl AS ilk_tl, ort_eur AS ilk_eur FROM siralanmis WHERE rn_ilk = 1),
      son AS (SELECT kategori, tarih_str AS son_donem, ort_tl AS son_tl, ort_eur AS son_eur FROM siralanmis WHERE rn_son = 1),
      hist AS (
        SELECT
          t.kategori,
          t.stok_mali,
          t.tarih_str,
          t.yil,
          t.ay_no,
          AVG(t.birim_fiyat)::NUMERIC AS ort_tl,
          CASE WHEN AVG(NULLIF(t.kur, 0)) > 0
               THEN (AVG(t.birim_fiyat) / AVG(NULLIF(t.kur, 0)))::NUMERIC
               ELSE NULL END AS ort_eur
        FROM fb_cost.tuketim t
        WHERE t.birim_fiyat > 0
          AND t.kategori IS NOT NULL
          AND t.tarih_str NOT LIKE '%-15g'
          AND (${SQL_EXC_FINANS_PP})
          ${histBitisClause}
          ${tipHistAliased}
        GROUP BY t.kategori, t.stok_mali, t.tarih_str, t.yil, t.ay_no
      ),
      sku_son AS (
        SELECT h.kategori, h.stok_mali, h.ort_tl AS son_tl, h.ort_eur AS son_eur
        FROM hist h
        JOIN son s ON s.kategori = h.kategori AND h.tarih_str = s.son_donem
      ),
      son_meta AS (
        SELECT h.kategori, MAX(h.yil) AS sy, MAX(h.ay_no) AS sm
        FROM hist h
        JOIN son s ON s.kategori = h.kategori AND h.tarih_str = s.son_donem
        GROUP BY h.kategori
      ),
      sku_ilk_try AS (
        SELECT h.kategori, h.stok_mali, h.ort_tl AS ilk_tl, h.ort_eur AS ilk_eur
        FROM hist h
        JOIN ilk i ON i.kategori = h.kategori AND h.tarih_str = i.ilk_donem
      ),
      sku_ref_lb AS (
        SELECT DISTINCT ON (ss.kategori, ss.stok_mali)
          ss.kategori,
          ss.stok_mali,
          h.tarih_str AS ref_ts,
          h.ort_tl AS ref_tl,
          h.ort_eur AS ref_eur
        FROM sku_son ss
        JOIN son_meta sm ON sm.kategori = ss.kategori
        JOIN hist h ON h.kategori = ss.kategori
          AND h.stok_mali = ss.stok_mali
          AND (h.yil < sm.sy OR (h.yil = sm.sy AND h.ay_no < sm.sm))
        ORDER BY ss.kategori, ss.stok_mali, h.yil DESC, h.ay_no DESC, h.tarih_str DESC
      ),
      sku_resolved AS (
        SELECT
          ss.kategori,
          ss.stok_mali,
          ss.son_tl,
          ss.son_eur,
          COALESCE(NULLIF(it.ilk_tl, 0), lb.ref_tl) AS ref_tl,
          COALESCE(NULLIF(it.ilk_eur, 0), lb.ref_eur) AS ref_eur
        FROM sku_son ss
        LEFT JOIN sku_ilk_try it ON it.kategori = ss.kategori AND it.stok_mali = ss.stok_mali
        LEFT JOIN sku_ref_lb lb ON lb.kategori = ss.kategori AND lb.stok_mali = ss.stok_mali
        WHERE COALESCE(NULLIF(it.ilk_tl, 0), lb.ref_tl) IS NOT NULL
          AND COALESCE(NULLIF(it.ilk_tl, 0), lb.ref_tl) > 0
          AND ss.son_tl IS NOT NULL
          AND ss.son_tl > 0
      ),
      sku_fin AS (
        SELECT
          kategori,
          COUNT(*)::int AS n_urun,
          AVG(ref_tl) AS ref_avg_tl,
          AVG(son_tl) AS son_avg_tl,
          AVG(ref_eur) AS ref_avg_eur,
          AVG(son_eur) AS son_avg_eur
        FROM sku_resolved
        GROUP BY kategori
      )
      SELECT
        ik.kategori,
        ik.ilk_donem,
        sn.son_donem,
        sf.ref_avg_tl  AS ilk_donem_fiyat,
        sf.son_avg_tl  AS son_donem_fiyat,
        sf.ref_avg_eur AS ilk_donem_fiyat_eur,
        sf.son_avg_eur AS son_donem_fiyat_eur,
        sf.n_urun,
        CASE WHEN sf.ref_avg_tl > 0
             THEN ((sf.son_avg_tl - sf.ref_avg_tl) / sf.ref_avg_tl * 100)::NUMERIC
             ELSE NULL END AS degisim_yuzde,
        CASE WHEN sf.ref_avg_eur > 0
             THEN ((sf.son_avg_eur - sf.ref_avg_eur) / sf.ref_avg_eur * 100)::NUMERIC
             ELSE NULL END AS degisim_eur_yuzde
      FROM ilk ik
      JOIN son sn USING (kategori)
      LEFT JOIN sku_fin sf ON sf.kategori = ik.kategori
      ORDER BY ABS(COALESCE(((sf.son_avg_tl - sf.ref_avg_tl) / NULLIF(sf.ref_avg_tl, 0) * 100), 0)) DESC NULLS LAST
      `,
      params
    );

    res.json(rows);
  } catch (err) {
    console.error('fiyat-analizi/kategoriler hatası:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Kategori detayı: son_dönem fiyatı olan ürünler; referans = ilk_dönemde fiyat yoksa son’dan önceki en yakın ay.
 * Referansı hiç olmayan ürünler listelenmez (kategori toplamına da girmez).
 */
app.get('/api/fiyat-analizi/kategori-urunleri', async (req, res) => {
  const kategori = (req.query.kategori || '').trim();
  const ilk = (req.query.ilk_donem || '').trim();
  const son = (req.query.son_donem || '').trim();
  const tip = req.query.tip;
  if (!kategori) return res.status(400).json({ error: 'kategori zorunlu' });
  if (!ilk || !son) return res.status(400).json({ error: 'ilk_donem ve son_donem zorunlu' });
  const re = /^\d{4}-\d{2}(-15g)?$/;
  if (!re.test(ilk) || !re.test(son)) return res.status(400).json({ error: 'Geçersiz dönem' });
  try {
    const params = [kategori, ilk, son];
    const tipF = tipFilterSql(params, tip);
    if (!tipF.ok) return res.json([]);
    const tipAliased = tipF.clause ? tipF.clause.replace(/\btip\b/g, 't.tip') : '';
    let catWhere = `WHERE t.kategori = $1 AND t.tarih_str <= $3 AND t.birim_fiyat > 0 AND t.tarih_str NOT LIKE '%-15g' AND (${SQL_EXC_FINANS_PP})`;
    catWhere += tipAliased;

    const { rows } = await pool.query(
      `
      WITH cat_base AS (
        SELECT
          t.stok_mali,
          t.tarih_str,
          t.yil,
          t.ay_no,
          AVG(t.birim_fiyat)::NUMERIC AS ort_tl,
          CASE
            WHEN AVG(NULLIF(t.kur, 0)) > 0
            THEN (AVG(t.birim_fiyat) / AVG(NULLIF(t.kur, 0)))::NUMERIC
            ELSE NULL
          END AS ort_eur
        FROM fb_cost.tuketim t
        ${catWhere}
        GROUP BY t.stok_mali, t.tarih_str, t.yil, t.ay_no
      ),
      son_meta AS (
        SELECT MAX(yil) AS sy, MAX(ay_no) AS sm FROM cat_base WHERE tarih_str = $3
      ),
      son_row AS (
        SELECT stok_mali, ort_tl, ort_eur FROM cat_base WHERE tarih_str = $3
      ),
      ilk_row AS (
        SELECT stok_mali, ort_tl, ort_eur FROM cat_base WHERE tarih_str = $2
      ),
      before_son AS (
        SELECT cb.*
        FROM cat_base cb
        CROSS JOIN son_meta sm
        WHERE cb.yil < sm.sy OR (cb.yil = sm.sy AND cb.ay_no < sm.sm)
      ),
      latest_ref AS (
        SELECT DISTINCT ON (stok_mali)
          stok_mali,
          tarih_str AS ref_ts,
          ort_tl AS ref_tl,
          ort_eur AS ref_eur
        FROM before_son
        ORDER BY stok_mali, yil DESC, ay_no DESC, tarih_str DESC
      ),
      ref_merged AS (
        SELECT
          sr.stok_mali,
          sr.ort_tl AS son_tl,
          sr.ort_eur AS son_eur,
          COALESCE(NULLIF(ir.ort_tl, 0), lr.ref_tl) AS ref_tl,
          COALESCE(NULLIF(ir.ort_eur, 0), lr.ref_eur) AS ref_eur,
          CASE
            WHEN ir.ort_tl IS NOT NULL AND ir.ort_tl > 0 THEN $2::text
            ELSE lr.ref_ts
          END AS ref_donem
        FROM son_row sr
        LEFT JOIN ilk_row ir ON ir.stok_mali = sr.stok_mali
        LEFT JOIN latest_ref lr ON lr.stok_mali = sr.stok_mali
        WHERE COALESCE(NULLIF(ir.ort_tl, 0), lr.ref_tl) IS NOT NULL
          AND COALESCE(NULLIF(ir.ort_tl, 0), lr.ref_tl) > 0
          AND sr.ort_tl IS NOT NULL
          AND sr.ort_tl > 0
      )
      SELECT
        stok_mali,
        ref_donem,
        ref_tl AS ilk_donem_fiyat,
        son_tl AS son_donem_fiyat,
        ref_eur AS ilk_donem_fiyat_eur,
        son_eur AS son_donem_fiyat_eur,
        CASE
          WHEN ref_tl > 0
          THEN ((son_tl - ref_tl) / ref_tl * 100)::NUMERIC
          ELSE NULL
        END AS degisim_yuzde,
        CASE
          WHEN ref_eur > 0
          THEN ((son_eur - ref_eur) / ref_eur * 100)::NUMERIC
          ELSE NULL
        END AS degisim_eur_yuzde
      FROM ref_merged
      ORDER BY
        ABS(COALESCE((son_tl - ref_tl) / NULLIF(ref_tl, 0) * 100, 0)) DESC NULLS LAST,
        stok_mali ASC
      `,
      params
    );

    res.json(rows);
  } catch (err) {
    console.error('fiyat-analizi/kategori-urunleri:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Miktar Analizi — arama kutusu için ürün adayları (chip) ─────────────
app.get('/api/miktar-analizi/urun-adaylari', async (req, res) => {
  const q = (req.query.q || '').trim();
  const tip = req.query.tip;
  if (!q) return res.json([]);
  try {
    const params = [`%${q}%`];
    let where = `WHERE stok_mali ILIKE $1 AND COALESCE(tuk_miktar, 0) > 0 AND (${SQL_EXC_FINANS_PP})`;
    const tipF = tipFilterSql(params, tip);
    where += tipF.clause;
    const { rows } = await pool.query(
      `
      SELECT DISTINCT ON (stok_mali) stok_mali, tip, kategori
      FROM fb_cost.tuketim
      ${where}
      ORDER BY stok_mali, yil DESC, ay_no DESC
      LIMIT 35
      `,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('miktar-analizi/urun-adaylari:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Miktar Analizi — ürün bazında dönemsel tüketim miktarı serisi ───────
app.get('/api/miktar-analizi', async (req, res) => {
  const { stok_mali, tip } = req.query;
  const tam = req.query.tam === '1' || req.query.tam === 'true';
  if (!stok_mali || !stok_mali.trim()) {
    return res.status(400).json({ error: 'stok_mali parametresi zorunlu' });
  }
  try {
    const raw = stok_mali.trim();
    const params = [];
    let where = '';
    if (tam) {
      params.push(raw);
      where = `WHERE stok_mali = $1 AND COALESCE(tuk_miktar, 0) > 0 AND (${SQL_EXC_FINANS_PP})`;
    } else {
      params.push(`%${raw}%`);
      where = `WHERE stok_mali ILIKE $1 AND COALESCE(tuk_miktar, 0) > 0 AND (${SQL_EXC_FINANS_PP})`;
    }
    const tipF = tipFilterSql(params, tip);
    where += tipF.clause;

    const { rows } = await pool.query(
      `
      SELECT
        tarih_str, yil, ay_no, tip, kategori, stok_mali, birim,
        SUM(tuk_miktar)::NUMERIC AS miktar
      FROM fb_cost.tuketim
      ${where}
      GROUP BY tarih_str, yil, ay_no, tip, kategori, stok_mali, birim
      ORDER BY yil, ay_no, stok_mali
      `,
      params
    );

    res.json(rows);
  } catch (err) {
    console.error('miktar-analizi hatası:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Miktar Analizi — kategori bazında dönemler arası kişi başı tüketim ─
// Metrik: kategori SUM(tuk_miktar) / dönem cost_pax (yiyecek: g/pax; içecek: cL/pax).
app.get('/api/miktar-analizi/kategoriler', async (req, res) => {
  const { tarih_baslangic, tarih_bitis, tip } = req.query;
  try {
    const params = [];
    let where = `WHERE COALESCE(tuk_miktar, 0) > 0 AND kategori IS NOT NULL AND tarih_str NOT LIKE '%-15g' AND (${SQL_EXC_FINANS_PP})`;
    if (tarih_baslangic) {
      where += ` AND tarih_str >= $${params.length + 1}`;
      params.push(tarih_baslangic);
    }
    let bitisParamNum = null;
    if (tarih_bitis) {
      bitisParamNum = params.length + 1;
      where += ` AND tarih_str <= $${bitisParamNum}`;
      params.push(tarih_bitis);
    }
    const tipF = tipFilterSql(params, tip);
    where += tipF.clause;

    const histBitisClause = bitisParamNum != null ? ` AND t.tarih_str <= $${bitisParamNum}` : '';
    const tipHistAliased = tipF.clause ? tipF.clause.replace(/\btip\b/g, 't.tip') : '';

    const { rows } = await pool.query(
      `
      WITH donemler AS (
        SELECT kategori, tarih_str, yil, ay_no
        FROM fb_cost.tuketim
        ${where}
        GROUP BY kategori, tarih_str, yil, ay_no
      ),
      siralanmis AS (
        SELECT
          kategori, tarih_str, yil, ay_no,
          ROW_NUMBER() OVER (PARTITION BY kategori ORDER BY yil, ay_no) AS rn_ilk,
          ROW_NUMBER() OVER (PARTITION BY kategori ORDER BY yil DESC, ay_no DESC) AS rn_son
        FROM donemler
      ),
      ilk AS (SELECT kategori, tarih_str AS ilk_donem FROM siralanmis WHERE rn_ilk = 1),
      son AS (SELECT kategori, tarih_str AS son_donem FROM siralanmis WHERE rn_son = 1),
      kat_donem AS (
        SELECT
          t.kategori,
          t.tarih_str,
          CASE
            WHEN SUM(CASE WHEN t.tip IN ('icenek', 'icecek') THEN 1 ELSE 0 END)
                 >= SUM(CASE WHEN t.tip = 'yiyecek' THEN 1 ELSE 0 END)
            THEN 'icenek'
            ELSE 'yiyecek'
          END AS tip_kind,
          SUM(t.tuk_miktar)::NUMERIC AS miktar,
          MAX(t.cost_pax)::NUMERIC AS pax,
          COUNT(DISTINCT t.stok_mali)::int AS n_sku
        FROM fb_cost.tuketim t
        WHERE COALESCE(t.tuk_miktar, 0) > 0
          AND t.kategori IS NOT NULL
          AND t.tarih_str NOT LIKE '%-15g'
          AND (${SQL_EXC_FINANS_PP})
          ${histBitisClause}
          ${tipHistAliased}
        GROUP BY t.kategori, t.tarih_str
      ),
      kat_pp AS (
        SELECT
          kategori,
          tarih_str,
          tip_kind,
          n_sku,
          pax,
          CASE
            WHEN tip_kind = 'icenek' THEN
              (100.0 * miktar / NULLIF(pax, 0))::NUMERIC
            ELSE
              (miktar / NULLIF(pax, 0))::NUMERIC
          END AS pp
        FROM kat_donem
      ),
      sku_n AS (
        SELECT
          k.kategori,
          COUNT(DISTINCT t.stok_mali)::int AS n_urun
        FROM (
          SELECT kategori, ilk_donem AS d FROM ilk
          UNION
          SELECT kategori, son_donem AS d FROM son
        ) k
        JOIN fb_cost.tuketim t
          ON t.kategori = k.kategori
         AND t.tarih_str = k.d
         AND COALESCE(t.tuk_miktar, 0) > 0
         AND (${SQL_EXC_FINANS_PP})
         ${tipHistAliased}
        GROUP BY k.kategori
      )
      SELECT
        ik.kategori,
        ik.ilk_donem,
        sn.son_donem,
        COALESCE(pi.tip_kind, ps.tip_kind) AS tip,
        pi.pp AS ilk_donem_miktar,
        ps.pp AS son_donem_miktar,
        pi.pax AS ilk_pax,
        ps.pax AS son_pax,
        COALESCE(nu.n_urun, 0) AS n_urun,
        CASE WHEN pi.pp > 0
             THEN ((ps.pp - pi.pp) / pi.pp * 100)::NUMERIC
             ELSE NULL END AS degisim_yuzde
      FROM ilk ik
      JOIN son sn USING (kategori)
      LEFT JOIN kat_pp pi ON pi.kategori = ik.kategori AND pi.tarih_str = ik.ilk_donem
      LEFT JOIN kat_pp ps ON ps.kategori = sn.kategori AND ps.tarih_str = sn.son_donem
      LEFT JOIN sku_n nu ON nu.kategori = ik.kategori
      ORDER BY ABS(COALESCE(((ps.pp - pi.pp) / NULLIF(pi.pp, 0) * 100), 0)) DESC NULLS LAST
      `,
      params
    );

    res.json(rows);
  } catch (err) {
    console.error('miktar-analizi/kategoriler hatası:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/miktar-analizi/kategori-urunleri', async (req, res) => {
  const kategori = (req.query.kategori || '').trim();
  const ilk = (req.query.ilk_donem || '').trim();
  const son = (req.query.son_donem || '').trim();
  const tip = req.query.tip;
  if (!kategori) return res.status(400).json({ error: 'kategori zorunlu' });
  if (!ilk || !son) return res.status(400).json({ error: 'ilk_donem ve son_donem zorunlu' });
  const re = /^\d{4}-\d{2}(-15g)?$/;
  if (!re.test(ilk) || !re.test(son)) return res.status(400).json({ error: 'Geçersiz dönem' });
  try {
    const params = [kategori, ilk, son];
    const tipF = tipFilterSql(params, tip);
    if (!tipF.ok) return res.json([]);
    const tipAliased = tipF.clause ? tipF.clause.replace(/\btip\b/g, 't.tip') : '';
    let catWhere = `WHERE t.kategori = $1 AND t.tarih_str IN ($2, $3) AND COALESCE(t.tuk_miktar, 0) > 0 AND t.tarih_str NOT LIKE '%-15g' AND (${SQL_EXC_FINANS_PP})`;
    catWhere += tipAliased;

    const { rows } = await pool.query(
      `
      WITH cat_base AS (
        SELECT
          t.stok_mali,
          t.tarih_str,
          CASE
            WHEN SUM(CASE WHEN t.tip IN ('icenek', 'icecek') THEN 1 ELSE 0 END)
                 >= SUM(CASE WHEN t.tip = 'yiyecek' THEN 1 ELSE 0 END)
            THEN 'icenek'
            ELSE 'yiyecek'
          END AS tip_kind,
          SUM(t.tuk_miktar)::NUMERIC AS miktar,
          MAX(t.cost_pax)::NUMERIC AS pax
        FROM fb_cost.tuketim t
        ${catWhere}
        GROUP BY t.stok_mali, t.tarih_str
      ),
      cat_pp AS (
        SELECT
          stok_mali,
          tarih_str,
          tip_kind,
          CASE
            WHEN tip_kind = 'icenek' THEN (100.0 * miktar / NULLIF(pax, 0))::NUMERIC
            ELSE (miktar / NULLIF(pax, 0))::NUMERIC
          END AS pp
        FROM cat_base
      ),
      son_row AS (
        SELECT stok_mali, tip_kind, pp AS son_pp FROM cat_pp WHERE tarih_str = $3
      ),
      ilk_row AS (
        SELECT stok_mali, tip_kind, pp AS ref_pp FROM cat_pp WHERE tarih_str = $2
      ),
      sku_keys AS (
        SELECT stok_mali FROM son_row
        UNION
        SELECT stok_mali FROM ilk_row
      ),
      ref_merged AS (
        SELECT
          k.stok_mali,
          COALESCE(sr.tip_kind, ir.tip_kind) AS tip_kind,
          COALESCE(sr.son_pp, 0) AS son_pp,
          COALESCE(ir.ref_pp, 0) AS ref_pp,
          $2::text AS ref_donem
        FROM sku_keys k
        LEFT JOIN son_row sr ON sr.stok_mali = k.stok_mali
        LEFT JOIN ilk_row ir ON ir.stok_mali = k.stok_mali
        WHERE COALESCE(ir.ref_pp, 0) > 0 OR COALESCE(sr.son_pp, 0) > 0
      )
      SELECT
        stok_mali,
        tip_kind AS tip,
        ref_donem,
        ref_pp AS ilk_donem_miktar,
        son_pp AS son_donem_miktar,
        CASE
          WHEN ref_pp > 0
          THEN ((son_pp - ref_pp) / ref_pp * 100)::NUMERIC
          ELSE NULL
        END AS degisim_yuzde
      FROM ref_merged
      ORDER BY
        GREATEST(ref_pp, son_pp) DESC,
        stok_mali ASC
      `,
      params
    );

    res.json(rows);
  } catch (err) {
    console.error('miktar-analizi/kategori-urunleri:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// YILLIK ANALİZ API'LERİ
// ─────────────────────────────────────────────────────────────────────────────

// Yardımcı: opsiyonel tip filtresi (icenek + legacy icecek)
function tipWhere(params, tip, base = '') {
  const { clause } = tipFilterSql(params, tip);
  return base + clause;
}

// ── API: Yıllık — veride mevcut yıllar ────────────────────────────────────────
app.get('/api/yillik/yil-listesi', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT yil
      FROM fb_cost.tuketim
      WHERE yil IS NOT NULL
      ORDER BY yil DESC
    `);
    res.json(rows.map(r => r.yil));
  } catch (err) {
    console.error('yillik/yil-listesi hatası:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Yıllık — Özet KPI'lar (bu yıl + önceki yıl) ──────────────────────────
// Modül 1, 2, 3: toplam maliyet, PP ort., misafir, kur, YoY %
app.get('/api/yillik/ozet', async (req, res) => {
  const yil = parseInt(req.query.yil);
  const tip = req.query.tip || null;
  if (!yil) return res.status(400).json({ error: 'yil parametresi zorunlu' });

  try {
    async function yilOzeti(y) {
      const params = [y];
      const tipFilter = tipWhere(params, tip);
      const { rows } = await pool.query(`
        WITH aylik AS (
          SELECT ay_no,
                 SUM(tutar_tl)  AS tl,
                 SUM(tutar_eur) AS eur,
                 (SUM(tutar_tl)  / NULLIF(MAX(cost_pax), 0)) AS pp_tl,
                 (SUM(tutar_eur) / NULLIF(MAX(cost_pax), 0)) AS pp_eur,
                 MAX(cost_pax)  AS cost_pax,
                 AVG(NULLIF(kur,0)) AS kur
          FROM fb_cost.tuketim
          WHERE yil = $1 AND tarih_str NOT LIKE '%-15g' ${tipFilter}
          GROUP BY ay_no
        )
        SELECT
          COALESCE(SUM(tl), 0)          AS toplam_tl,
          COALESCE(SUM(eur), 0)         AS toplam_eur,
          COALESCE(AVG(pp_tl), 0)       AS ort_pp_tl,
          COALESCE(AVG(pp_eur), 0)      AS ort_pp_eur,
          COALESCE(SUM(cost_pax), 0)    AS toplam_misafir,
          COALESCE(AVG(kur), 0)         AS ort_kur,
          COUNT(*)                      AS ay_sayisi
        FROM aylik
      `, params);
      return rows[0];
    }

    const buYil = await yilOzeti(yil);
    const onceki = await yilOzeti(yil - 1);

    function yoy(a, b) {
      const av = parseFloat(a) || 0;
      const bv = parseFloat(b) || 0;
      if (!bv) return null;
      return ((av - bv) / bv) * 100;
    }

    res.json({
      yil,
      onceki_yil: yil - 1,
      bu_yil: buYil,
      onceki_yil_veri: onceki,
      yoy: {
        toplam_tl:      yoy(buYil.toplam_tl, onceki.toplam_tl),
        toplam_eur:     yoy(buYil.toplam_eur, onceki.toplam_eur),
        ort_pp_tl:      yoy(buYil.ort_pp_tl, onceki.ort_pp_tl),
        ort_pp_eur:     yoy(buYil.ort_pp_eur, onceki.ort_pp_eur),
        toplam_misafir: yoy(buYil.toplam_misafir, onceki.toplam_misafir),
        ort_kur:        yoy(buYil.ort_kur, onceki.ort_kur),
      }
    });
  } catch (err) {
    console.error('yillik/ozet hatası:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Yıllık — Aylık Seyir (5, 6, 11) ─────────────────────────────────────
// 5: toplam TL/EUR zaman serisi
// 6: yiyecek vs içecek aylık (stacked)
// 11: YoY aylık karşılaştırma (önceki yıl aynı ay)
app.get('/api/yillik/aylik', async (req, res) => {
  const yil = parseInt(req.query.yil);
  const tip = req.query.tip || null;
  if (!yil) return res.status(400).json({ error: 'yil parametresi zorunlu' });

  try {
    async function aylik(y) {
      const params = [y];
      const tipFilter = tipWhere(params, tip);
      const { rows } = await pool.query(`
        SELECT
          ay_no,
          MAX(ay) AS ay,
          SUM(tutar_tl)  AS toplam_tl,
          SUM(tutar_eur) AS toplam_eur,
          SUM(CASE WHEN tip = 'yiyecek' THEN tutar_tl ELSE 0 END) AS yiyecek_tl,
          SUM(CASE WHEN tip IN ('icenek', 'icecek') THEN tutar_tl ELSE 0 END) AS icenek_tl,
          SUM(CASE WHEN tip = 'yiyecek' THEN tutar_eur ELSE 0 END) AS yiyecek_eur,
          SUM(CASE WHEN tip IN ('icenek', 'icecek') THEN tutar_eur ELSE 0 END) AS icenek_eur,
          (SUM(tutar_tl)  / NULLIF(MAX(cost_pax), 0)) AS pp_tl,
          (SUM(tutar_eur) / NULLIF(MAX(cost_pax), 0)) AS pp_eur,
          MAX(cost_pax)  AS cost_pax,
          AVG(NULLIF(kur, 0)) AS kur
        FROM fb_cost.tuketim
        WHERE yil = $1 AND tarih_str NOT LIKE '%-15g' ${tipFilter}
        GROUP BY ay_no
        ORDER BY ay_no
      `, params);
      return rows;
    }

    const buYil = await aylik(yil);
    const onceki = await aylik(yil - 1);

    res.json({ yil, onceki_yil: yil - 1, bu_yil: buYil, onceki_yil_veri: onceki });
  } catch (err) {
    console.error('yillik/aylik hatası:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Yıllık — Kategori analizleri (12, 13, 14) ───────────────────────────
// 12: yıllık kategori toplamları
// 13: kategori × ay matrisi
// 14: kategori ilk→son ay değişimi
app.get('/api/yillik/kategoriler', async (req, res) => {
  const yil = parseInt(req.query.yil);
  const tip = req.query.tip || null;
  if (!yil) return res.status(400).json({ error: 'yil parametresi zorunlu' });

  try {
    const params = [yil];
    const tipFilter = tipWhere(params, tip);

    const { rows: toplamlar } = await pool.query(`
      SELECT kategori,
             SUM(tutar_tl)  AS toplam_tl,
             SUM(tutar_eur) AS toplam_eur
      FROM fb_cost.tuketim
      WHERE yil = $1 AND tarih_str NOT LIKE '%-15g' AND kategori IS NOT NULL ${tipFilter}
      GROUP BY kategori
      ORDER BY toplam_tl DESC
    `, params);

    const { rows: matris } = await pool.query(`
      SELECT kategori, ay_no,
             SUM(tutar_tl)  AS tutar_tl,
             SUM(tutar_eur) AS tutar_eur
      FROM fb_cost.tuketim
      WHERE yil = $1 AND tarih_str NOT LIKE '%-15g' AND kategori IS NOT NULL ${tipFilter}
      GROUP BY kategori, ay_no
      ORDER BY kategori, ay_no
    `, params);

    const { rows: degisim } = await pool.query(`
      WITH aylik AS (
        SELECT kategori, ay_no,
               SUM(tutar_tl)  AS tl,
               SUM(tutar_eur) AS eur
        FROM fb_cost.tuketim
        WHERE yil = $1 AND tarih_str NOT LIKE '%-15g' AND kategori IS NOT NULL ${tipFilter}
        GROUP BY kategori, ay_no
      ),
      siralanmis AS (
        SELECT kategori, ay_no, tl, eur,
               ROW_NUMBER() OVER (PARTITION BY kategori ORDER BY ay_no)      AS rn_ilk,
               ROW_NUMBER() OVER (PARTITION BY kategori ORDER BY ay_no DESC) AS rn_son,
               COUNT(*)    OVER (PARTITION BY kategori)                      AS n
        FROM aylik
      ),
      ilk AS (SELECT kategori, ay_no AS ilk_ay, tl AS ilk_tl, eur AS ilk_eur FROM siralanmis WHERE rn_ilk = 1),
      son AS (SELECT kategori, ay_no AS son_ay, tl AS son_tl, eur AS son_eur, n FROM siralanmis WHERE rn_son = 1)
      SELECT i.kategori, i.ilk_ay, s.son_ay,
             i.ilk_tl, s.son_tl, i.ilk_eur, s.son_eur,
             s.n AS ay_sayisi,
             CASE WHEN i.ilk_tl > 0
                  THEN ((s.son_tl - i.ilk_tl) / i.ilk_tl * 100)::NUMERIC
                  ELSE NULL END AS degisim_yuzde,
             CASE WHEN i.ilk_eur > 0
                  THEN ((s.son_eur - i.ilk_eur) / i.ilk_eur * 100)::NUMERIC
                  ELSE NULL END AS degisim_eur_yuzde
      FROM ilk i JOIN son s USING (kategori)
      WHERE s.n >= 2
      ORDER BY ABS(COALESCE(((s.son_tl - i.ilk_tl) / NULLIF(i.ilk_tl, 0) * 100), 0)) DESC
    `, params);

    res.json({ yil, toplamlar, matris, degisim });
  } catch (err) {
    console.error('yillik/kategoriler hatası:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Yıllık — Ürün sıralamaları (17, 18, 19) ─────────────────────────────
// metric=harcama → top N harcama (17)
// metric=artis   → top N fiyat artışı (18)
// metric=dusus   → top N fiyat düşüşü (19)
app.get('/api/yillik/urunler', async (req, res) => {
  const yil = parseInt(req.query.yil);
  const tip = req.query.tip || null;
  const metric = (req.query.metric || 'harcama').toLowerCase();
  const currency = (req.query.currency || 'TL').toUpperCase() === 'EUR' ? 'EUR' : 'TL';
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  if (!yil) return res.status(400).json({ error: 'yil parametresi zorunlu' });

  try {
    if (metric === 'harcama') {
      const params = [yil];
      const tipFilter = tipWhere(params, tip);
      params.push(limit);
      const sortField = currency === 'EUR' ? 'toplam_eur' : 'toplam_tl';
      const { rows } = await pool.query(`
        SELECT stok_mali, kategori, tip,
               SUM(tutar_tl)  AS toplam_tl,
               SUM(tutar_eur) AS toplam_eur,
               SUM(tuk_miktar) AS tuk_miktar
        FROM fb_cost.tuketim
        WHERE yil = $1 AND tarih_str NOT LIKE '%-15g'
          AND (${SQL_EXC_FINANS_PP}) ${tipFilter}
        GROUP BY stok_mali, kategori, tip
        ORDER BY ${sortField} DESC
        LIMIT $${params.length}
      `, params);
      return res.json({ yil, metric, currency, urunler: rows });
    }

    // Fiyat değişimi (artış / düşüş)
    const yon = metric === 'dusus' ? 'ASC' : 'DESC';
    const params = [yil];
    const tipFilter = tipWhere(params, tip);
    params.push(limit);
    const sortField = currency === 'EUR' ? 'degisim_eur_yuzde' : 'degisim_yuzde';
    const minIlkField = currency === 'EUR' ? 'ilk_fiyat_eur' : 'ilk_fiyat';

    const { rows } = await pool.query(`
      WITH aylik AS (
        SELECT stok_mali, kategori, tip, ay_no,
               AVG(birim_fiyat) AS ort_fiyat,
               CASE WHEN AVG(NULLIF(kur, 0)) > 0
                    THEN AVG(birim_fiyat) / AVG(NULLIF(kur, 0))
                    ELSE NULL END AS ort_fiyat_eur
        FROM fb_cost.tuketim
        WHERE yil = $1 AND birim_fiyat > 0 AND tarih_str NOT LIKE '%-15g'
          AND (${SQL_EXC_FINANS_PP}) ${tipFilter}
        GROUP BY stok_mali, kategori, tip, ay_no
      ),
      siralanmis AS (
        SELECT stok_mali, kategori, tip, ay_no, ort_fiyat, ort_fiyat_eur,
               ROW_NUMBER() OVER (PARTITION BY stok_mali, kategori, tip ORDER BY ay_no)      AS rn_ilk,
               ROW_NUMBER() OVER (PARTITION BY stok_mali, kategori, tip ORDER BY ay_no DESC) AS rn_son,
               COUNT(*)    OVER (PARTITION BY stok_mali, kategori, tip)                      AS n
        FROM aylik
      ),
      ilk AS (
        SELECT stok_mali, kategori, tip, ay_no AS ilk_ay,
               ort_fiyat AS ilk_fiyat, ort_fiyat_eur AS ilk_fiyat_eur
        FROM siralanmis WHERE rn_ilk = 1
      ),
      son AS (
        SELECT stok_mali, kategori, tip, ay_no AS son_ay,
               ort_fiyat AS son_fiyat, ort_fiyat_eur AS son_fiyat_eur, n
        FROM siralanmis WHERE rn_son = 1
      )
      SELECT i.stok_mali, i.kategori, i.tip,
             i.ilk_ay, s.son_ay,
             i.ilk_fiyat,     s.son_fiyat,
             i.ilk_fiyat_eur, s.son_fiyat_eur,
             s.n AS ay_sayisi,
             CASE WHEN i.ilk_fiyat > 0
                  THEN ((s.son_fiyat - i.ilk_fiyat) / i.ilk_fiyat * 100)::NUMERIC
                  ELSE NULL END AS degisim_yuzde,
             CASE WHEN i.ilk_fiyat_eur > 0
                  THEN ((s.son_fiyat_eur - i.ilk_fiyat_eur) / i.ilk_fiyat_eur * 100)::NUMERIC
                  ELSE NULL END AS degisim_eur_yuzde
      FROM ilk i JOIN son s USING (stok_mali, kategori, tip)
      WHERE s.n >= 2 AND i.${minIlkField} > 0
      ORDER BY ${sortField} ${yon} NULLS LAST
      LIMIT $${params.length}
    `, params);

    res.json({ yil, metric, currency, urunler: rows });
  } catch (err) {
    console.error('yillik/urunler hatası:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Yıllık — Yıl × Yıl karşılaştırma (24) ───────────────────────────────
// Kategori bazında bu yıl vs önceki yıl toplamları
app.get('/api/yillik/karsilastirma', async (req, res) => {
  const yil = parseInt(req.query.yil);
  const tip = req.query.tip || null;
  if (!yil) return res.status(400).json({ error: 'yil parametresi zorunlu' });

  try {
    const params = [yil, yil - 1];
    const tipFilter = tipWhere(params, tip);
    const { rows } = await pool.query(`
      WITH bu_yil AS (
        SELECT kategori,
               SUM(tutar_tl)  AS tl,
               SUM(tutar_eur) AS eur
        FROM fb_cost.tuketim
        WHERE yil = $1 AND tarih_str NOT LIKE '%-15g' AND kategori IS NOT NULL ${tipFilter}
        GROUP BY kategori
      ),
      onceki AS (
        SELECT kategori,
               SUM(tutar_tl)  AS tl,
               SUM(tutar_eur) AS eur
        FROM fb_cost.tuketim
        WHERE yil = $2 AND tarih_str NOT LIKE '%-15g' AND kategori IS NOT NULL ${tipFilter}
        GROUP BY kategori
      )
      SELECT
        COALESCE(b.kategori, o.kategori) AS kategori,
        COALESCE(b.tl, 0)  AS bu_yil_tl,
        COALESCE(b.eur, 0) AS bu_yil_eur,
        COALESCE(o.tl, 0)  AS onceki_tl,
        COALESCE(o.eur, 0) AS onceki_eur,
        CASE WHEN COALESCE(o.tl, 0) > 0
             THEN ((COALESCE(b.tl, 0) - o.tl) / o.tl * 100)::NUMERIC
             ELSE NULL END AS degisim_tl_yuzde,
        CASE WHEN COALESCE(o.eur, 0) > 0
             THEN ((COALESCE(b.eur, 0) - o.eur) / o.eur * 100)::NUMERIC
             ELSE NULL END AS degisim_eur_yuzde
      FROM bu_yil b
      FULL OUTER JOIN onceki o USING (kategori)
      ORDER BY GREATEST(COALESCE(b.tl, 0), COALESCE(o.tl, 0)) DESC
    `, params);

    res.json({ yil, onceki_yil: yil - 1, kategoriler: rows });
  } catch (err) {
    console.error('yillik/karsilastirma hatası:', err);
    res.status(500).json({ error: err.message });
  }
});

const classifyCsvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const n = (file.originalname || '').toLowerCase();
    if (!/\.(csv|txt)$/i.test(n)) return cb(new Error('Sadece .csv yükleyin'));
    cb(null, true);
  }
});

// ── API: Ürün sınıflandırma (Ollama) ───────────────────────────────────────────
app.get('/api/classify/stats', async (req, res) => {
  try {
    const skipExisting = String(req.query.skip_existing || 'true') !== 'false';
    const stats = await countPairStats(pool, { skipExisting });
    const job = getJobState();
    res.json({ ...stats, job });
  } catch (err) {
    console.error('classify/stats:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/classify/status', (req, res) => {
  res.json(getJobState());
});

app.post('/api/classify/run', async (req, res) => {
  try {
    const j = getJobState();
    if (j.running) {
      return res.status(409).json({ error: 'Sınıflandırma zaten çalışıyor' });
    }
    const skipExisting = req.body?.skip_existing !== false && req.body?.force !== true;
    runJobLoop(pool, { skipExisting }).catch(e => console.error('classify job:', e));
    res.json({ ok: true, skip_existing: skipExisting });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/classify/pause', (req, res) => {
  requestPause();
  res.json({ ok: true });
});

app.get('/api/classify/results', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 80, 500);
    const offset = parseInt(req.query.offset, 10) || 0;
    const { rows } = await pool.query(
      `SELECT id, stok_mali, kategori, protein_bucket, food_group, cost_proxy, confidence, gerekce, notes,
              model_name, prompt_version, created_at, updated_at
       FROM fb_cost.product_classifications
       ORDER BY updated_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json(rows);
  } catch (err) {
    console.error('classify/results:', err);
    res.status(500).json({ error: err.message });
  }
});

/** protein_bucket dağılımı (chip listesi) */
app.get('/api/classify/protein-buckets', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT LOWER(TRIM(protein_bucket)) AS bucket, COUNT(*)::int AS adet
      FROM fb_cost.product_classifications
      GROUP BY 1
      ORDER BY adet DESC, bucket ASC
    `);
    res.json(rows);
  } catch (err) {
    console.error('classify/protein-buckets:', err);
    res.status(500).json({ error: err.message });
  }
});

/** Seçilen bucket’taki ürünler */
app.get('/api/classify/protein-buckets/urunler', async (req, res) => {
  const raw = String(req.query.bucket || '').trim().toLowerCase();
  if (!raw || raw.length > 48 || !/^[a-z0-9_\-ğüşıöç]+$/i.test(raw)) {
    return res.status(400).json({ error: 'Geçersiz bucket parametresi' });
  }
  const limit = Math.min(parseInt(req.query.limit, 10) || 800, 3000);
  try {
    const { rows } = await pool.query(
      `SELECT stok_mali, kategori, food_group, cost_proxy, confidence, updated_at
       FROM fb_cost.product_classifications
       WHERE LOWER(TRIM(protein_bucket)) = $1
       ORDER BY stok_mali ASC
       LIMIT $2`,
      [raw, limit]
    );
    res.json({ bucket: raw, urunler: rows, toplam_donen: rows.length });
  } catch (err) {
    console.error('classify/protein-buckets/urunler:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/classify/upload', (req, res, next) => {
  classifyCsvUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Yükleme hatası' });
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'Dosya gerekli (file)' });
    }
    const text = req.file.buffer.toString('utf8');
    const rows = parseCsvSync(text, { columns: true, skip_empty_lines: true, bom: true });
    let inserted = 0;
    let skipped = 0;
    for (const r of rows) {
      const sm = String(r.stok_mali ?? r.STOK_MALI ?? r['Stok Malı'] ?? '').trim();
      if (!sm) continue;
      let kat = r.kategori ?? r.Kategori ?? r.kategori ?? null;
      if (kat !== null && kat !== undefined) {
        kat = String(kat).trim();
        if (kat === '') kat = null;
      }
      try {
        const ins = await pool.query(
          `INSERT INTO fb_cost.product_classify_queue (stok_mali, kategori) VALUES ($1, $2)
           ON CONFLICT (stok_mali, kategori_norm) DO NOTHING
           RETURNING id`,
          [sm, kat]
        );
        if (ins.rowCount) inserted++;
        else skipped++;
      } catch (e) {
        skipped++;
      }
    }
    res.json({ ok: true, yeni_satir: inserted, atlanan: skipped, okunan: rows.length });
  } catch (err) {
    console.error('classify/upload:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Tüketim & Talep analizleri (yiyecek, kural tabanlı) ─────────────────
app.get('/api/talep-analiz', async (req, res) => {
  try {
    const tarih_str = (req.query.tarih_str || '').trim() || null;
    const tipN = normalizeTipInput(String(req.query.tip || 'yiyecek').trim()) || 'yiyecek';
    const data = await buildTalepAnaliz(pool, { tarih_str, tip: tipN });
    res.json(data);
  } catch (err) {
    console.error('talep-analiz:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/talep-pareto-detay', async (req, res) => {
  try {
    const tarih_str = (req.query.tarih_str || '').trim() || null;
    const tip = normalizeTipInput(String(req.query.tip || '').trim());
    const esik = parseInt(req.query.esik, 10);
    if (!tarih_str) {
      return res.status(400).json({ error: 'tarih_str gerekli' });
    }
    if (!tip) {
      return res.status(400).json({ error: 'tip: yiyecek veya içecek gerekli' });
    }
    if (!PARETO_ESIK_ALLOWED.has(esik)) {
      return res.status(400).json({ error: 'esik: 50, 70, 80 veya 90' });
    }
    const urunler = await fetchParetoEsikUrunleri(pool, tarih_str, tip, esik);
    res.json({ ok: true, tarih_str, tip, esik, urunler });
  } catch (err) {
    console.error('talep-pareto-detay:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Menu Engineering (tüketim tabanlı) ─────────────────────────────────────
app.get('/api/menu-engineering', async (req, res) => {
  try {
    const data = await menuEngineering.analyze(pool, req.query, SQL_EXC_FINANS_PP);
    res.json(data);
  } catch (err) {
    if (err && err.message && err.message.includes('gerekli')) {
      return res.status(400).json({ error: err.message });
    }
    console.error('menu-engineering:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/menu-engineering/export', async (req, res) => {
  try {
    const fmt = String(req.query.format || 'csv').toLowerCase();
    const { body, contentType } = await menuEngineering.exportFiltered(pool, req.query, SQL_EXC_FINANS_PP, fmt);
    const ext = fmt === 'xlsx' ? 'xlsx' : 'csv';
    const bs = String(req.query.baslangic || 'baslangic').replace(/[^0-9-]/g, '_');
    const bt = String(req.query.bitis || 'bitis').replace(/[^0-9-]/g, '_');
    const name = `menu-engineering_${bs}_${bt}.${ext}`;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8'));
  } catch (err) {
    if (err && err.message && err.message.includes('gerekli')) {
      return res.status(400).json({ error: err.message });
    }
    console.error('menu-engineering export:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Catch-all → index.html ────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── Başlat ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Cost Analysis → http://localhost:${PORT}`);
  ensureBootstrapUsers(pool).catch((err) => {
    console.error('[auth] Kullanıcı tablosu / bootstrap hatası:', err.message);
  });
  setImmediate(() => {
    pingNutritionServiceHealth().then((o) => {
      if (o.backend_reachable) {
        console.log('[nutrition] Backend OK:', o.nutrition_service_base);
      } else {
        console.warn(
          '[nutrition] Backend ulaşılamıyor (USDA/KPI proxy 502):',
          o.nutrition_service_base,
          '—',
          o.detail || '',
          '|',
          'NUTRITION_SERVICE_URL + uvicorn kontrol.'
        );
      }
    });
  });
});
