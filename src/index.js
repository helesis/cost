'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const multer = require('multer');
const { parse: parseCsvSync } = require('csv-parse/sync');
const { parseExcelToRows, normalizeTuketimRowForDb } = require('./excelImport');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { Resend } = require('resend');

const app = express();
const PORT = parseInt(process.env.PORT) || 3010;

// ── DB Bağlantısı ─────────────────────────────────────────────────────────────
const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'voyagestars',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// ── Auth yapılandırması ───────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || '')
  .split(',')
  .map(e => e.trim().toLowerCase())
  .filter(Boolean);
const RESEND_FROM = process.env.RESEND_FROM || 'Cost Analysis <noreply@voyagestars.com>';
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── Auth Middleware: /api/* için JWT zorunlu (auth route'ları hariç) ─────────
function requireAuth(req, res, next) {
  if (req.path.startsWith('/api/auth/')) return next();
  if (!req.path.startsWith('/api/')) return next();

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Yetkilendirme gerekli' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!ALLOWED_EMAILS.includes((payload.email || '').toLowerCase())) {
      return res.status(403).json({ error: 'Erişim reddedildi' });
    }
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Geçersiz veya süresi dolmuş token' });
  }
}
app.use(requireAuth);

// ── API: Auth — OTP gönder ────────────────────────────────────────────────────
app.post('/api/auth/send-otp', async (req, res) => {
  try {
    const email = (req.body?.email || '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Geçerli bir e-posta adresi girin' });
    }
    if (!ALLOWED_EMAILS.includes(email)) {
      return res.status(403).json({ error: 'Bu e-posta adresi yetkili değil' });
    }
    if (!resend) {
      return res.status(500).json({ error: 'E-posta servisi yapılandırılmamış (RESEND_API_KEY)' });
    }

    const kod = Math.floor(100000 + Math.random() * 900000).toString();
    const gecerliUntil = new Date(Date.now() + 10 * 60 * 1000); // 10 dk
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;

    await pool.query(
      `INSERT INTO fb_cost.otp_kodlari (email, kod, gecerli_until, ip_adresi)
       VALUES ($1, $2, $3, $4)`,
      [email, kod, gecerliUntil, ip]
    );

    const { error } = await resend.emails.send({
      from: RESEND_FROM,
      to: email,
      subject: 'Cost Analysis — Giriş Kodunuz',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#faf9f6;border-radius:12px;">
          <h2 style="color:#1a1814;margin:0 0 16px;font-family:Georgia,serif;">Cost Analysis</h2>
          <p style="color:#1a1814;font-size:15px;margin:0 0 8px;">Giriş kodunuz:</p>
          <div style="font-size:36px;font-weight:700;color:#8a6c2e;letter-spacing:8px;padding:20px;text-align:center;background:#f7f1e6;border-radius:8px;margin:16px 0;">${kod}</div>
          <p style="color:#7a7369;font-size:13px;margin:16px 0 0;">Bu kod 10 dakika geçerlidir. Eğer bu girişi siz talep etmediyseniz bu e-postayı yok sayabilirsiniz.</p>
        </div>
      `
    });

    if (error) {
      console.error('Resend hatası:', error);
      return res.status(500).json({ error: 'E-posta gönderilemedi' });
    }

    res.json({ ok: true, mesaj: 'Doğrulama kodu e-posta adresinize gönderildi' });
  } catch (err) {
    console.error('send-otp hatası:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Auth — OTP doğrula → JWT ─────────────────────────────────────────────
app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const email = (req.body?.email || '').trim().toLowerCase();
    const kod = (req.body?.kod || '').trim();
    if (!email || !kod) {
      return res.status(400).json({ error: 'E-posta ve kod zorunlu' });
    }
    if (!ALLOWED_EMAILS.includes(email)) {
      return res.status(403).json({ error: 'Bu e-posta adresi yetkili değil' });
    }

    const { rows } = await pool.query(
      `SELECT id FROM fb_cost.otp_kodlari
       WHERE email = $1 AND kod = $2
         AND kullanildi = FALSE
         AND gecerli_until > NOW()
       ORDER BY id DESC LIMIT 1`,
      [email, kod]
    );

    if (!rows.length) {
      return res.status(401).json({ error: 'Kod hatalı veya süresi dolmuş' });
    }

    await pool.query(
      'UPDATE fb_cost.otp_kodlari SET kullanildi = TRUE WHERE id = $1',
      [rows[0].id]
    );

    const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ ok: true, token, email });
  } catch (err) {
    console.error('verify-otp hatası:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Route: /login → login.html ────────────────────────────────────────────────
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/login.html'));
});

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
        SUM(CASE WHEN tip='yiyecek' THEN pp_gr ELSE 0 END) AS toplam_pp_gr,
        SUM(CASE WHEN tip='icenek'  THEN pp_cl ELSE 0 END) AS toplam_pp_cl,
        SUM(pp_tl)    AS toplam_pp_tl,
        SUM(pp_eur)   AS toplam_pp_eur
      FROM fb_cost.tuketim
      GROUP BY tarih_str, yil, ay_no, tip
      ORDER BY yil, ay_no, tip
    `);
    res.json(rows);
  } catch (err) {
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
    if (tip)   { where += ` AND tip = $${params.length+1}`; params.push(tip); }

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

// ── API: Ürün Arama ───────────────────────────────────────────────────────────
app.get('/api/urun', async (req, res) => {
  const { q, tip } = req.query;
  if (!q) return res.json([]);
  try {
    const { rows } = await pool.query(`
      SELECT tarih_str, yil, ay_no, tip, stok_mali, kategori, grup,
             tuk_miktar, birim, birim_fiyat, tutar_tl, tutar_eur,
             pp_gr, pp_cl, pp_tl, pp_eur, cost_pax, kur
      FROM fb_cost.tuketim
      WHERE stok_mali ILIKE $1 ${tip ? 'AND tip = $2' : ''}
        AND tutar_tl > 0
      ORDER BY yil DESC, ay_no DESC
      LIMIT 200
    `, tip ? [`%${q}%`, tip] : [`%${q}%`]);
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
             SUM(CASE WHEN tip = 'yiyecek' THEN 1 ELSE 0 END)::int AS yiyecek_satir,
             SUM(CASE WHEN tip IN ('icenek', 'icecek') THEN 1 ELSE 0 END)::int AS icenek_satir
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
  const tipRaw = (req.query.tip || '').trim().toLowerCase();
  if (!tarih_str) {
    return res.status(400).json({ error: 'tarih_str parametresi gerekli' });
  }
  if (!/^\d{4}-\d{2}(-15g)?$/.test(tarih_str)) {
    return res.status(400).json({ error: 'Geçersiz tarih_str' });
  }
  if (tipRaw && tipRaw !== 'yiyecek' && tipRaw !== 'icenek' && tipRaw !== 'icecek') {
    return res.status(400).json({ error: 'tip: yiyecek veya icenek olmalı' });
  }
  try {
    let sql = 'DELETE FROM fb_cost.tuketim WHERE tarih_str = $1';
    const params = [tarih_str];
    if (tipRaw === 'yiyecek') {
      sql += ' AND tip = $2';
      params.push('yiyecek');
    } else if (tipRaw === 'icenek' || tipRaw === 'icecek') {
      sql += ' AND tip IN ($2, $3)';
      params.push('icenek', 'icecek');
    }
    const { rowCount } = await pool.query(sql, params);
    return res.json({ ok: true, silinen: rowCount, tarih_str, tip: tipRaw || null });
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

// ── API: Fiyat Analizi — ürün bazında dönemsel birim fiyat serisi ────────────
app.get('/api/fiyat-analizi', async (req, res) => {
  const { stok_mali, tip } = req.query;
  if (!stok_mali || !stok_mali.trim()) {
    return res.status(400).json({ error: 'stok_mali parametresi zorunlu' });
  }
  try {
    const params = [`%${stok_mali.trim()}%`];
    let where = `WHERE stok_mali ILIKE $1 AND birim_fiyat > 0`;
    if (tip) { where += ` AND tip = $${params.length + 1}`; params.push(tip); }

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
    let where = `WHERE birim_fiyat > 0 AND kategori IS NOT NULL AND tarih_str NOT LIKE '%-15g'`;
    if (tarih_baslangic) { where += ` AND tarih_str >= $${params.length + 1}`; params.push(tarih_baslangic); }
    if (tarih_bitis)     { where += ` AND tarih_str <= $${params.length + 1}`; params.push(tarih_bitis); }
    if (tip)             { where += ` AND tip = $${params.length + 1}`; params.push(tip); }

    // Her kategori için ilk ve son dönemi (yil, ay_no sıralı) bul,
    // o dönemlerdeki ortalama birim_fiyat ve birim_fiyat_eur üzerinden yüzde değişim hesapla.
    const { rows } = await pool.query(`
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
      son AS (SELECT kategori, tarih_str AS son_donem, ort_tl AS son_tl, ort_eur AS son_eur FROM siralanmis WHERE rn_son = 1)
      SELECT
        i.kategori,
        i.ilk_donem, s.son_donem,
        i.ilk_tl  AS ilk_donem_fiyat,
        s.son_tl  AS son_donem_fiyat,
        i.ilk_eur AS ilk_donem_fiyat_eur,
        s.son_eur AS son_donem_fiyat_eur,
        CASE WHEN i.ilk_tl > 0
             THEN ((s.son_tl - i.ilk_tl) / i.ilk_tl * 100)::NUMERIC
             ELSE NULL END AS degisim_yuzde,
        CASE WHEN i.ilk_eur > 0
             THEN ((s.son_eur - i.ilk_eur) / i.ilk_eur * 100)::NUMERIC
             ELSE NULL END AS degisim_eur_yuzde
      FROM ilk i
      JOIN son s USING (kategori)
      ORDER BY ABS(COALESCE(((s.son_tl - i.ilk_tl) / NULLIF(i.ilk_tl, 0) * 100), 0)) DESC
    `, params);

    res.json(rows);
  } catch (err) {
    console.error('fiyat-analizi/kategoriler hatası:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// YILLIK ANALİZ API'LERİ
// ─────────────────────────────────────────────────────────────────────────────

// Yardımcı: opsiyonel tip filtresi SQL parça üretir
function tipWhere(params, tip, base = '') {
  let where = base;
  if (tip) { where += ` AND tip = $${params.length + 1}`; params.push(tip); }
  return where;
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
                 SUM(pp_tl)     AS pp_tl,
                 SUM(pp_eur)    AS pp_eur,
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
          SUM(CASE WHEN tip = 'icenek'  THEN tutar_tl ELSE 0 END) AS icenek_tl,
          SUM(CASE WHEN tip = 'yiyecek' THEN tutar_eur ELSE 0 END) AS yiyecek_eur,
          SUM(CASE WHEN tip = 'icenek'  THEN tutar_eur ELSE 0 END) AS icenek_eur,
          SUM(pp_tl)     AS pp_tl,
          SUM(pp_eur)    AS pp_eur,
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
          AND stok_no IS DISTINCT FROM '__DUZELTME__' ${tipFilter}
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
        WHERE yil = $1 AND birim_fiyat > 0 AND tarih_str NOT LIKE '%-15g' ${tipFilter}
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

// ── Catch-all → index.html ────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── Başlat ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Cost Analysis → http://localhost:${PORT}`);
});
