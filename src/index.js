'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const multer = require('multer');
const { parse } = require('csv-parse');
const fs = require('fs');

const app = express();
const PORT = 3010;

// ── DB Bağlantısı ─────────────────────────────────────────────────────────────
const pool = new Pool({
  host: '127.0.0.1',
  port: 5432,
  database: 'voyagestars',
  user: 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── CSV Upload ────────────────────────────────────────────────────────────────
const upload = multer({
  dest: path.join(__dirname, '../uploads'),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    if (!file.originalname.endsWith('.csv')) {
      return cb(new Error('Sadece CSV dosyası yüklenebilir'));
    }
    cb(null, true);
  }
});

// ── API: CSV Yükle ────────────────────────────────────────────────────────────
app.post('/api/upload', upload.single('csv'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Dosya bulunamadı' });

  const filePath = req.file.path;
  const rows = [];

  try {
    await new Promise((resolve, reject) => {
      fs.createReadStream(filePath)
        .pipe(parse({ columns: true, skip_empty_lines: true, bom: true }))
        .on('data', (row) => rows.push(row))
        .on('end', resolve)
        .on('error', reject);
    });

    if (rows.length === 0) {
      return res.status(400).json({ error: 'CSV boş veya hatalı format' });
    }

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
          values.push(`($${p},$${p+1},$${p+2},$${p+3},$${p+4},$${p+5},$${p+6},$${p+7},$${p+8},$${p+9},$${p+10},$${p+11},$${p+12},$${p+13},$${p+14},$${p+15},$${p+16},$${p+17},$${p+18},$${p+19},$${p+20})`);
          params.push(
            r.dosya, r.tip, r.tarih_str,
            parseInt(r.yil) || null, parseInt(r.ay_no) || null, r.ay, parseInt(r.gun) || null,
            parseFloat(r.cost_pax) || null, parseFloat(r.kur) || null,
            r.kategori || null, r.stok_mali, r.stok_no || null, r.birim || null,
            parseFloat(r.tuk_miktar) || 0, parseFloat(r.birim_fiyat) || 0,
            parseFloat(r.tutar_tl) || 0, parseFloat(r.tutar_eur) || 0,
            parseFloat(r.pp_gr) || 0, parseFloat(r.pp_cl) || 0,
            parseFloat(r.pp_tl) || 0, parseFloat(r.tutar_eur) || 0
          );
          p += 21;
        }

        await client.query(
          `INSERT INTO fb_cost.tuketim
           (dosya,tip,tarih_str,yil,ay_no,ay,gun,cost_pax,kur,kategori,stok_mali,stok_no,birim,
            tuk_miktar,birim_fiyat,tutar_tl,tutar_eur,pp_gr,pp_cl,pp_tl,pp_eur)
           VALUES ${values.join(',')}`,
          params
        );
        inserted += batch.length;
      }

      await client.query('COMMIT');
      fs.unlinkSync(filePath);

      res.json({
        ok: true,
        inserted,
        donemler: donemler.length,
        mesaj: `${inserted} satır, ${donemler.length} dönem yüklendi`
      });

    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

  } catch (err) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    console.error('Upload hatası:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Özet KPI'lar ─────────────────────────────────────────────────────────
app.get('/api/ozet', async (req, res) => {
  try {
    const { data } = await pool.query(`
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
      WHERE tutar_tl > 0
      GROUP BY tarih_str, yil, ay_no, tip
      ORDER BY yil, ay_no, tip
    `);
    res.json(data.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: Kategori Dağılımı ────────────────────────────────────────────────────
app.get('/api/kategoriler', async (req, res) => {
  const { tarih, tip } = req.query;
  try {
    let where = 'WHERE tutar_tl > 0 AND kategori IS NOT NULL';
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
      SELECT tarih_str, yil, ay_no, tip, stok_mali, kategori,
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
      SELECT DISTINCT tarih_str, yil, ay_no, ay,
             MAX(cost_pax) AS cost_pax, MAX(kur) AS kur
      FROM fb_cost.tuketim
      GROUP BY tarih_str, yil, ay_no, ay
      ORDER BY yil DESC, ay_no DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
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
      let where = `WHERE tarih_str = $1 AND tutar_tl > 0`;
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

// ── Catch-all → index.html ────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── Başlat ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Cost Analysis → http://localhost:${PORT}`);
});
