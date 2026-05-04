'use strict';

/**
 * Türkçe yazımlar ve eski "icecek" → DB kanonik tip (yiyecek | icenek).
 */
function normalizeTipInput(raw) {
  if (raw == null) return null;
  const s0 = String(raw).trim();
  if (!s0) return null;
  const s = s0.replace('İ', 'i').replace('I', 'ı').toLowerCase().replace(/\s+/g, '');
  const asc = s.replace(/ç/g, 'c').replace(/ğ/g, 'g').replace(/ı/g, 'i').replace(/ö/g, 'o').replace(/ş/g, 's').replace(/ü/g, 'u');
  if (asc === 'yiyecek') return 'yiyecek';
  if (asc === 'icenek' || asc === 'icecek') return 'icenek';
  return null;
}

/** DB değeri → arayüzde gösterilecek Türkçe etiket */
function tipDisplayTr(tip) {
  if (tip == null || tip === '') return '—';
  const tn = normalizeTipInput(tip);
  if (tn === 'yiyecek') return 'Yiyecek';
  if (tn === 'icenek') return 'İçecek';
  return String(tip);
}

/**
 * tuketim.tip için SQL AND parçası; icenek ile legacy icecek satırları birlikte seçilir.
 */
function tipFilterSql(params, tipQuery) {
  if (tipQuery == null || String(tipQuery).trim() === '') return { clause: '', ok: true };
  const tn = normalizeTipInput(String(tipQuery).trim());
  if (!tn) return { clause: ' AND 1=0', ok: false };
  if (tn === 'yiyecek') {
    const i = params.length + 1;
    params.push('yiyecek');
    return { clause: ` AND tip = $${i}`, ok: true };
  }
  const i = params.length + 1;
  params.push('icenek', 'icecek');
  return { clause: ` AND tip IN ($${i}, $${i + 1})`, ok: true };
}

module.exports = { normalizeTipInput, tipDisplayTr, tipFilterSql };
