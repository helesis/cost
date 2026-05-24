'use strict';

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { normalizeTipInput } = require('./tipLabels');

const CONFIG_PATH = path.join(__dirname, '../config/menu-engineering-cost-proxy.json');

let _configCache = null;

function getCostProxyConfig() {
  if (!_configCache) {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    _configCache = JSON.parse(raw);
  }
  return _configCache;
}

function invalidateCostProxyConfig() {
  _configCache = null;
}

function classifyCostProxy(itemName, cfg) {
  const n = String(itemName || '').toLocaleLowerCase('tr-TR');
  for (const kw of cfg.HIGH || []) {
    if (n.includes(String(kw).toLocaleLowerCase('tr-TR'))) return 'HIGH';
  }
  for (const kw of cfg.MEDIUM || []) {
    if (n.includes(String(kw).toLocaleLowerCase('tr-TR'))) return 'MEDIUM';
  }
  for (const kw of cfg.LOW || []) {
    if (n.includes(String(kw).toLocaleLowerCase('tr-TR'))) return 'LOW';
  }
  return 'UNKNOWN';
}

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
  const v = values.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  return medianSorted(v);
}

/** X düşük = ucuz, Y yüksek = çok tüketim → sol üst Stars */
function quadrantFromCosts(xEuroPerUnit, yQtyDisp, medianX, medianY) {
  if (!Number.isFinite(xEuroPerUnit) || !Number.isFinite(yQtyDisp)) return Q.DOGS;
  if (!Number.isFinite(medianX) || !Number.isFinite(medianY)) return Q.STARS;

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

const ALLOWED_COST_FROM_DB = new Set(['HIGH', 'MEDIUM', 'LOW']);

/** product_classifications.cost_proxy — referans için (matris sürekli grafik kullanır) */
async function fetchCostProxyMap(pool, rawRows) {
  const map = new Map();
  if (!rawRows.length || !pool) return map;
  const stoks = [...new Set(rawRows.map((r) => r.item_name))];
  const { rows } = await pool.query(
    `
    SELECT stok_mali, kategori, cost_proxy, updated_at
    FROM fb_cost.product_classifications
    WHERE stok_mali = ANY($1::text[])
    `,
    [stoks]
  );
  const byStok = new Map();
  for (const r of rows) {
    if (!byStok.has(r.stok_mali)) byStok.set(r.stok_mali, []);
    byStok.get(r.stok_mali).push(r);
  }
  function resolve(stok, kat) {
    const list = byStok.get(stok) || [];
    const katNorm = kat == null || kat === '' ? '' : String(kat);
    const scored = list.map((p) => ({
      p,
      exact: (p.kategori || '') === katNorm ? 1 : 0,
      t: new Date(p.updated_at || 0).getTime()
    }));
    if (!scored.length) return null;
    scored.sort((a, b) => b.exact - a.exact || b.t - a.t);
    const cp = scored[0].p.cost_proxy;
    if (cp == null || String(cp).trim() === '') return null;
    const u = String(cp).trim().toUpperCase();
    return ALLOWED_COST_FROM_DB.has(u) ? u : null;
  }
  for (const r of rawRows) {
    const key = `${r.item_name}\0${r.category || ''}`;
    if (!map.has(key)) map.set(key, resolve(r.item_name, r.category));
  }
  return map;
}

/**
 * Tek tip için: yiyecek → kg ve EUR/kg; içecek → L ve EUR/L.
 * Üst yüzde eşiği tüketim sırasıyla (SKU sayısı) tanımlı.
 */
function buildAnalyzedItems(rawRows, thresholdPct, cfg, costProxyMap, currency, normalizedTip) {
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

    /** Y ekseni için ham tüketim: kg veya litre */
    let qtyDisplay = 0;
    if (normalizedTip === 'yiyecek') qtyDisplay = qtyRaw / 1000;
    else if (icenekBranch) qtyDisplay = qtyRaw;

    /** X ekseni için EUR birim başına ham maliyet (yiyecek: EUR/kg, içecek: EUR/L). Tip seçili değilse NaN */
    let unitCostEUR = NaN;
    if (normalizedTip === 'yiyecek') {
      const denom = qtyDisplay > 0 ? qtyDisplay : 0;
      const eurTot = +(r.amount_eur || 0) || 0;
      unitCostEUR = denom > 0 ? eurTot / denom : NaN;
    } else if (icenekBranch) {
      const eurTot = +(r.amount_eur || 0) || 0;
      unitCostEUR = qtyRaw > 0 ? eurTot / qtyRaw : NaN;
    }

    const ckey = `${r.item_name}\0${r.category || ''}`;
    const fromDb = costProxyMap && costProxyMap.get(ckey);
    const costProxy = fromDb || classifyCostProxy(r.item_name, cfg);

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
      unit_cost_eur: Number.isFinite(unitCostEUR) ? +unitCostEUR.toPrecision(14) : null,
      rank,
      consumption_tier: consumptionTier,
      cost_proxy: costProxy,
      me_quadrant: null,
      segment: null,
      suggestion: ''
    };
  });
}

function filterByQC(items, q, cost_proxy) {
  let out = items;
  if (q) {
    const ql = q.toLocaleLowerCase('tr-TR');
    out = out.filter(
      (r) =>
        String(r.item_name).toLocaleLowerCase('tr-TR').includes(ql) ||
        (r.category && String(r.category).toLocaleLowerCase('tr-TR').includes(ql))
    );
  }
  if (cost_proxy) {
    out = out.filter((r) => String(r.cost_proxy || '').trim().toUpperCase() === cost_proxy.trim().toUpperCase());
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
  return poolRows.map((r) => {
    const x = Number(r.unit_cost_eur);
    const y = Number(r.qty_display);
    const q =
      Number.isFinite(x) && Number.isFinite(y)
        ? quadrantFromCosts(x, y, medianX, medianY)
        : Q.DOGS;
    return {
      ...r,
      me_quadrant: q,
      segment: q,
      suggestion: QUADRANT_SUGGESTIONS[q] || ''
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
  const costProxyMap = await fetchCostProxyMap(pool, raw);
  const cfg = getCostProxyConfig();

  const curRaw = String(query.currency || 'TL').toUpperCase().trim();
  const currency = curRaw === 'EUR' ? 'EUR' : 'TL';

  const itemsFull = buildAnalyzedItems(raw, threshold_pct, cfg, costProxyMap, currency, tip || null);

  const poolQC = filterByQC(
    itemsFull,
    String(query.q || '').trim(),
    String(query.cost_proxy || '').trim().toUpperCase()
  );

  let median_unit_cost_eur = NaN;
  let median_qty_display = NaN;

  const validScatter = [];
  if (tip) {
    for (const r of poolQC) {
      const x = Number(r.unit_cost_eur);
      const y = Number(r.qty_display);
      if (Number.isFinite(x) && x >= 0 && Number.isFinite(y) && y > 0) validScatter.push(r);
    }
    const xs = validScatter.map((r) => r.unit_cost_eur);
    const ys = validScatter.map((r) => r.qty_display);
    median_unit_cost_eur = medianOf(xs);
    median_qty_display = medianOf(ys);
  }

  const withQuad = annotateQuadrantsAndSuggest(poolQC, tip, median_unit_cost_eur, median_qty_display);

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
    median_unit_cost_eur,
    median_qty_display,
    matrix_qty_unit: tip === 'yiyecek' ? 'kg' : tip === 'icenek' ? 'L' : null,
    normalized_tip_for_matrix: tip
  };
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
    median_unit_cost_eur,
    median_qty_display,
    matrix_qty_unit,
    normalized_tip_for_matrix
  } = await computeFilteredItems(pool, query, sqlExcFinans);

  const kpis = computeKpis(filtered);

  const paretoFull = paretoSeries(filtered.length ? filtered : []);
  const pareto = paretoFull.slice(0, PARETO_CHART_MAX);
  const pareto_truncated = paretoFull.length > PARETO_CHART_MAX;

  const page = Math.max(1, parseInt(String(query.page || '1'), 10) || 1);
  const pageSize = Math.min(200, Math.max(10, parseInt(String(query.pageSize || '50'), 10) || 50));
  const start = (page - 1) * pageSize;
  const rows = filtered.slice(start, start + pageSize).map((r) => ({
    item_name: r.item_name,
    category: r.category,
    consumption_quantity: r.consumption_quantity_raw,
    consumption_pct: r.consumption_pct,
    cost_proxy: r.cost_proxy,
    segment: r.segment,
    me_quadrant: r.me_quadrant,
    suggestion: r.suggestion,
    consumption_tier: r.consumption_tier,
    rank: r.rank,
    unit_cost_eur: r.unit_cost_eur,
    qty_display: r.qty_display,
    qty_display_unit: r.qty_display_unit
  }));

  const matrixEligible = normalized_tip_for_matrix ? filtered.filter(
    (r) => Number.isFinite(Number(r.unit_cost_eur)) && Number(r.unit_cost_eur) >= 0 &&
      Number.isFinite(Number(r.qty_display)) && Number(r.qty_display) > 0
  ) : [];

  const matrix = matrixEligible.map((r) => ({
    item_name: r.item_name,
    x: Number(r.unit_cost_eur),
    y: Number(r.qty_display),
    me_quadrant: r.me_quadrant,
    quadrant_label: QUADRANT_LABELS[r.me_quadrant] || '',
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
    matrix_currency: 'EUR',
    matrix_qty_unit: matrix_qty_unit || null,
    matrix_tip_required: normalized_tip_for_matrix ? null : 'Matris için yiyecek veya içecek seçin (Hepsi değil).',
    median_unit_cost_eur: Number.isFinite(median_unit_cost_eur) ? median_unit_cost_eur : null,
    median_qty_display: Number.isFinite(median_qty_display) ? median_qty_display : null,
    quadrant_split_x: Number.isFinite(median_unit_cost_eur) ? median_unit_cost_eur : null,
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
    table_currency: currency
  };
}

function exportRowsToCsv(items) {
  const headers = [
    'item_name',
    'category',
    'consumption_quantity_raw_g_or_l',
    'consumption_pct',
    'unit_cost_eur',
    'qty_display_kg_or_l',
    'me_quadrant',
    'cost_proxy',
    'consumption_tier',
    'suggestion'
  ];
  const lines = [headers.join(',')];
  for (const r of items) {
    const row = [
      `"${String(r.item_name).replace(/"/g, '""')}"`,
      `"${String(r.category || '').replace(/"/g, '""')}"`,
      r.consumption_quantity_raw,
      r.consumption_pct,
      r.unit_cost_eur != null ? r.unit_cost_eur : '',
      r.qty_display != null ? r.qty_display : '',
      `"${String(r.me_quadrant || '').replace(/"/g, '""')}"`,
      r.cost_proxy,
      r.consumption_tier,
      `"${String(r.suggestion || '').replace(/"/g, '""')}"`
    ];
    lines.push(row.join(','));
  }
  return '\uFEFF' + lines.join('\n');
}

function exportRowsToXlsx(items) {
  const ws = XLSX.utils.json_to_sheet(
    items.map((r) => ({
      urun: r.item_name,
      kategori: r.category || '',
      tuketim_gr_veya_l: r.consumption_quantity_raw,
      miktar_payi_pct: r.consumption_pct,
      birim_maliyet_eur:
        Number.isFinite(Number(r.unit_cost_eur)) ? +Number(r.unit_cost_eur).toFixed(6) : '',
      tuketim_ham_kg_veya_l: r.qty_display != null ? +Number(r.qty_display).toFixed(6) : '',
      ceyrek: QUADRANT_LABELS[r.me_quadrant] || r.me_quadrant,
      maliyet_proxy_kw: r.cost_proxy,
      tuketim_kademesi: r.consumption_tier,
      oneri: r.suggestion
    }))
  );
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Menu Engineering');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

async function exportFiltered(pool, query, sqlExcFinans, format) {
  const { filtered } = await computeFilteredItems(pool, query, sqlExcFinans);
  const fmt = String(format || 'csv').toLowerCase();
  if (fmt === 'xlsx') {
    return { body: exportRowsToXlsx(filtered), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  }
  return { body: exportRowsToCsv(filtered), contentType: 'text/csv; charset=utf-8' };
}

module.exports = {
  analyze,
  exportFiltered,
  getCostProxyConfig,
  invalidateCostProxyConfig,
  ALLOWED_THRESHOLDS,
  PARETO_CHART_MAX,
  Q,
  QUADRANT_LABELS
};
