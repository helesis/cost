'use strict';

const { normalizeTipInput } = require('./tipLabels');

/**
 * Tüketim & Talep analizleri — yiyecek satırları için:
 * - protein_bucket / food_group önceliği: fb_cost.product_classifications (LLM), yoksa kural tabanlı SQL.
 * - Join: satır başına tek sınıflandırma (önce aynı kategori, yoksa stok için en güncel kayıt).
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

/** Kategori adından food_group (LLM sınıflandırması yoksa). Değerler LLM anahtarlarıyla aynı. */
const SQL_MACRO_KATEGORI = `
  CASE
    WHEN kategori ILIKE '%ŞARKÜTERİ%' OR kategori ILIKE '%SARKUTERI%' OR kategori ILIKE '%SOSİS%'
      OR kategori ILIKE '%SOSIS%' OR kategori ILIKE '%SUCUK%' OR kategori ILIKE '%SALAM%' THEN 'sarkuteri'
    WHEN kategori ILIKE '%YUMURTA%' THEN 'yumurta'
    WHEN kategori ILIKE '%PASTANE%' OR kategori ILIKE '%DONDURMA%' OR kategori ILIKE '%TATLI%'
      OR kategori ILIKE '%CIKOLATA%' OR kategori ILIKE '%ÇİKOLATA%' OR kategori ILIKE '%LOKUM%'
      OR kategori ILIKE '%SEKER%' OR kategori ILIKE '%ŞEKER%' OR kategori ILIKE '%RECEL%'
      OR kategori ILIKE '%REÇEL%' OR kategori ILIKE '%MARMELAT%' OR kategori ILIKE '%BAL %' THEN 'tatli_pastane'
    WHEN kategori ILIKE '%KURUYEMI%' OR kategori ILIKE '%KURUYEMİ%' OR kategori ILIKE '%KURU MEYVE%' THEN 'kuruyemis'
    WHEN kategori ILIKE '%KAHVE%' OR kategori ILIKE '%CAYLAR%' OR kategori ILIKE '%ÇAYLAR%' THEN 'sicak_icecek'
    WHEN kategori ILIKE '%BAHARAT%' OR kategori ILIKE '%SOSLAR%' OR kategori ILIKE '%SIRKE%'
      OR kategori ILIKE '%SİRKE%' OR kategori ILIKE '%CESNI%' OR kategori ILIKE '%ÇEŞNİ%' THEN 'baharat_sos'
    WHEN kategori ILIKE '%YAG%' OR kategori ILIKE '%YAĞ%' OR kategori ILIKE '%MARGARIN%' THEN 'yag'
    WHEN kategori ILIKE '%SEBZE%' OR kategori ILIKE '%MEYVE%' OR kategori ILIKE '%YEŞİLLİK%'
      OR kategori ILIKE '%YESILLIK%' OR kategori ILIKE '%SALATA%' OR kategori ILIKE '%ZEYTIN%'
      OR kategori ILIKE '%ZEYTİN%' OR kategori ILIKE '%DOMATES%' OR kategori ILIKE '%BİBER%' THEN 'meyve_sebze'
    WHEN kategori ILIKE '%SÜT%' OR kategori ILIKE '%SUT %' OR kategori ILIKE '%PEYNİR%'
      OR kategori ILIKE '%PEYNIR%' OR kategori ILIKE '%YOĞURT%' OR kategori ILIKE '%YOGURT%'
      OR kategori ILIKE '%KREMA%' OR kategori ILIKE '%KAYMAK%' THEN 'sut_urunleri'
    WHEN kategori ILIKE '%MAKARNA%' OR kategori ILIKE '%PİRİNÇ%' OR kategori ILIKE '%PIRINC%'
      OR kategori ILIKE '%BULGUR%' OR kategori ILIKE '%UN %' OR kategori ILIKE '%EKMEK%'
      OR kategori ILIKE '%UNLU MAMUL%' OR kategori ILIKE '%BAKLIYAT%' OR kategori ILIKE '%PATATES%'
      OR kategori ILIKE '%KARBON%' OR kategori ILIKE '%TARHANA%' OR kategori ILIKE '%GALETA%' THEN 'karbonhidrat'
    WHEN kategori ILIKE '%ET %' OR kategori ILIKE '%ET)' OR kategori ILIKE '%ETÜRÜN%'
      OR kategori ILIKE '%TAVUK%' OR kategori ILIKE '%BALIK%' OR kategori ILIKE '%BALI%'
      OR kategori ILIKE '%DENİZ%' OR kategori ILIKE '%KUZU%' OR kategori ILIKE '%DANA%'
      OR kategori ILIKE '%HİNDİ%' OR kategori ILIKE '%KIRMIZI%' THEN 'et_urunleri'
    ELSE 'diger'
  END`;

const SQL_YIYECEK_BASE = `tip = 'yiyecek' AND ${SQL_EXC_FINANS}`;
const SQL_YIYECEK_BASE_T = `t.tip = 'yiyecek' AND (t.stok_no IS DISTINCT FROM '${STOK_NO_DUZELTME}' AND t.stok_no IS DISTINCT FROM '${STOK_NO_KDV_ILAVE}')`;

const SQL_ICENEK_BASE = `tip IN ('icenek', 'icecek') AND ${SQL_EXC_FINANS}`;
const SQL_ICENEK_BASE_T = `t.tip IN ('icenek', 'icecek') AND (t.stok_no IS DISTINCT FROM '${STOK_NO_DUZELTME}' AND t.stok_no IS DISTINCT FROM '${STOK_NO_KDV_ILAVE}')`;

/**
 * İçecek ana grubu — önce ERP kategori kodu (ilk 4 hane), yoksa ad/kategori anahtar kelimesi.
 * Kategori adları ASCII büyük harf (ör. "2007006 - WHISKYLER"); Türkçe karakterli kelimeler yetmez.
 * 2001 meşrubat · 2002 soda/su · 2003 meyve suyu · 2004 konsantre · 2005 içecek sosu/şurup
 * 2006 bira · 2007 sert alkol · 2008 şarap · 2009 şampanya
 */
const SQL_ICE_KOD = `LEFT(BTRIM(COALESCE(t.kategori, '')), 4)`;
const sqlIceKelime = (kelimeler) =>
  '(' + kelimeler.map(k => `t.kategori ILIKE '%${k}%' OR t.stok_mali ILIKE '%${k}%'`).join(' OR ') + ')';

const SQL_ICENEK_ANA_GRUP = `
  CASE ${SQL_ICE_KOD}
    WHEN '2001' THEN 'gazli_meyve'
    WHEN '2002' THEN 'su_soda'
    WHEN '2003' THEN 'gazli_meyve'
    WHEN '2004' THEN 'gazli_meyve'
    WHEN '2005' THEN 'surup_sos'
    WHEN '2006' THEN 'bira'
    WHEN '2007' THEN 'sert_alkol'
    WHEN '2008' THEN 'sarap'
    WHEN '2009' THEN 'sarap'
    ELSE CASE
      WHEN ${sqlIceKelime(['BIRA', 'BİRA'])} THEN 'bira'
      WHEN ${sqlIceKelime(['SARAP', 'ŞARAP', 'SAMPANYA', 'ŞAMPANYA', 'PROSECCO'])} THEN 'sarap'
      WHEN ${sqlIceKelime(['WHISKY', 'VISKI', 'VİSKİ', 'VOTKA', 'VODKA', 'RAKI', 'GIN ', 'LIKOR', 'LİKÖR',
        'ROM ', 'KANYAK', 'KONYAK', 'COGNAC', 'TEKILA', 'TEQUILA', 'APERATIF'])} THEN 'sert_alkol'
      WHEN ${sqlIceKelime(['CAY', 'ÇAY', 'KAHVE', 'SICAK'])} THEN 'sicak'
      WHEN ${sqlIceKelime(['SULAR', 'SODA', 'MADEN SU', 'DAMACANA', 'ICME SUYU', 'İÇME SUYU'])} THEN 'su_soda'
      WHEN ${sqlIceKelime(['MESRUBAT', 'MEŞRUBAT', 'MEYVE SU', 'GAZLI', 'KOLA', 'GAZOZ', 'ENERJI', 'KONSANTRE'])} THEN 'gazli_meyve'
      WHEN ${sqlIceKelime(['SURUP', 'ŞURUP', 'ICECEK SOS'])} THEN 'surup_sos'
      ELSE 'diger'
    END
  END`;

const SQL_ICE_ALKOLLU = `((${SQL_ICENEK_ANA_GRUP}) IN ('bira', 'sarap', 'sert_alkol'))`;

const SQL_ICENEK_SEGMENT = `
  CASE
    WHEN (${SQL_ICENEK_ANA_GRUP}) IN ('bira', 'sarap', 'sert_alkol') THEN 'premium'
    WHEN (${SQL_ICENEK_ANA_GRUP}) = 'diger' THEN 'diger'
    ELSE 'standard'
  END`;

const SQL_ICENEK_DUSUK_GRUP_COST = `((${SQL_ICENEK_ANA_GRUP}) IN ('su_soda', 'sicak', 'gazli_meyve', 'surup_sos'))`;

const SQL_PROTEIN_BUCKET_T = SQL_PROTEIN_BUCKET.replace(/\bstok_mali\b/g, 't.stok_mali').replace(/\bkategori\b/g, 't.kategori');
const SQL_MACRO_KATEGORI_T = SQL_MACRO_KATEGORI.replace(/\bkategori\b/g, 't.kategori');
const SQL_PREMIUM_STD_T = SQL_PREMIUM_STD.replace(/\bstok_mali\b/g, 't.stok_mali').replace(/\bkategori\b/g, 't.kategori');

/** food_group anahtarı → grafik etiketi (yoğunluk kartı) */
const FOOD_GROUP_ETIKET = {
  et_urunleri: 'Et ürünleri',
  sarkuteri: 'Şarküteri',
  sut_urunleri: 'Süt ürünleri',
  yumurta: 'Yumurta',
  meyve_sebze: 'Meyve/Sebze',
  karbonhidrat: 'Karbonhidrat',
  yag: 'Yağ',
  tatli_pastane: 'Tatlı/Pastane',
  kuruyemis: 'Kuruyemiş',
  baharat_sos: 'Baharat/Sos',
  sicak_icecek: 'Kahve/Çay',
  diger: 'Diğer'
};

/** Satırın food_group'u: LLM, yoksa kategori kuralı */
const SQL_FOOD_GROUP_T = `COALESCE(pc.food_group, ${SQL_MACRO_KATEGORI_T})`;

/** Satırın maliyet segmenti: LLM cost_proxy, yoksa ad kuralı (standart → ekonomik) */
const SQL_PREMIUM_SEGMENT_T = `
  CASE pc.cost_proxy
    WHEN 'HIGH' THEN 'premium'
    WHEN 'MEDIUM' THEN 'orta'
    WHEN 'LOW' THEN 'ekonomik'
    ELSE CASE (${SQL_PREMIUM_STD_T}) WHEN 'standard' THEN 'ekonomik' ELSE (${SQL_PREMIUM_STD_T}) END
  END`;

const SQL_COST_LOW_JOINED = `(
  COALESCE(pc.protein_bucket, ${SQL_PROTEIN_BUCKET_T}) IN ('tavuk','hindi')
  OR t.kategori ILIKE '%SEBZE%'
  OR (${SQL_FOOD_GROUP_T}) IN ('karbonhidrat','sarkuteri','sut_urunleri','meyve_sebze','yumurta')
)`;

/**
 * tuketim satırı başına tek sınıflandırma: önce (stok_mali, kategori) tam eşleşmesi,
 * yoksa aynı stok_mali için en güncel kayıt (kategori metni farklı olsa da LLM çıktısı kullanılır).
 */
const JOIN_CLASSIFICATION = `
LEFT JOIN LATERAL (
  SELECT pc2.id, pc2.protein_bucket, pc2.food_group, pc2.cost_proxy
  FROM fb_cost.product_classifications pc2
  WHERE pc2.stok_mali = t.stok_mali
  ORDER BY
    (pc2.kategori IS NOT DISTINCT FROM t.kategori) DESC,
    pc2.updated_at DESC NULLS LAST,
    pc2.id DESC
  LIMIT 1
) pc ON TRUE
`;

function pct(part, total) {
  const t = parseFloat(total) || 0;
  if (t <= 0) return null;
  return Math.round((10000 * (parseFloat(part) || 0)) / t) / 100;
}

async function donemZinciri(pool, tipKind = 'yiyecek') {
  const cond = tipKind === 'icenek' ? SQL_ICENEK_BASE : SQL_YIYECEK_BASE;
  const { rows } = await pool.query(`
    SELECT DISTINCT tarih_str, yil, ay_no
    FROM fb_cost.tuketim
    WHERE ${cond}
    ORDER BY yil DESC, ay_no DESC, tarih_str DESC
  `);
  return rows;
}

async function resolveTarih(pool, tarih_str, tipKind = 'yiyecek') {
  const zincir = await donemZinciri(pool, tipKind);
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

/** SKU başına tutar (azalan) Pareto; tip ifadesi sabit (enjekte edilmez). */
async function computeParetoForTip(pool, tarih_str, tipCondSql) {
  const sql = `
    WITH per_sku AS (
      SELECT stok_mali,
             SUM(tutar_tl)::numeric AS tutar_tl,
             SUM(tutar_eur)::numeric AS tutar_eur
      FROM fb_cost.tuketim
      WHERE tarih_str = $1 AND (${tipCondSql}) AND ${SQL_EXC_FINANS}
      GROUP BY stok_mali
      HAVING SUM(tutar_tl) > 0
    ),
    tot AS (
      SELECT COUNT(*)::int AS n,
             COALESCE(SUM(tutar_tl), 0)::numeric AS total_tl,
             COALESCE(SUM(tutar_eur), 0)::numeric AS total_eur
      FROM per_sku
    ),
    ord AS (
      SELECT tutar_tl, tutar_eur,
        ROW_NUMBER() OVER (ORDER BY tutar_tl DESC, stok_mali ASC) AS rnk,
        SUM(tutar_tl) OVER (ORDER BY tutar_tl DESC, stok_mali ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum_tl,
        SUM(tutar_eur) OVER (ORDER BY tutar_tl DESC, stok_mali ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum_eur
      FROM per_sku
    ),
    thresh AS (
      SELECT
        (SELECT MIN(o.rnk) FROM ord o CROSS JOIN tot t2
         WHERE t2.total_tl > 0 AND o.cum_tl >= 0.50 * t2.total_tl) AS k50,
        (SELECT MIN(o.rnk) FROM ord o CROSS JOIN tot t2
         WHERE t2.total_tl > 0 AND o.cum_tl >= 0.70 * t2.total_tl) AS k70,
        (SELECT MIN(o.rnk) FROM ord o CROSS JOIN tot t2
         WHERE t2.total_tl > 0 AND o.cum_tl >= 0.80 * t2.total_tl) AS k80,
        (SELECT MIN(o.rnk) FROM ord o CROSS JOIN tot t2
         WHERE t2.total_tl > 0 AND o.cum_tl >= 0.90 * t2.total_tl) AS k90
    ),
    top20 AS (
      SELECT COALESCE(SUM(o.tutar_tl), 0)::numeric AS sum_tl,
             COALESCE(SUM(o.tutar_eur), 0)::numeric AS sum_eur
      FROM ord o
      CROSS JOIN tot t
      WHERE t.n > 0 AND o.rnk <= GREATEST(1, CEIL(0.20 * t.n::numeric)::int)
    )
    SELECT t.n AS urun_sayisi,
           t.total_tl AS tutar_tl,
           t.total_eur AS tutar_eur,
           th.k50, th.k70, th.k80, th.k90,
           t20.sum_tl AS ust_20pct_urun_tutar_tl,
           t20.sum_eur AS ust_20pct_urun_tutar_eur
    FROM tot t
    CROSS JOIN thresh th
    CROSS JOIN top20 t20
  `;
  const { rows } = await pool.query(sql, [tarih_str]);
  const r = rows[0];
  const n = parseInt(r?.urun_sayisi, 10) || 0;
  if (!r || n <= 0) {
    return {
      urun_sayisi: 0,
      tutar_tl: 0,
      tutar_eur: 0,
      esik_tutar: { 50: null, 70: null, 80: null, 90: null },
      ust_pct20_urun: null
    };
  }
  const totalTl = parseFloat(r.tutar_tl) || 0;
  const totalEur = parseFloat(r.tutar_eur) || 0;
  const esik = (k) => {
    const ki = k != null ? parseInt(k, 10) : NaN;
    if (!Number.isFinite(ki) || ki <= 0) return null;
    return { urun_sayisi: ki, urun_yuzdesi: Math.round((10000 * ki) / n) / 100 };
  };
  const k20 = Math.max(1, Math.ceil(0.2 * n));
  const ustTl = parseFloat(r.ust_20pct_urun_tutar_tl) || 0;
  const ustEur = parseFloat(r.ust_20pct_urun_tutar_eur) || 0;
  return {
    urun_sayisi: n,
    tutar_tl: totalTl,
    tutar_eur: totalEur,
    esik_tutar: {
      50: esik(r.k50),
      70: esik(r.k70),
      80: esik(r.k80),
      90: esik(r.k90)
    },
    ust_pct20_urun: {
      urun_sayisi: k20,
      urun_yuzdesi: Math.round((10000 * k20) / n) / 100,
      tutar_pay_yuzdesi_tl: pct(ustTl, totalTl),
      tutar_pay_yuzdesi_eur: pct(ustEur, totalEur)
    }
  };
}

const PARETO_ESIK_ALLOWED = new Set([50, 70, 80, 90]);

/**
 * Pareto eşiğine kadar (kümülatif tutar ≥ esik%) dahil olan SKU'lar, tutar_tl azalan.
 * tipKind: 'yiyecek' | 'icenek'
 */
async function fetchParetoEsikUrunleri(pool, tarih_str, tipKind, esikYuzde) {
  const e = parseInt(esikYuzde, 10);
  if (!tarih_str || !PARETO_ESIK_ALLOWED.has(e)) {
    return [];
  }
  if (tipKind !== 'yiyecek' && tipKind !== 'icenek') {
    return [];
  }
  const tipSql = tipKind === 'icenek' ? `tip IN ('icenek', 'icecek')` : `tip = 'yiyecek'`;
  const sql = `
    WITH per_sku AS (
      SELECT stok_mali,
             SUM(tutar_tl)::numeric AS tutar_tl,
             SUM(tutar_eur)::numeric AS tutar_eur
      FROM fb_cost.tuketim
      WHERE tarih_str = $1 AND (${tipSql}) AND ${SQL_EXC_FINANS}
      GROUP BY stok_mali
      HAVING SUM(tutar_tl) > 0
    ),
    tot AS (
      SELECT COALESCE(SUM(tutar_tl), 0)::numeric AS total_tl FROM per_sku
    ),
    ord AS (
      SELECT stok_mali, tutar_tl, tutar_eur,
        ROW_NUMBER() OVER (ORDER BY tutar_tl DESC, stok_mali ASC) AS rnk,
        SUM(tutar_tl) OVER (ORDER BY tutar_tl DESC, stok_mali ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum_tl
      FROM per_sku
    ),
    kneed AS (
      SELECT MIN(o.rnk)::int AS k
      FROM ord o
      CROSS JOIN tot t
      WHERE t.total_tl > 0 AND o.cum_tl >= ($2::numeric / 100.0) * t.total_tl
    )
    SELECT o.stok_mali,
           o.tutar_tl::float8 AS tutar_tl,
           o.tutar_eur::float8 AS tutar_eur
    FROM ord o
    CROSS JOIN kneed kk
    WHERE kk.k IS NOT NULL AND o.rnk <= kk.k
    ORDER BY o.tutar_tl DESC, o.stok_mali ASC
  `;
  const { rows } = await pool.query(sql, [tarih_str, e]);
  return rows.map((r) => ({
    stok_mali: r.stok_mali,
    tutar_tl: parseFloat(r.tutar_tl) || 0,
    tutar_eur: parseFloat(r.tutar_eur) || 0
  }));
}

async function buildTalepYiyecekAnaliz(pool, tarihIn) {
  const { tarih_str, onceki, zincir } = await resolveTarih(pool, tarihIn || null, 'yiyecek');
  if (!tarih_str) {
    return {
      ok: false,
      mesaj: 'Yiyecek verisi yok',
      tarih_str: null,
      onceki_tarih_str: null,
      talep_tip: 'yiyecek'
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
    toplamPrev,
    paretoYiyecek
  ] = await Promise.all([
    pool.query(
      `
      SELECT COALESCE(pc.protein_bucket, ${SQL_PROTEIN_BUCKET_T}) AS bucket,
             SUM(t.tutar_tl) AS tutar_tl, SUM(t.tutar_eur) AS tutar_eur
      FROM fb_cost.tuketim t
      ${JOIN_CLASSIFICATION}
      WHERE t.tarih_str = $1 AND ${SQL_YIYECEK_BASE_T}
      GROUP BY 1
      ORDER BY SUM(t.tutar_tl) DESC
      `,
      paramsCur
    ),
    pool.query(
      `
      SELECT (${SQL_PREMIUM_SEGMENT_T}) AS segment,
             SUM(t.tutar_tl) AS tutar_tl, SUM(t.tutar_eur) AS tutar_eur
      FROM fb_cost.tuketim t
      ${JOIN_CLASSIFICATION}
      WHERE t.tarih_str = $1 AND ${SQL_YIYECEK_BASE_T}
      GROUP BY 1
      `,
      paramsCur
    ),
    pool.query(
      `
      SELECT (${SQL_FOOD_GROUP_T}) AS grup,
             SUM(t.tutar_tl) AS tutar_tl, SUM(t.tutar_eur) AS tutar_eur
      FROM fb_cost.tuketim t
      ${JOIN_CLASSIFICATION}
      WHERE t.tarih_str = $1 AND ${SQL_YIYECEK_BASE_T}
        AND (t.kategori IS NOT NULL OR pc.id IS NOT NULL)
      GROUP BY 1
      ORDER BY SUM(t.tutar_tl) DESC
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
        SUM(CASE WHEN COALESCE(pc.protein_bucket, ${SQL_PROTEIN_BUCKET_T}) IN ('dana','kuzu','deniz','balik') THEN t.tutar_tl ELSE 0 END) AS yuksek_tl,
        SUM(CASE WHEN ${SQL_COST_LOW_JOINED} THEN t.tutar_tl ELSE 0 END) AS dusuk_tl,
        SUM(t.tutar_tl) AS toplam_tl
      FROM fb_cost.tuketim t
      ${JOIN_CLASSIFICATION}
      WHERE t.tarih_str = $1 AND ${SQL_YIYECEK_BASE_T}
      `,
      paramsCur
    ).then(r => r.rows[0] || {}),
    onceki
      ? pool.query(
          `
          SELECT
            SUM(CASE WHEN COALESCE(pc.protein_bucket, ${SQL_PROTEIN_BUCKET_T}) IN ('dana','kuzu','deniz','balik') THEN t.tutar_tl ELSE 0 END) AS yuksek_tl,
            SUM(CASE WHEN ${SQL_COST_LOW_JOINED} THEN t.tutar_tl ELSE 0 END) AS dusuk_tl,
            SUM(t.tutar_tl) AS toplam_tl
          FROM fb_cost.tuketim t
          ${JOIN_CLASSIFICATION}
          WHERE t.tarih_str = $1 AND ${SQL_YIYECEK_BASE_T}
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
      : Promise.resolve(null),
    computeParetoForTip(pool, tarih_str, `tip = 'yiyecek'`)
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

  // Protein grafiği yalnız hayvansal protein kalemleri üzerinden; protein dışı tutar ayrı raporlanır.
  const proteinDisiRow = proteinRows.rows.find(r => r.bucket === 'diger');
  const proteinYiyecekTl = proteinRows.rows.reduce((a, r) => a + (parseFloat(r.tutar_tl) || 0), 0);
  const protein_disi = {
    tutar_tl: parseFloat(proteinDisiRow?.tutar_tl) || 0,
    tutar_eur: parseFloat(proteinDisiRow?.tutar_eur) || 0,
    pay_yuzde: pct(parseFloat(proteinDisiRow?.tutar_tl) || 0, proteinYiyecekTl)
  };
  const protein = toShareRows(
    proteinRows.rows.filter(r => r.bucket !== 'diger').map(r => ({ ...r, etiket: proteinLabels[r.bucket] || r.bucket }))
  ).map(
    r => ({
      bucket: r.bucket,
      etiket: r.etiket,
      tutar_tl: parseFloat(r.tutar_tl) || 0,
      tutar_eur: parseFloat(r.tutar_eur) || 0,
      pay_yuzde: r.pay_yuzde
    })
  );

  const segmentSira = { premium: 0, orta: 1, ekonomik: 2, diger: 3 };
  const premiumSirali = [...premiumRows.rows].sort((a, b) => (segmentSira[a.segment] ?? 9) - (segmentSira[b.segment] ?? 9));
  const premium_std = toShareRows(premiumSirali).map(r => ({
    segment: r.segment,
    tutar_tl: parseFloat(r.tutar_tl) || 0,
    tutar_eur: parseFloat(r.tutar_eur) || 0,
    pay_yuzde: r.pay_yuzde
  }));

  const density = toShareRows(densityRows.rows).map(r => ({
    grup: r.grup,
    macro: FOOD_GROUP_ETIKET[r.grup] || r.grup,
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
    talep_tip: 'yiyecek',
    tarih_str,
    onceki_tarih_str: onceki,
    zincir: zincir.map(z => z.tarih_str),
    toplam: { tutar_tl: topl_tl, tutar_eur: parseFloat(toplamCur.eur) || 0 },
    protein_yapisi: protein,
    protein_disi,
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
    },
    pareto: paretoYiyecek
  };
}

async function buildTalepIcenekAnaliz(pool, tarihIn) {
  const { tarih_str, onceki, zincir } = await resolveTarih(pool, tarihIn || null, 'icenek');
  if (!tarih_str) {
    return {
      ok: false,
      mesaj: 'İçecek verisi yok',
      tarih_str: null,
      onceki_tarih_str: null,
      talep_tip: 'icenek'
    };
  }

  const icenekAnaEtiket = {
    sert_alkol: 'Sert alkol',
    bira: 'Bira',
    sarap: 'Şarap / şampanya',
    gazli_meyve: 'Meşrubat / meyve suyu',
    su_soda: 'Su / soda',
    surup_sos: 'Şurup / içecek sosu',
    sicak: 'Sıcak içecek',
    diger: 'Diğer'
  };

  const paramsCur = [tarih_str];
  const paramsPrev = onceki ? [onceki] : [];

  const [
    anaRows,
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
    toplamPrev,
    paretoIce
  ] = await Promise.all([
    pool.query(
      `
      SELECT (${SQL_ICENEK_ANA_GRUP}) AS bucket,
             SUM(t.tutar_tl) AS tutar_tl, SUM(t.tutar_eur) AS tutar_eur
      FROM fb_cost.tuketim t
      WHERE t.tarih_str = $1 AND ${SQL_ICENEK_BASE_T}
      GROUP BY 1
      ORDER BY SUM(t.tutar_tl) DESC
      `,
      paramsCur
    ),
    pool.query(
      `
      SELECT (${SQL_ICENEK_SEGMENT}) AS segment,
             SUM(t.tutar_tl) AS tutar_tl, SUM(t.tutar_eur) AS tutar_eur
      FROM fb_cost.tuketim t
      WHERE t.tarih_str = $1 AND ${SQL_ICENEK_BASE_T}
      GROUP BY 1
      `,
      paramsCur
    ),
    pool.query(
      `
      WITH sat AS (
        SELECT
          LEFT(BTRIM(
            CASE WHEN strpos(COALESCE(t.kategori, ''), ' - ') > 0 THEN
              substring(t.kategori from strpos(t.kategori, ' - ') + 3)
            ELSE COALESCE(t.kategori, 'Diğer') END), 52) AS macro,
          t.tutar_tl AS tutar_tl,
          t.tutar_eur AS tutar_eur
        FROM fb_cost.tuketim t
        WHERE t.tarih_str = $1 AND ${SQL_ICENEK_BASE_T}
          AND COALESCE(BTRIM(t.kategori), '') <> ''
      )
      SELECT macro, SUM(tutar_tl) AS tutar_tl, SUM(tutar_eur) AS tutar_eur
      FROM sat
      GROUP BY macro
      ORDER BY SUM(tutar_tl) DESC
      `,
      paramsCur
    ),
    pool.query(
      `
      WITH bu_toplam AS (
        SELECT COALESCE(SUM(tutar_tl), 0) AS ttl
        FROM fb_cost.tuketim
        WHERE tarih_str = $1 AND ${SQL_ICENEK_BASE}
      )
      SELECT stok_mali,
             SUM(tutar_tl) AS tutar_tl, SUM(tutar_eur) AS tutar_eur,
             SUM(tuk_miktar) AS miktar
      FROM fb_cost.tuketim
      WHERE tarih_str = $1 AND ${SQL_ICENEK_BASE}
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
      WHERE ${SQL_ICENEK_BASE} AND h.tarih_str <> $1
      GROUP BY h.stok_mali
      HAVING SUM(COALESCE(h.tutar_tl, 0)) > 0
        AND COALESCE((
          SELECT SUM(x.tutar_tl) FROM fb_cost.tuketim x
          WHERE x.tarih_str = $1 AND x.stok_mali = h.stok_mali AND ${SQL_ICENEK_BASE}
        ), 0) = 0
      ORDER BY h.stok_mali
      LIMIT 80
      `,
      paramsCur
    ),
    pool.query(
      `SELECT COUNT(DISTINCT stok_mali)::int AS n
       FROM fb_cost.tuketim WHERE tarih_str = $1 AND ${SQL_ICENEK_BASE}`,
      paramsCur
    ),
    pool.query(`SELECT COUNT(DISTINCT stok_mali)::int AS n FROM fb_cost.tuketim WHERE ${SQL_ICENEK_BASE}`),
    pool.query(
      `
      SELECT d.tarih_str, d.yil, d.ay_no, MAX(t.ay) AS ay_etiket, COUNT(DISTINCT t.stok_mali)::int AS aktif_sku
      FROM (
        SELECT DISTINCT ON (yil, ay_no) tarih_str, yil, ay_no
        FROM fb_cost.tuketim
        WHERE ${SQL_ICENEK_BASE}
        ORDER BY yil DESC, ay_no DESC, tarih_str DESC
        LIMIT 14
      ) d
      JOIN fb_cost.tuketim t ON t.tarih_str = d.tarih_str AND ${SQL_ICENEK_BASE_T}
      GROUP BY d.tarih_str, d.yil, d.ay_no
      ORDER BY d.yil ASC, d.ay_no ASC, d.tarih_str ASC
      `
    ),
    pool
      .query(
        `
        SELECT
          SUM(CASE WHEN ${SQL_ICE_ALKOLLU} THEN t.tutar_tl ELSE 0 END) AS yuksek_tl,
          SUM(CASE WHEN ${SQL_ICENEK_DUSUK_GRUP_COST} THEN t.tutar_tl ELSE 0 END) AS dusuk_tl,
          SUM(t.tutar_tl) AS toplam_tl
        FROM fb_cost.tuketim t
        WHERE t.tarih_str = $1 AND ${SQL_ICENEK_BASE_T}
        `,
        paramsCur
      )
      .then(r => r.rows[0] || {}),
    onceki
      ? pool
          .query(
            `
            SELECT
              SUM(CASE WHEN ${SQL_ICE_ALKOLLU} THEN t.tutar_tl ELSE 0 END) AS yuksek_tl,
              SUM(CASE WHEN ${SQL_ICENEK_DUSUK_GRUP_COST} THEN t.tutar_tl ELSE 0 END) AS dusuk_tl,
              SUM(t.tutar_tl) AS toplam_tl
            FROM fb_cost.tuketim t
            WHERE t.tarih_str = $1 AND ${SQL_ICENEK_BASE_T}
            `,
            paramsPrev
          )
          .then(r => r.rows[0] || {})
      : Promise.resolve(null),
    pool
      .query(
        `SELECT SUM(tutar_tl) AS tl, SUM(tutar_eur) AS eur FROM fb_cost.tuketim WHERE tarih_str = $1 AND ${SQL_ICENEK_BASE}`,
        paramsCur
      )
      .then(r => r.rows[0] || {}),
    onceki
      ? pool
          .query(
            `SELECT SUM(tutar_tl) AS tl, SUM(tutar_eur) AS eur FROM fb_cost.tuketim WHERE tarih_str = $1 AND ${SQL_ICENEK_BASE}`,
            paramsPrev
          )
          .then(r => r.rows[0] || {})
      : Promise.resolve(null),
    computeParetoForTip(pool, tarih_str, `tip IN ('icenek', 'icecek')`)
  ]);

  const protein = toShareRows(
    anaRows.rows.map(r => ({ ...r, etiket: icenekAnaEtiket[r.bucket] || r.bucket }))
  ).map(r => ({
    bucket: r.bucket,
    etiket: r.etiket,
    tutar_tl: parseFloat(r.tutar_tl) || 0,
    tutar_eur: parseFloat(r.tutar_eur) || 0,
    pay_yuzde: r.pay_yuzde
  }));

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
      'Kural tanımına göre alkollü içecek grubu “yüksek maliyet sürücüsü”; su, sıcak içecek ve gazlı/meyve suyu “relatif düşük grup” olarak özetlenir (stok/kategori etiketiyle yaklaşık).'
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
    talep_tip: 'icenek',
    tarih_str,
    onceki_tarih_str: onceki,
    zincir: zincir.map(z => z.tarih_str),
    toplam: { tutar_tl: topl_tl, tutar_eur: parseFloat(toplamCur.eur) || 0 },
    protein_yapisi: protein,
    premium_vs_standard: premium_std,
    kategori_yogunluk: density,
    dusuk_tuketim_urunler: dusuk_kullanim,
    bu_donem_pasif_urunler: pasifRows.rows.map(r => r.stok_mali),
    cost_driver,
    uretim_karmasikligi: {
      aktif_sku_bu_donem: thisSku,
      katalog_sku_tum_zaman: allSku,
      pasif_katalog_pay: allSku > 0 ? Math.round((10000 * (allSku - thisSku)) / allSku) / 100 : null,
      seri_aylik: kompSeri,
      seri_ozet: minSeri && maxSeri ? { min: minSeri, max: maxSeri, aralik: maxSeri - minSeri } : null
    },
    pareto: paretoIce
  };
}

async function buildTalepAnaliz(pool, { tarih_str: tarihIn, tip } = {}) {
  const t = normalizeTipInput(tip) === 'icenek' ? 'icenek' : 'yiyecek';
  if (t === 'icenek') return buildTalepIcenekAnaliz(pool, tarihIn);
  return buildTalepYiyecekAnaliz(pool, tarihIn);
}

module.exports = { buildTalepAnaliz, donemZinciri, fetchParetoEsikUrunleri, PARETO_ESIK_ALLOWED };
