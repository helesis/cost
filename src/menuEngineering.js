'use strict';

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

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

function costProxyToX(cost) {
  switch (cost) {
    case 'LOW':
      return 0.15;
    case 'MEDIUM':
      return 0.5;
    case 'HIGH':
      return 0.85;
    default:
      return 0.5;
  }
}

const SEGMENT_SUGGESTIONS = {
  STARS: 'Korunmalı',
  VOLUME_RISK: 'Maliyet kontrolü',
  OPPORTUNITY: 'Görünürlük artır',
  DEAD_STOCK: 'Listeden çıkar',
  REVIEW_REQUIRED: 'İncelenmeli'
};

function assignSegment(consumptionTier, costProxy) {
  if (costProxy === 'UNKNOWN') return 'REVIEW_REQUIRED';
  const costHigh = costProxy === 'HIGH';
  const costLowMed = costProxy === 'LOW' || costProxy === 'MEDIUM';
  if (consumptionTier === 'HIGH' && costLowMed) return 'STARS';
  if (consumptionTier === 'HIGH' && costHigh) return 'VOLUME_RISK';
  if (consumptionTier === 'LOW' && costHigh) return 'OPPORTUNITY';
  if (consumptionTier === 'LOW' && costLowMed) return 'DEAD_STOCK';
  return 'REVIEW_REQUIRED';
}

const ALLOWED_THRESHOLDS = new Set([20, 30, 40]);

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
      SUM(ABS(COALESCE(tuk_miktar, 0)))::float8 AS consumption_quantity,
      MAX(kategori) AS category
    FROM fb_cost.tuketim
    WHERE tarih_str >= $1 AND tarih_str <= $2
      ${tipSql}
      AND (${sqlExcFinans})
    GROUP BY stok_mali
    HAVING SUM(ABS(COALESCE(tuk_miktar, 0))) > 0
    ORDER BY consumption_quantity DESC
    `,
    params
  );
  return rows;
}

function buildAnalyzedItems(rawRows, thresholdPct, cfg) {
  const N = rawRows.length;
  const cutoff = N === 0 ? 0 : Math.max(1, Math.ceil((N * thresholdPct) / 100));
  const totalQty = rawRows.reduce((s, r) => s + (+r.consumption_quantity || 0), 0);

  return rawRows.map((r, idx) => {
    const qty = +r.consumption_quantity || 0;
    const pct = totalQty > 0 ? (100 * qty) / totalQty : 0;
    const rank = idx + 1;
    const consumptionTier = rank <= cutoff ? 'HIGH' : 'LOW';
    const costProxy = classifyCostProxy(r.item_name, cfg);
    const segment = assignSegment(consumptionTier, costProxy);
    return {
      item_name: r.item_name,
      category: r.category,
      consumption_quantity: qty,
      consumption_pct: +pct.toFixed(4),
      rank,
      consumption_tier: consumptionTier,
      cost_proxy: costProxy,
      segment,
      suggestion: SEGMENT_SUGGESTIONS[segment] || '',
      matrix_x: costProxyToX(costProxy),
      matrix_y: +pct.toFixed(4)
    };
  });
}

function filterItems(items, { q, segment, cost_proxy }) {
  let out = items;
  if (q) {
    const ql = q.toLocaleLowerCase('tr-TR');
    out = out.filter(
      (r) =>
        String(r.item_name).toLocaleLowerCase('tr-TR').includes(ql) ||
        (r.category && String(r.category).toLocaleLowerCase('tr-TR').includes(ql))
    );
  }
  if (segment) {
    out = out.filter((r) => r.segment === segment);
  }
  if (cost_proxy) {
    out = out.filter((r) => r.cost_proxy === cost_proxy);
  }
  return out;
}

function computeKpis(items) {
  const totalSku = items.length;
  const totalConsumption = items.reduce((s, r) => s + r.consumption_quantity, 0);
  const sorted = [...items].sort((a, b) => b.consumption_quantity - a.consumption_quantity);
  let top20share = 0;
  for (let i = 0; i < Math.min(20, sorted.length); i++) {
    top20share += sorted[i].consumption_pct;
  }
  const volumeRisk = items.filter((r) => r.segment === 'VOLUME_RISK').length;
  const deadStock = items.filter((r) => r.segment === 'DEAD_STOCK').length;
  return {
    total_sku: totalSku,
    total_consumption: totalConsumption,
    top20_share_pct: +top20share.toFixed(2),
    volume_risk_count: volumeRisk,
    dead_stock_count: deadStock
  };
}

function paretoSeries(items) {
  const sorted = [...items].sort((a, b) => b.consumption_quantity - a.consumption_quantity);
  const total = sorted.reduce((s, r) => s + r.consumption_quantity, 0);
  let cum = 0;
  return sorted.map((r) => {
    cum += r.consumption_quantity;
    return {
      item_name: r.item_name,
      consumption: r.consumption_quantity,
      cum_pct: total > 0 ? +((100 * cum) / total).toFixed(2) : 0
    };
  });
}

/** matrix_x: LOW=0.15, MEDIUM=0.5, HIGH=0.85 — dikey çizgi MED–HIGH ortası */
const QUADRANT_SPLIT_X_DEFAULT = (0.5 + 0.85) / 2;

function computeQuadrantSplits(filtered, threshold_pct) {
  if (!filtered.length) {
    return { quadrant_split_x: QUADRANT_SPLIT_X_DEFAULT, quadrant_split_y: 0 };
  }
  const N = filtered.length;
  const cutoff = Math.max(1, Math.ceil((N * threshold_pct) / 100));
  const sortedByQty = [...filtered].sort((a, b) => b.consumption_quantity - a.consumption_quantity);
  const lastHigh = sortedByQty[cutoff - 1];
  const firstLow = sortedByQty[cutoff];
  let quadrant_split_y = 0;
  if (lastHigh && firstLow) {
    quadrant_split_y = (lastHigh.consumption_pct + firstLow.consumption_pct) / 2;
  } else if (lastHigh) {
    quadrant_split_y = lastHigh.consumption_pct * 0.5;
  }
  return { quadrant_split_x: QUADRANT_SPLIT_X_DEFAULT, quadrant_split_y };
}

const PARETO_CHART_MAX = 100;
const MATRIX_CHART_MAX = 1500;

async function computeFilteredItems(pool, query, sqlExcFinans) {
  const baslangic = String(query.baslangic || '').trim();
  const bitis = String(query.bitis || '').trim();
  if (!baslangic || !bitis) {
    throw new Error('baslangic ve bitis parametreleri gerekli');
  }

  let threshold_pct = parseInt(String(query.threshold_pct || '30'), 10);
  if (!ALLOWED_THRESHOLDS.has(threshold_pct)) threshold_pct = 30;

  const tip = String(query.tip || '').trim();

  const raw = await fetchAggregates(pool, baslangic, bitis, tip, sqlExcFinans);
  const cfg = getCostProxyConfig();
  const itemsFull = buildAnalyzedItems(raw, threshold_pct, cfg);

  const filtered = filterItems(itemsFull, {
    q: String(query.q || '').trim(),
    segment: String(query.segment || '').trim(),
    cost_proxy: String(query.cost_proxy || '').trim()
  });

  return {
    filtered,
    threshold_pct,
    baslangic,
    bitis,
    tip: tip || null,
    itemsFullCount: itemsFull.length
  };
}

async function analyze(pool, query, sqlExcFinans) {
  const { filtered, threshold_pct, baslangic, bitis, tip, itemsFullCount } = await computeFilteredItems(
    pool,
    query,
    sqlExcFinans
  );

  const kpis = computeKpis(filtered);
  const { quadrant_split_x, quadrant_split_y } = computeQuadrantSplits(filtered, threshold_pct);
  const paretoFull = paretoSeries(filtered);
  const pareto = paretoFull.slice(0, PARETO_CHART_MAX);
  const pareto_truncated = paretoFull.length > PARETO_CHART_MAX;

  const page = Math.max(1, parseInt(String(query.page || '1'), 10) || 1);
  const pageSize = Math.min(200, Math.max(10, parseInt(String(query.pageSize || '50'), 10) || 50));
  const start = (page - 1) * pageSize;
  const rows = filtered.slice(start, start + pageSize).map((r) => ({
    item_name: r.item_name,
    category: r.category,
    consumption_quantity: r.consumption_quantity,
    consumption_pct: r.consumption_pct,
    cost_proxy: r.cost_proxy,
    segment: r.segment,
    suggestion: r.suggestion,
    consumption_tier: r.consumption_tier,
    rank: r.rank
  }));

  const matrix = filtered.map((r) => ({
    item_name: r.item_name,
    consumption_pct: r.consumption_pct,
    segment: r.segment,
    cost_proxy: r.cost_proxy,
    x: r.matrix_x,
    y: r.matrix_y
  }));

  let matrixOut = matrix;
  let matrix_truncated = false;
  if (matrixOut.length > MATRIX_CHART_MAX) {
    matrixOut = [...matrixOut].sort((a, b) => b.consumption_pct - a.consumption_pct).slice(0, MATRIX_CHART_MAX);
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
    rows,
    totalRows: filtered.length,
    unfiltered_sku: itemsFullCount,
    page,
    pageSize,
    threshold_pct,
    quadrant_split_x,
    quadrant_split_y,
    baslangic,
    bitis,
    tip
  };
}

function exportRowsToCsv(items) {
  const headers = [
    'item_name',
    'category',
    'consumption_quantity',
    'consumption_pct',
    'cost_proxy',
    'consumption_tier',
    'segment',
    'suggestion'
  ];
  const lines = [headers.join(',')];
  for (const r of items) {
    const row = [
      `"${String(r.item_name).replace(/"/g, '""')}"`,
      `"${String(r.category || '').replace(/"/g, '""')}"`,
      r.consumption_quantity,
      r.consumption_pct,
      r.cost_proxy,
      r.consumption_tier,
      r.segment,
      `"${String(r.suggestion).replace(/"/g, '""')}"`
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
      tuketim: r.consumption_quantity,
      yuzde: r.consumption_pct,
      maliyet_proxy: r.cost_proxy,
      tuketim_kademesi: r.consumption_tier,
      segment: r.segment,
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
  PARETO_CHART_MAX
};
