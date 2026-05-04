'use strict';

/**
 * Tüketim & Talep analizleri — kural tabanlı sınıflandırma (stok_mali / kategori metni).
 * Yiyecek (tip=yiyecek) satırları; finans düzeltme satırları hariç.
 */

const STOK_NO_DUZELTME = '__DUZELTME__';
const STOK_NO_KDV_ILAVE = '__KDV_ILAVE__';
const SQL_EXC_FINANS = `(stok_no IS DISTINCT FROM '${STOK_NO_DUZELTME}' AND stok_no IS DISTINCT FROM '${STOK_NO_KDV_ILAVE}')`;

/** Üst üste binmeyen protein sınıfı (öncelik: deniz > balık > kuzu > dana > hindi > tavuk) */
const SQL_PROTEIN_BUCKET = `
  CASE
    WHEN stok_mali ILIKE '%KARİDES%' OR stok_mali ILIKE '%KARIDES%' OR stok_mali ILIKE '%KALAMAR%'
      OR stok_mali ILIKE '%AHTAPOT%' OR stok_mali ILIKE '%MİDYE%' OR stok_mali ILIKE '%MIDYE%'
      OR stok_mali ILIKE '%İSTAKOZ%' OR stok_mali ILIKE '%ISTAKOZ%' OR stok_mali ILIKE '%DENİZ TARA%'
      OR stok_mali ILIKE '%DENIZ TARA%' OR stok_mali ILIKE '%ÇEYREK KARİDES%'
      OR stok_mali ILIKE '%JUMBO KARİDES%' OR (stok_mali ILIKE '%KARIDES%' AND stok_mali ILIKE '%ÇİĞ%')
      OR kategori ILIKE '%KARİDES%' OR kategori ILIKE '%KALAMAR%' OR kategori ILIKE '%DENİZ%' THEN 'deniz'
    WHEN stok_mali ILIKE '%SOMON%' OR stok_mali ILIKE '%LEVREK%' OR stok_mali ILIKE '%ÇUPRA%'
      OR stok_mali ILIKE '%CUPRA%' OR stok_mali ILIKE '%ALABALIK%' OR stok_mali ILIKE '%ALABALIK%'
      OR stok_mali ILIKE '%BALI%' OR stok_mali ILIKE '%BALIK%' OR stok_mali ILIKE '%TON BALI%'
      OR stok_mali ILIKE '%HAMSİ%' OR stok_mali ILIKE '%HANSI%' OR stok_mali ILIKE '%USKUMRU%'
      OR stok_mali ILIKE '%ÇİPURA%' OR stok_mali ILIKE '%CIPURA%' OR stok_mali ILIKE '%TOMBİK%'
      OR kategori ILIKE '%BALIK%' OR kategori ILIKE '%SOMON%' THEN 'balik'
    WHEN stok_mali ILIKE '%KUZU%' OR kategori ILIKE '%KUZU%' THEN 'kuzu'
    WHEN stok_mali ILIKE '%DANA%' OR stok_mali ILIKE '%ANTRİKOT%' OR stok_mali ILIKE '%ANTRIKOT%'
      OR stok_mali ILIKE '%BONFİLE%' OR stok_mali ILIKE '%BONFILE%' OR stok_mali ILIKE '%BİFTEK%'
      OR stok_mali ILIKE '%BIFTEK%' OR stok_mali ILIKE '%KASAP KÖFT%' OR stok_mali ILIKE '%KASAP KOFT%'
      OR kategori ILIKE '%DANA%' OR kategori ILIKE '%SIĞIR%' OR kategori ILIKE '%SIGIR%' THEN 'dana'
    WHEN stok_mali ILIKE '%HİNDİ%' OR stok_mali ILIKE '%HINDI%' OR stok_mali ILIKE '%YAPRAK HİNDİ%'
      OR kategori ILIKE '%HİNDİ%' OR kategori ILIKE '%HINDI%' THEN 'hindi'
    WHEN stok_mali ILIKE '%TAVUK%' OR stok_mali ILIKE '%PİLİC%' OR stok_mali ILIKE '%PILIC%'
      OR stok_mali ILIKE '%ÇITIR%' OR stok_mali ILIKE '%CITIR%' OR kategori ILIKE '%TAVUK%'
      OR kategori ILIKE '%PİLİC%' THEN 'tavuk'
    ELSE 'diger'
  END`;

/** Premium önce; sonra standart; kalan "diger" */
const SQL_PREMIUM_STD = `
  CASE
    WHEN stok_mali ILIKE '%ANTRİKOT%' OR stok_mali ILIKE '%ANTRIKOT%' OR stok_mali ILIKE '%BONFİLE%'
      OR stok_mali ILIKE '%BONFILE%' OR stok_mali ILIKE '%SOMON%' THEN 'premium'
    WHEN stok_mali ILIKE '%TAVUK%' OR stok_mali ILIKE '%HİNDİ%' OR stok_mali ILIKE '%HINDI%'
      OR stok_mali ILIKE '%KIYMA%' OR stok_mali ILIKE '%Kıyma%' OR stok_mali ILIKE '%KİYMA%' THEN 'standard'
    ELSE 'diger'
  END`;

const SQL_MACRO_KATEGORI = `
  CASE
    WHEN kategori ILIKE '%ŞARKÜTERİ%' OR kategori ILIKE '%SARKUTERI%' OR kategori ILIKE '%SOSİS%'
      OR kategori ILIKE '%SOSIS%' OR kategori ILIKE '%SUCUK%' OR kategori ILIKE '%SALAM%' THEN 'şarküteri'
    WHEN kategori ILIKE '%SEBZE%' OR kategori ILIKE '%YEŞİLLİK%' OR kategori ILIKE '%YESILLIK%'
      OR kategori ILIKE '%YEŞİL%' OR kategori ILIKE '%SALATA%' OR kategori ILIKE '%MARUL%'
      OR kategori ILIKE '%DOMATES%' OR kategori ILIKE '%BİBER%' THEN 'sebze'
    WHEN kategori ILIKE '%SÜT%' OR kategori ILIKE '%SUT %' OR kategori ILIKE '%PEYNİR%'
      OR kategori ILIKE '%PEYNIR%' OR kategori ILIKE '%YOĞURT%' OR kategori ILIKE '%YOGURT%'
      OR kategori ILIKE '%KREMA%' OR kategori ILIKE '%TEREYA%' OR kategori ILIKE '%KAYMAK%' THEN 'süt ürünleri'
    WHEN kategori ILIKE '%MAKARNA%' OR kategori ILIKE '%PİRİNÇ%' OR kategori ILIKE '%PIRINC%'
      OR kategori ILIKE '%BULGUR%' OR kategori ILIKE '%UN %' OR kategori ILIKE '% EKMEK%'
      OR kategori ILIKE '%PATATES%' OR kategori ILIKE '%TATLISI%' OR kategori ILIKE '%TATLI%'
      OR kategori ILIKE '%KARBON%' OR kategori ILIKE '%TARHANA%' OR kategori ILIKE '%GALETA%' THEN 'karbonhidrat'
    WHEN kategori ILIKE '%ET %' OR kategori ILIKE '%ET)' OR kategori ILIKE '%ETÜRÜN%'
      OR kategori ILIKE '%TAVUK%' OR kategori ILIKE '%BALIK%' OR kategori ILIKE '%BALI%'
      OR kategori ILIKE '%DENİZ%' OR kategori ILIKE '%KUZU%' OR kategori ILIKE '%DANA%'
      OR kategori ILIKE '%HİNDİ%' OR kategori ILIKE '%KIRMIZI%' THEN 'et ürünleri'
    ELSE 'diğer'
  END`;

const SQL_YIYECEK_BASE = `tip = 'yiyecek' AND ${SQL_EXC_FINANS}`;
const SQL_YIYECEK_BASE_T = `t.tip = 'yiyecek' AND (t.stok_no IS DISTINCT FROM '${STOK_NO_DUZELTME}' AND t.stok_no IS DISTINCT FROM '${STOK_NO_KDV_ILAVE}')`;

function pct(part, total) {
  const t = parseFloat(total) || 0;
  if (t <= 0) return null;
  return Math.round((10000 * (parseFloat(part) || 0)) / t) / 100;
}

async function donemZinciri(pool) {
  const { rows } = await pool.query(`
    SELECT DISTINCT tarih_str, yil, ay_no
    FROM fb_cost.tuketim
    WHERE ${SQL_YIYECEK_BASE}
    ORDER BY yil DESC, ay_no DESC, tarih_str DESC
  `);
  return rows;
}

async function resolveTarih(pool, tarih_str) {
  const zincir = await donemZinciri(pool);
  if (!zincir.length) return { tarih_str: null, onceki: null, zincir: [] };
  if (tarih_str && zincir.some(r => r.tarih_str === tarih_str)) {
    const i = zincir.findIndex(r => r.tarih_str === tarih_str);
    return {
      tarih_str,
      onceki: i >= 0 && i + 1 < zincir.length ? zincir[i + 1].tarih_str : null,
      zincir
    };
  }
  return { tarih_str: zincir[0].tarih_str, onceki: zincir[1]?.tarih_str || null, zincir };
}

function toShareRows(rows, valueKey = 'tutar_tl') {
  const tot = rows.reduce((s, r) => s + (parseFloat(r[valueKey]) || 0), 0);
  return rows.map(r => ({
    ...r,
    pay_yuzde: pct(r[valueKey], tot)
  }));
}

async function buildTalepAnaliz(pool, { tarih_str: tarihIn } = {}) {
  const { tarih_str, onceki, zincir } = await resolveTarih(pool, tarihIn || null);
  if (!tarih_str) {
    return {
      ok: false,
      mesaj: 'Yiyecek verisi yok',
      tarih_str: null,
      onceki_tarih_str: null
    };
  }

  const paramsCur = [tarih_str];
  const paramsPrev = onceki ? [onceki] : [];

  const [
    proteinRows,
    premiumRows,
    densityRows,
    dusukRows,
    pasifRows,
    skuBuDonem,
    skuTum,
    complexitySeries,
    costDriverCur,
    costDriverPrev,
    toplamCur,
    toplamPrev
  ] = await Promise.all([
    pool.query(
      `
      SELECT ${SQL_PROTEIN_BUCKET} AS bucket,
             SUM(tutar_tl) AS tutar_tl, SUM(tutar_eur) AS tutar_eur
      FROM fb_cost.tuketim
      WHERE tarih_str = $1 AND ${SQL_YIYECEK_BASE}
      GROUP BY 1
      ORDER BY SUM(tutar_tl) DESC
      `,
      paramsCur
    ),
    pool.query(
      `
      SELECT ${SQL_PREMIUM_STD} AS segment,
             SUM(tutar_tl) AS tutar_tl, SUM(tutar_eur) AS tutar_eur
      FROM fb_cost.tuketim
      WHERE tarih_str = $1 AND ${SQL_YIYECEK_BASE}
      GROUP BY 1
      `,
      paramsCur
    ),
    pool.query(
      `
      SELECT ${SQL_MACRO_KATEGORI} AS macro,
             SUM(tutar_tl) AS tutar_tl, SUM(tutar_eur) AS tutar_eur
      FROM fb_cost.tuketim
      WHERE tarih_str = $1 AND ${SQL_YIYECEK_BASE} AND kategori IS NOT NULL
      GROUP BY 1
      ORDER BY SUM(tutar_tl) DESC
      `,
      paramsCur
    ),
    pool.query(
      `
      WITH bu_toplam AS (
        SELECT COALESCE(SUM(tutar_tl), 0) AS ttl
        FROM fb_cost.tuketim
        WHERE tarih_str = $1 AND ${SQL_YIYECEK_BASE}
      )
      SELECT stok_mali,
             SUM(tutar_tl) AS tutar_tl, SUM(tutar_eur) AS tutar_eur,
             SUM(tuk_miktar) AS miktar
      FROM fb_cost.tuketim
      WHERE tarih_str = $1 AND ${SQL_YIYECEK_BASE}
      GROUP BY stok_mali
      HAVING SUM(tutar_tl) > 0 AND SUM(tuk_miktar) > 0
        AND SUM(tutar_tl) <= GREATEST((SELECT ttl * 0.003 FROM bu_toplam), 1)
      ORDER BY SUM(tutar_tl) ASC
      LIMIT 50
      `,
      paramsCur
    ),
    pool.query(
      `
      SELECT h.stok_mali
      FROM fb_cost.tuketim h
      WHERE ${SQL_YIYECEK_BASE} AND h.tarih_str <> $1
      GROUP BY h.stok_mali
      HAVING SUM(COALESCE(h.tutar_tl, 0)) > 0
        AND COALESCE((
          SELECT SUM(x.tutar_tl) FROM fb_cost.tuketim x
          WHERE x.tarih_str = $1 AND x.stok_mali = h.stok_mali AND ${SQL_YIYECEK_BASE}
        ), 0) = 0
      ORDER BY h.stok_mali
      LIMIT 80
      `,
      paramsCur
    ),
    pool.query(
      `SELECT COUNT(DISTINCT stok_mali)::int AS n
       FROM fb_cost.tuketim WHERE tarih_str = $1 AND ${SQL_YIYECEK_BASE}`,
      paramsCur
    ),
    pool.query(
      `SELECT COUNT(DISTINCT stok_mali)::int AS n FROM fb_cost.tuketim WHERE ${SQL_YIYECEK_BASE}`
    ),
    pool.query(
      `
      SELECT d.tarih_str, d.yil, d.ay_no, MAX(t.ay) AS ay_etiket, COUNT(DISTINCT t.stok_mali)::int AS aktif_sku
      FROM (
        SELECT DISTINCT ON (yil, ay_no) tarih_str, yil, ay_no
        FROM fb_cost.tuketim
        WHERE ${SQL_YIYECEK_BASE}
        ORDER BY yil DESC, ay_no DESC, tarih_str DESC
        LIMIT 14
      ) d
      JOIN fb_cost.tuketim t ON t.tarih_str = d.tarih_str AND ${SQL_YIYECEK_BASE_T}
      GROUP BY d.tarih_str, d.yil, d.ay_no
      ORDER BY d.yil ASC, d.ay_no ASC, d.tarih_str ASC
      `
    ),
    pool.query(
      `
      SELECT
        SUM(CASE WHEN ${SQL_PROTEIN_BUCKET} IN ('dana','kuzu','deniz','balik') THEN tutar_tl ELSE 0 END) AS yuksek_tl,
        SUM(CASE WHEN ${SQL_PROTEIN_BUCKET} IN ('tavuk','hindi') OR kategori ILIKE '%SEBZE%'
                 OR ${SQL_MACRO_KATEGORI} IN ('karbonhidrat','şarküteri','süt ürünleri') THEN tutar_tl ELSE 0 END) AS dusuk_tl,
        SUM(tutar_tl) AS toplam_tl
      FROM fb_cost.tuketim
      WHERE tarih_str = $1 AND ${SQL_YIYECEK_BASE}
      `,
      paramsCur
    ).then(r => r.rows[0] || {}),
    onceki
      ? pool.query(
          `
          SELECT
            SUM(CASE WHEN ${SQL_PROTEIN_BUCKET} IN ('dana','kuzu','deniz','balik') THEN tutar_tl ELSE 0 END) AS yuksek_tl,
            SUM(CASE WHEN ${SQL_PROTEIN_BUCKET} IN ('tavuk','hindi') OR kategori ILIKE '%SEBZE%'
                     OR ${SQL_MACRO_KATEGORI} IN ('karbonhidrat','şarküteri','süt ürünleri') THEN tutar_tl ELSE 0 END) AS dusuk_tl,
            SUM(tutar_tl) AS toplam_tl
          FROM fb_cost.tuketim
          WHERE tarih_str = $1 AND ${SQL_YIYECEK_BASE}
          `,
          paramsPrev
        ).then(r => r.rows[0] || {})
      : Promise.resolve(null),
    pool.query(
      `SELECT SUM(tutar_tl) AS tl, SUM(tutar_eur) AS eur FROM fb_cost.tuketim WHERE tarih_str = $1 AND ${SQL_YIYECEK_BASE}`,
      paramsCur
    ).then(r => r.rows[0] || {}),
    onceki
      ? pool.query(
          `SELECT SUM(tutar_tl) AS tl, SUM(tutar_eur) AS eur FROM fb_cost.tuketim WHERE tarih_str = $1 AND ${SQL_YIYECEK_BASE}`,
          paramsPrev
        ).then(r => r.rows[0] || {})
      : Promise.resolve(null)
  ]);

  const proteinLabels = {
    dana: 'Dana',
    kuzu: 'Kuzu',
    tavuk: 'Tavuk',
    balik: 'Balık',
    deniz: 'Deniz ürünleri',
    hindi: 'Hindi',
    diger: 'Diğer'
  };

  const protein = toShareRows(proteinRows.rows.map(r => ({ ...r, etiket: proteinLabels[r.bucket] || r.bucket }))).map(
    r => ({
      bucket: r.bucket,
      etiket: r.etiket,
      tutar_tl: parseFloat(r.tutar_tl) || 0,
      tutar_eur: parseFloat(r.tutar_eur) || 0,
      pay_yuzde: r.pay_yuzde
    })
  );

  const premium_std = toShareRows(premiumRows.rows).map(r => ({
    segment: r.segment,
    tutar_tl: parseFloat(r.tutar_tl) || 0,
    tutar_eur: parseFloat(r.tutar_eur) || 0,
    pay_yuzde: r.pay_yuzde
  }));

  const density = toShareRows(densityRows.rows).map(r => ({
    macro: r.macro,
    tutar_tl: parseFloat(r.tutar_tl) || 0,
    tutar_eur: parseFloat(r.tutar_eur) || 0,
    pay_yuzde: r.pay_yuzde
  }));

  const topl_tl = parseFloat(toplamCur.tl) || 0;
  const dusuk_kullanim = dusukRows.rows.map(r => ({
    stok_mali: r.stok_mali,
    tutar_tl: parseFloat(r.tutar_tl) || 0,
    tutar_eur: parseFloat(r.tutar_eur) || 0,
    miktar: parseFloat(r.miktar) || 0
  }));

  const yuksekCur = parseFloat(costDriverCur.yuksek_tl) || 0;
  const dusukGrupCur = parseFloat(costDriverCur.dusuk_tl) || 0;
  const totCd = parseFloat(costDriverCur.toplam_tl) || 0;
  let cost_driver = {
    yuksek_maliyetli_pay: pct(yuksekCur, totCd),
    dusuk_maliyetli_pay: pct(dusukGrupCur, totCd),
    aciklama:
      'Kırmızı et + balık + deniz ürünleri “yüksek maliyet sürücüsü”; tavuk, hindi, sebze ve karbonhidrat grubu “relatif düşük” olarak özetlenir.'
  };

  if (costDriverPrev) {
    const yPrev = parseFloat(costDriverPrev.yuksek_tl) || 0;
    const tPrev = parseFloat(costDriverPrev.toplam_tl) || 0;
    cost_driver.onceki_yuksek_pay = pct(yPrev, tPrev);
    cost_driver.yuksek_pay_delta_pp =
      cost_driver.yuksek_maliyetli_pay != null && cost_driver.onceki_yuksek_pay != null
        ? Math.round((cost_driver.yuksek_maliyetli_pay - cost_driver.onceki_yuksek_pay) * 100) / 100
        : null;
  }

  const kompSeri = complexitySeries.rows.map(r => ({
    tarih_str: r.tarih_str,
    yil: r.yil,
    ay_no: r.ay_no,
    ay_etiket: r.ay_etiket || `${r.ay_no}/${r.yil}`,
    aktif_sku: r.aktif_sku
  }));

  const thisSku = skuBuDonem.rows[0]?.n || 0;
  const allSku = skuTum.rows[0]?.n || 0;
  const maxSeri = kompSeri.length ? Math.max(...kompSeri.map(x => x.aktif_sku)) : 0;
  const minSeri = kompSeri.length ? Math.min(...kompSeri.map(x => x.aktif_sku)) : 0;

  return {
    ok: true,
    tarih_str,
    onceki_tarih_str: onceki,
    zincir: zincir.map(z => z.tarih_str),
    toplam: { tutar_tl: topl_tl, tutar_eur: parseFloat(toplamCur.eur) || 0 },
    protein_yapisi: protein,
    premium_vs_standard: premium_std,
    kategori_yogunluk: density,
    dusuk_tuketim_urunler: dusuk_kullanim.map(r => ({
      stok_mali: r.stok_mali,
      tutar_tl: parseFloat(r.tutar_tl) || 0,
      tutar_eur: parseFloat(r.tutar_eur) || 0,
      miktar: parseFloat(r.miktar) || 0
    })),
    bu_donem_pasif_urunler: pasifRows.rows.map(r => r.stok_mali),
    cost_driver,
    uretim_karmasikligi: {
      aktif_sku_bu_donem: thisSku,
      katalog_sku_tum_zaman: allSku,
      pasif_katalog_pay: allSku > 0 ? Math.round((10000 * (allSku - thisSku)) / allSku) / 100 : null,
      seri_aylik: kompSeri,
      seri_ozet: minSeri && maxSeri ? { min: minSeri, max: maxSeri, aralik: maxSeri - minSeri } : null
    }
  };
}

module.exports = { buildTalepAnaliz, donemZinciri };
