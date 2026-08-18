'use strict';

const XLSX = require('xlsx');
const { normalizeTipInput } = require('./tipLabels');

/** Klasik 2×2 matris bölgeleri (medyanlara göre) */
const Q = Object.freeze({
  STARS: 'stars',
  RISK_WATCH: 'risk_watch',
  PLOW_HORSES: 'plow_horses',
  DOGS: 'dogs'
});

const QUADRANT_LABELS = {
  [Q.STARS]: 'Stars',
  [Q.RISK_WATCH]: 'Risk/Watch',
  [Q.PLOW_HORSES]: 'Plow Horses',
  [Q.DOGS]: 'Dogs'
};

const QUADRANT_SUGGESTIONS = {
  [Q.STARS]: 'Ucuz ve çok tüketiliyor — ideal, koru ve öne çıkar.',
  [Q.RISK_WATCH]: 'Pahalı ama çok tüketiliyor — bütçeyi yiyebilir; kontrol / optimizasyon.',
  [Q.PLOW_HORSES]: 'Ucuz, düşük ilgi — menü/teşvik gözden geçir.',
  [Q.DOGS]: 'Pahalı ve düşük tüketim — çıkarma / değiştirmeyi değerlendir.'
};

const ALLOWED_THRESHOLDS = new Set([20, 30, 40]);

function medianSorted(sorted) {
  const n = sorted.length;
  if (!n) return NaN;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function medianOf(values) {
  const v = values
    .filter((x) => Number.isFinite(x))
    .slice()
    .sort((a, b) => a - b);
  return medianSorted(v);
}

/** X düşük = ucuz, Y yüksek = çok tüketim → sol üst Stars */
function quadrantFromCosts(xEuroPerUnit, yQtyDisp, medianX, medianY) {
  if (!Number.isFinite(xEuroPerUnit) || !Number.isFinite(yQtyDisp)) return null;
  if (!Number.isFinite(medianX) || !Number.isFinite(medianY)) return null;

  const lowCost = xEuroPerUnit <= medianX;
  const highVol = yQtyDisp >= medianY;

  if (lowCost && highVol) return Q.STARS;
  if (!lowCost && highVol) return Q.RISK_WATCH;
  if (lowCost && !highVol) return Q.PLOW_HORSES;
  return Q.DOGS;
}

async function fetchAggregates(pool, baslangic, bitis, tip, sqlExcFinans) {
  const params = [baslangic, bitis];
  let tipSql = '';
  if (tip === 'yiyecek') {
    tipSql = ` AND tip = 'yiyecek'`;
  } else if (tip === 'icenek') {
    tipSql = ` AND tip IN ('icenek', 'icecek')`;
  }

  const { rows } = await pool.query(
    `
    SELECT
      stok_mali AS item_name,
      SUM(ABS(COALESCE(tuk_miktar, 0)))::float8 AS consumption_quantity_raw,
      SUM(COALESCE(tutar_tl, 0))::float8 AS amount_tl,
      SUM(COALESCE(tutar_eur, 0))::float8 AS amount_eur,
      MAX(kategori) AS category
    FROM fb_cost.tuketim
    WHERE tarih_str >= $1 AND tarih_str <= $2
      ${tipSql}
      AND (${sqlExcFinans})
    GROUP BY stok_mali
    HAVING SUM(ABS(COALESCE(tuk_miktar, 0))) > 0
    ORDER BY consumption_quantity_raw DESC
    `,
    params
  );
  return rows;
}

/** Yiyecek: tutar/kg; içecek: tutar/L (ham satır litre). */
function unitCostPerDisplayUnit(normalizedTip, qtyRaw, qtyDisplay, amount) {
  const icenekBranch = normalizedTip === 'icenek';
  if (normalizedTip === 'yiyecek') {
    const denom = qtyDisplay > 0 ? qtyDisplay : 0;
    return denom > 0 ? amount / denom : NaN;
  }
  if (icenekBranch) {
    return qtyRaw > 0 ? amount / qtyRaw : NaN;
  }
  return NaN;
}

/**
 * Tek tip için: yiyecek → kg; içecek → L. Birim maliyet TL veya EUR (seçilen para birimi).
 */
function buildAnalyzedItems(rawRows, thresholdPct, currency, normalizedTip) {
  const useEurAmt = currency === 'EUR';
  const icenekBranch = normalizedTip === 'icenek';
  const N = rawRows.length;
  const cutoff = N === 0 ? 0 : Math.max(1, Math.ceil((N * thresholdPct) / 100));
  const totalQtyRaw = rawRows.reduce((s, r) => s + (+r.consumption_quantity_raw || 0), 0);
  const totalAmount = rawRows.reduce(
    (s, r) => s + (+(useEurAmt ? r.amount_eur : r.amount_tl) || 0),
    0
  );

  return rawRows.map((r, idx) => {
    const qtyRaw = +r.consumption_quantity_raw || 0;
    const pctQty = totalQtyRaw > 0 ? (100 * qtyRaw) / totalQtyRaw : 0;
    const amount = +(useEurAmt ? r.amount_eur : r.amount_tl) || 0;
    const pctAmount = totalAmount > 0 ? (100 * amount) / totalAmount : 0;
    const rank = idx + 1;
    const consumptionTier = rank <= cutoff ? 'HIGH' : 'LOW';

    let qtyDisplay = 0;
    if (normalizedTip === 'yiyecek') qtyDisplay = qtyRaw / 1000;
    else if (icenekBranch) qtyDisplay = qtyRaw;

    const tlTot = +(r.amount_tl || 0) || 0;
    const eurTot = +(r.amount_eur || 0) || 0;
    const unitCostTL = unitCostPerDisplayUnit(normalizedTip, qtyRaw, qtyDisplay, tlTot);
    const unitCostEUR = unitCostPerDisplayUnit(normalizedTip, qtyRaw, qtyDisplay, eurTot);
    const unitCost = useEurAmt ? unitCostEUR : unitCostTL;

    const fin = (v) => (Number.isFinite(v) ? +v.toPrecision(14) : null);

    return {
      item_name: r.item_name,
      category: r.category,
      consumption_quantity: qtyRaw,
      consumption_quantity_raw: qtyRaw,
      consumption_pct: +pctQty.toFixed(4),
      amount_tl: +(r.amount_tl || 0),
      amount_eur: +(r.amount_eur || 0),
      amount_share_pct: +pctAmount.toFixed(4),
      currency_amt_label: useEurAmt ? 'EUR' : 'TL',
      qty_display: +qtyDisplay.toFixed(6),
      qty_display_unit: normalizedTip === 'yiyecek' ? 'kg' : normalizedTip === 'icenek' ? 'L' : '—',
      unit_cost: fin(unitCost),
      unit_cost_tl: fin(unitCostTL),
      unit_cost_eur: fin(unitCostEUR),
      rank,
      consumption_tier: consumptionTier,
      me_quadrant: null,
      segment: null,
      suggestion: ''
    };
  });
}

function filterByQC(items, q) {
  let out = items;
  if (q) {
    const ql = q.toLocaleLowerCase('tr-TR');
    out = out.filter(
      (r) =>
        String(r.item_name).toLocaleLowerCase('tr-TR').includes(ql) ||
        (r.category && String(r.category).toLocaleLowerCase('tr-TR').includes(ql))
    );
  }
  return out;
}

function filterQuadrant(items, segmentKey) {
  if (!segmentKey) return items;
  return items.filter((r) => String(r.me_quadrant || '') === segmentKey);
}

function annotateQuadrantsAndSuggest(poolRows, normalizedTip, medianX, medianY) {
  if (!normalizedTip) {
    return poolRows.map((r) => ({ ...r, me_quadrant: null, segment: null, suggestion: '' }));
  }
  const medOk = Number.isFinite(medianX) && Number.isFinite(medianY);
  return poolRows.map((r) => {
    const x = Number(r.unit_cost);
    const y = Number(r.qty_display);
    const hasCost = Number.isFinite(x);
    const hasQtyMatris = Number.isFinite(y) && y > 0;
    if (!hasCost || !hasQtyMatris || !medOk) {
      return {
        ...r,
        me_quadrant: null,
        segment: null,
        suggestion: ''
      };
    }
    const q = quadrantFromCosts(x, y, medianX, medianY);
    return {
      ...r,
      me_quadrant: q,
      segment: q,
      suggestion: q ? QUADRANT_SUGGESTIONS[q] || '' : ''
    };
  });
}

function computeKpis(items) {
  const totalSku = items.length;
  const totalConsumption = items.reduce((s, r) => s + (+r.consumption_quantity_raw || +r.consumption_quantity || 0), 0);
  const sorted = [...items].sort((a, b) => b.consumption_pct - a.consumption_pct);
  let top20share = 0;
  for (let i = 0; i < Math.min(20, sorted.length); i++) top20share += sorted[i].consumption_pct;

  let stars_count = 0;
  let risk_watch_count = 0;
  let plow_count = 0;
  let dogs_count = 0;
  for (const r of items) {
    const q = r.me_quadrant;
    if (q === Q.STARS) stars_count++;
    else if (q === Q.RISK_WATCH) risk_watch_count++;
    else if (q === Q.PLOW_HORSES) plow_count++;
    else if (q === Q.DOGS) dogs_count++;
  }

  return {
    total_sku: totalSku,
    total_consumption: totalConsumption,
    top20_share_pct: +top20share.toFixed(2),
    stars_count: stars_count,
    risk_watch_count: risk_watch_count,
    plow_horses_count: plow_count,
    dogs_count: dogs_count,
    volume_risk_count: risk_watch_count,
    dead_stock_count: dogs_count + plow_count
  };
}

function paretoSeries(items) {
  const sorted = [...items].sort((a, b) => b.consumption_quantity_raw - a.consumption_quantity_raw);
  const total = sorted.reduce((s, r) => s + r.consumption_quantity_raw, 0);
  let cum = 0;
  return sorted.map((r) => {
    cum += r.consumption_quantity_raw;
    return {
      item_name: r.item_name,
      consumption: r.consumption_quantity_raw,
      cum_pct: total > 0 ? +((100 * cum) / total).toFixed(2) : 0
    };
  });
}

const PARETO_CHART_MAX = 50;
const MATRIX_CHART_MAX = 1500;

async function computeFilteredItems(pool, query, sqlExcFinans) {
  const baslangic = String(query.baslangic || '').trim();
  const bitis = String(query.bitis || '').trim();
  if (!baslangic || !bitis) {
    throw new Error('baslangic ve bitis parametreleri gerekli');
  }

  let threshold_pct = parseInt(String(query.threshold_pct || '30'), 10);
  if (!ALLOWED_THRESHOLDS.has(threshold_pct)) threshold_pct = 30;

  const tipRaw = String(query.tip || '').trim();
  const tip = tipRaw ? normalizeTipInput(tipRaw) : null;
  if (tipRaw && !tip) {
    throw new Error('tip parametresi geçersiz (yiyecek veya içecek)');
  }

  const raw = await fetchAggregates(pool, baslangic, bitis, tip || '', sqlExcFinans);

  const curRaw = String(query.currency || 'TL').toUpperCase().trim();
  const currency = curRaw === 'EUR' ? 'EUR' : 'TL';

  const itemsFull = buildAnalyzedItems(raw, threshold_pct, currency, tip || null);

  const poolQC = filterByQC(itemsFull, String(query.q || '').trim());

  let median_unit_cost = NaN;
  let median_qty_display = NaN;

  const validScatter = [];
  if (tip) {
    for (const r of poolQC) {
      const x = Number(r.unit_cost);
      const y = Number(r.qty_display);
      if (Number.isFinite(x) && x >= 0 && Number.isFinite(y) && y > 0) validScatter.push(r);
    }
    const xs = validScatter.map((r) => r.unit_cost);
    const ys = validScatter.map((r) => r.qty_display);
    median_unit_cost = medianOf(xs);
    median_qty_display = medianOf(ys);
  }

  const withQuad = annotateQuadrantsAndSuggest(poolQC, tip, median_unit_cost, median_qty_display);

  const maliyet_eksik_urunler = tip
    ? withQuad
        .filter((r) => !Number.isFinite(Number(r.unit_cost)))
        .map((r) => ({
          item_name: r.item_name,
          category: r.category || ''
        }))
    : [];

  const seg = String(query.segment || '').trim();
  let filtered = filterQuadrant(withQuad, seg);

  return {
    filtered,
    threshold_pct,
    baslangic,
    bitis,
    tip,
    currency,
    itemsFullCount: itemsFull.length,
    median_unit_cost,
    median_qty_display,
    matrix_qty_unit: tip === 'yiyecek' ? 'kg' : tip === 'icenek' ? 'L' : null,
    normalized_tip_for_matrix: tip,
    maliyet_eksik_urunler
  };
}

function quadrantCellLabel(meQuadrant, tipSelected) {
  if (meQuadrant != null) return QUADRANT_LABELS[meQuadrant] || String(meQuadrant);
  if (tipSelected) return 'Maliyet eksik';
  return '—';
}

async function analyze(pool, query, sqlExcFinans) {
  const {
    filtered,
    threshold_pct,
    baslangic,
    bitis,
    tip,
    currency,
    itemsFullCount,
    median_unit_cost,
    median_qty_display,
    matrix_qty_unit,
    normalized_tip_for_matrix,
    maliyet_eksik_urunler
  } = await computeFilteredItems(pool, query, sqlExcFinans);

  const kpis = computeKpis(filtered);

  const paretoFull = paretoSeries(filtered.length ? filtered : []);
  const pareto = paretoFull.slice(0, PARETO_CHART_MAX);
  const pareto_truncated = paretoFull.length > PARETO_CHART_MAX;

  const page = Math.max(1, parseInt(String(query.page || '1'), 10) || 1);
  const pageSize = Math.min(200, Math.max(10, parseInt(String(query.pageSize || '50'), 10) || 50));
  const start = (page - 1) * pageSize;
  const tipSel = !!normalized_tip_for_matrix;
  const rows = filtered.slice(start, start + pageSize).map((r) => ({
    item_name: r.item_name,
    category: r.category,
    consumption_quantity: r.consumption_quantity_raw,
    consumption_pct: r.consumption_pct,
    segment: r.segment,
    me_quadrant: r.me_quadrant,
    quadrant_display: quadrantCellLabel(r.me_quadrant, tipSel),
    suggestion: r.suggestion,
    consumption_tier: r.consumption_tier,
    rank: r.rank,
    unit_cost: r.unit_cost,
    unit_cost_tl: r.unit_cost_tl,
    unit_cost_eur: r.unit_cost_eur,
    qty_display: r.qty_display,
    qty_display_unit: r.qty_display_unit
  }));

  const matrixEligible = normalized_tip_for_matrix
    ? filtered.filter(
        (r) =>
          Number.isFinite(Number(r.unit_cost)) &&
          Number(r.unit_cost) >= 0 &&
          Number.isFinite(Number(r.qty_display)) &&
          Number(r.qty_display) > 0
      )
    : [];

  const matrix = matrixEligible.map((r) => ({
    item_name: r.item_name,
    x: Number(r.unit_cost),
    y: Number(r.qty_display),
    me_quadrant: r.me_quadrant,
    quadrant_label: r.me_quadrant ? QUADRANT_LABELS[r.me_quadrant] || '' : '',
    unit_cost: r.unit_cost,
    unit_cost_tl: r.unit_cost_tl,
    unit_cost_eur: r.unit_cost_eur,
    qty_display: r.qty_display,
    qty_unit: matrix_qty_unit
  }));

  let matrixOut = matrix;
  let matrix_truncated = false;
  if (matrixOut.length > MATRIX_CHART_MAX) {
    matrixOut = [...matrixOut].sort((a, b) => b.y - a.y).slice(0, MATRIX_CHART_MAX);
    matrix_truncated = true;
  }

  return {
    kpis,
    pareto,
    pareto_truncated,
    pareto_total_points: paretoFull.length,
    matrix: matrixOut,
    matrix_truncated,
    matrix_total_points: matrix.length,
    matrix_currency: currency,
    matrix_qty_unit: matrix_qty_unit || null,
    matrix_tip_required: normalized_tip_for_matrix ? null : 'Matris için yiyecek veya içecek seçin (Hepsi değil).',
    median_unit_cost: Number.isFinite(median_unit_cost) ? median_unit_cost : null,
    median_unit_cost_eur:
      currency === 'EUR' && Number.isFinite(median_unit_cost) ? median_unit_cost : null,
    median_qty_display: Number.isFinite(median_qty_display) ? median_qty_display : null,
    quadrant_split_x: Number.isFinite(median_unit_cost) ? median_unit_cost : null,
    quadrant_split_y: Number.isFinite(median_qty_display) ? median_qty_display : null,
    rows,
    totalRows: filtered.length,
    unfiltered_sku: itemsFullCount,
    page,
    pageSize,
    threshold_pct,
    baslangic,
    bitis,
    tip,
    table_currency: currency,
    maliyet_eksik: {
      count: maliyet_eksik_urunler.length,
      urunler: maliyet_eksik_urunler.slice(0, 400)
    }
  };
}

function exportRowsToCsv(items, tipSelected, currency) {
  const cur = currency === 'EUR' ? 'EUR' : 'TL';
  const unitHdr = `unit_cost_${cur.toLowerCase()}`;
  const headers = [
    'item_name',
    'category',
    'raw_tuketim_miktar_satir',
    'consumption_pct',
    unitHdr,
    'qty_display_kg_or_L',
    'me_quadrant',
    'quadrant_label',
    'consumption_tier',
    'suggestion'
  ];
  const lines = [headers.join(',')];
  const tipOn = !!tipSelected;
  for (const r of items) {
    const qLab = quadrantCellLabel(r.me_quadrant, tipOn);
    const uc = r.unit_cost != null ? r.unit_cost : cur === 'EUR' ? r.unit_cost_eur : r.unit_cost_tl;
    const row = [
      `"${String(r.item_name).replace(/"/g, '""')}"`,
      `"${String(r.category || '').replace(/"/g, '""')}"`,
      r.consumption_quantity_raw,
      r.consumption_pct,
      uc != null ? uc : '',
      r.qty_display != null ? r.qty_display : '',
      `"${String(r.me_quadrant || '').replace(/"/g, '""')}"`,
      `"${String(qLab).replace(/"/g, '""')}"`,
      r.consumption_tier,
      `"${String(r.suggestion || '').replace(/"/g, '""')}"`
    ];
    lines.push(row.join(','));
  }
  return '\uFEFF' + lines.join('\n');
}

function exportRowsToXlsx(items, tipSelected, currency) {
  const tipOn = !!tipSelected;
  const cur = currency === 'EUR' ? 'EUR' : 'TL';
  const unitKey = cur === 'EUR' ? 'birim_maliyet_eur' : 'birim_maliyet_tl';
  const ws = XLSX.utils.json_to_sheet(
    items.map((r) => {
      const uc = r.unit_cost != null ? r.unit_cost : cur === 'EUR' ? r.unit_cost_eur : r.unit_cost_tl;
      return {
        urun: r.item_name,
        kategori: r.category || '',
        miktar_payi_pct: r.consumption_pct,
        satir_ham_miktar: r.consumption_quantity_raw,
        [unitKey]: Number.isFinite(Number(uc)) ? +Number(uc).toFixed(6) : '',
        tuketim_kg_veya_L: r.qty_display != null ? +Number(r.qty_display).toFixed(6) : '',
        ceyrek_kodu: r.me_quadrant || '',
        ceyrek: quadrantCellLabel(r.me_quadrant, tipOn),
        tuketim_kademesi: r.consumption_tier,
        oneri: r.suggestion
      };
    })
  );
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Menu Engineering');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

async function exportFiltered(pool, query, sqlExcFinans, format) {
  const { filtered, tip, currency } = await computeFilteredItems(pool, query, sqlExcFinans);
  const fmt = String(format || 'csv').toLowerCase();
  if (fmt === 'xlsx') {
    return {
      body: exportRowsToXlsx(filtered, tip, currency),
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    };
  }
  return { body: exportRowsToCsv(filtered, tip, currency), contentType: 'text/csv; charset=utf-8' };
}

/**
 * Seçilen başlangıç döneminden en son tam aya kadar kümülatif tüketim (SKU bazında).
 * -15g hariç; yiyecek qty_display = kg (raw/1000), içecek = L.
 */
async function cumulativeConsumption(pool, query, sqlExcFinans) {
  let baslangic = String(query.baslangic || '').trim();
  if (!baslangic) throw new Error('baslangic parametresi gerekli');
  if (baslangic.endsWith('-15g')) baslangic = baslangic.slice(0, -4);
  if (!/^\d{4}-\d{2}$/.test(baslangic)) throw new Error('baslangic YYYY-MM olmalı');

  const tipN = normalizeTipInput(query.tip);
  const params = [baslangic];
  let tipSql = '';
  if (tipN === 'yiyecek') {
    tipSql = ` AND tip = 'yiyecek'`;
  } else if (tipN === 'icenek') {
    tipSql = ` AND tip IN ('icenek', 'icecek')`;
  }

  const { rows: bitisRows } = await pool.query(
    `
    SELECT MAX(tarih_str) AS bitis
    FROM fb_cost.tuketim
    WHERE tarih_str >= $1
      AND tarih_str NOT LIKE '%-15g'
      AND (${sqlExcFinans})
      ${tipSql}
    `,
    params
  );
  const bitis = bitisRows[0]?.bitis || null;
  if (!bitis) {
    return {
      baslangic,
      bitis: null,
      items: [],
      totals: { n_urun: 0, qty_kg: 0, qty_l: 0, tutar_tl: 0, tutar_eur: 0 }
    };
  }

  const { rows } = await pool.query(
    `
    SELECT
      stok_mali,
      CASE
        WHEN tip IN ('icenek', 'icecek') THEN 'icenek'
        ELSE 'yiyecek'
      END AS tip,
      MAX(kategori) AS kategori,
      SUM(ABS(COALESCE(tuk_miktar, 0)))::float8 AS qty_raw,
      SUM(COALESCE(tutar_tl, 0))::float8 AS tutar_tl,
      SUM(COALESCE(tutar_eur, 0))::float8 AS tutar_eur
    FROM fb_cost.tuketim
    WHERE tarih_str >= $1
      AND tarih_str <= $2
      AND tarih_str NOT LIKE '%-15g'
      AND (${sqlExcFinans})
      ${tipSql}
    GROUP BY stok_mali,
      CASE
        WHEN tip IN ('icenek', 'icecek') THEN 'icenek'
        ELSE 'yiyecek'
      END
    HAVING SUM(ABS(COALESCE(tuk_miktar, 0))) > 0
    ORDER BY SUM(ABS(COALESCE(tuk_miktar, 0))) DESC
    `,
    [baslangic, bitis]
  );

  const items = rows.map((r) => {
    const tip = r.tip === 'icenek' ? 'icenek' : 'yiyecek';
    const qtyRaw = +r.qty_raw || 0;
    const qtyDisplay = tip === 'yiyecek' ? qtyRaw / 1000 : qtyRaw;
    return {
      stok_mali: r.stok_mali,
      kategori: r.kategori || '',
      tip,
      qty_raw: qtyRaw,
      qty_display: +qtyDisplay.toFixed(6),
      qty_unit: tip === 'yiyecek' ? 'kg' : 'L',
      tutar_tl: +(r.tutar_tl || 0),
      tutar_eur: +(r.tutar_eur || 0)
    };
  });

  items.sort((a, b) => b.qty_display - a.qty_display);

  let qty_kg = 0;
  let qty_l = 0;
  let tutar_tl = 0;
  let tutar_eur = 0;
  for (const it of items) {
    if (it.tip === 'yiyecek') qty_kg += it.qty_display;
    else qty_l += it.qty_display;
    tutar_tl += it.tutar_tl;
    tutar_eur += it.tutar_eur;
  }

  return {
    baslangic,
    bitis,
    items,
    totals: {
      n_urun: items.length,
      qty_kg: +qty_kg.toFixed(6),
      qty_l: +qty_l.toFixed(6),
      tutar_tl: +tutar_tl.toFixed(4),
      tutar_eur: +tutar_eur.toFixed(4)
    }
  };
}

module.exports = {
  analyze,
  exportFiltered,
  cumulativeConsumption,
  ALLOWED_THRESHOLDS,
  PARETO_CHART_MAX,
  Q,
  QUADRANT_LABELS
};
