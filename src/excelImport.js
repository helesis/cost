/**
 * Voyage F&B — Excel (tek sayfa) → tuketim satırları
 * /api/upload akışı ile aynı alanlara dönüştürür.
 */

'use strict';

const XLSX = require('xlsx');

/** Ay: birden çok isim (ASCII / Türkçe) aynı ay_no */
const AY_CESITLERI = [
  { no: 1, names: ['OCAK'] },
  { no: 2, names: ['ŞUBAT', 'SUBAT'] },
  { no: 3, names: ['MART'] },
  { no: 4, names: ['NİSAN', 'NISAN'] },
  { no: 5, names: ['MAYIS'] },
  { no: 6, names: ['HAZİRAN', 'HAZIRAN'] },
  { no: 7, names: ['TEMMUZ'] },
  { no: 8, names: ['AĞUSTOS', 'AGUSTOS'] },
  { no: 9, names: ['EYLÜL', 'EYLUL'] },
  { no: 10, names: ['EKİM', 'EKIM'] },
  { no: 11, names: ['KASIM'] },
  { no: 12, names: ['ARALIK'] },
];

const AY_GOSTER = { 1: 'OCAK', 2: 'ŞUBAT', 3: 'MART', 4: 'NİSAN', 5: 'MAYIS', 6: 'HAZİRAN', 7: 'TEMMUZ', 8: 'AĞUSTOS', 9: 'EYLÜL', 10: 'EKİM', 11: 'KASIM', 12: 'ARALIK' };

const SKIP_STOKLAR = [
  'brüt tüketim', 'fiyat farkı', 'ödenmez', 'net tüketim',
  'toplam', 'cost pax', 'kur', 'stok malı',
];

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeText(value) {
  if (value == null) return '';
  const s = String(value).trim();
  if (!s || s.toLowerCase() === 'nan') return '';
  return s
    .replace(/[₺€$]/g, ' ')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\n\r\t]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const HEADER_ALIASES = {
  stok_mali: [
    'stok mali', 'stok malı', 'stok adi', 'stok adı', 'malzeme', 'urun', 'ürün', 'aciklama', 'açıklama',
  ],
  stok_no: [
    'stok no', 'stok no.', 'stok kodu', 'stok kod', 'kod', 'malzeme kodu', 'malzeme no', 'urun kodu', 'ürün kodu',
  ],
  birim: ['birim', 'olcu birimi', 'ölçü birimi', 'olcu', 'ölçü', 'unit'],
  tuk_miktar: [
    'tuk miktar', 'tük miktar', 'tuketim', 'tüketim', 'tuketim miktari', 'tüketim miktarı',
    'miktar', 'harcama miktari', 'gerek tuk', 'gertuk',
  ],
  birim_fiyat: ['birim fiyat', 'fiyat', 'alis fiyat', 'alış fiyat', 'unit price'],
  tutar_tl: [
    'tutar tl', 'toplam tl', 'tutar try', 'toplam tutar tl', 'gerek tuk tutar',
  ],
  tutar_eur: ['tutar eur', 'toplam eur', 'toplam euro', 'tuk eur', 'tuk e'],
  pp_miktar: [
    'pp miktar', 'pp gr', 'pp cl', 'kisi basi miktar', 'kişi başı miktar', 'pax basi miktar', 'pax başı miktar',
  ],
  pp_tl: ['pp tl', 'kisi basi tl', 'kişi başı tl', 'p p tl', 'p p tl.'],
  pp_eur: ['pp eur', 'pp euro', 'kisi basi eur', 'p p eur', 'p p €'],
};

const ALIAS_TO_FIELD = (() => {
  const m = {};
  for (const [field, list] of Object.entries(HEADER_ALIASES)) {
    for (const a of list) m[normalizeText(a)] = field;
  }
  return m;
})();

const NUMERIC_FIELDS = ['tuk_miktar', 'birim_fiyat', 'tutar_tl', 'tutar_eur', 'pp_miktar', 'pp_tl', 'pp_eur'];
const REQUIRED_HEADER_FIELDS = ['stok_mali', 'stok_no', 'birim'];

function detectColumnMap(headerRow) {
  const columnMap = {};
  const matched = [];
  for (let idx = 0; idx < headerRow.length; idx++) {
    const norm = normalizeText(headerRow[idx]);
    if (!norm) continue;
    const direct = ALIAS_TO_FIELD[norm];
    if (direct && columnMap[direct] == null) {
      columnMap[direct] = idx;
      matched.push(direct);
      continue;
    }
    for (const [aliasNorm, field] of Object.entries(ALIAS_TO_FIELD)) {
      if (columnMap[field] != null) continue;
      if (
        norm === aliasNorm ||
        norm.startsWith(aliasNorm) ||
        (aliasNorm.length >= 4 && (norm.includes(aliasNorm) || aliasNorm.includes(norm)))
      ) {
        columnMap[field] = idx;
        matched.push(field);
        break;
      }
    }
  }
  for (let idx = 0; idx < headerRow.length; idx++) {
    const n = normalizeText(headerRow[idx]);
    if (!n) continue;
    if (columnMap.tutar_eur == null && (n.startsWith('tuk e') && (n.includes('eur') || n.includes('euro') || n.endsWith(' e')))) {
      columnMap.tutar_eur = idx;
      matched.push('tutar_eur');
    }
    if (columnMap.pp_miktar == null && n.includes('p p') && (n.includes('gr') || n.includes('cl') || n.includes('ml'))) {
      columnMap.pp_miktar = idx;
      matched.push('pp_miktar');
    }
  }
  if (columnMap.tutar_tl == null) {
    for (let idx = 0; idx < headerRow.length; idx++) {
      const n = normalizeText(headerRow[idx]);
      if (n === 'tl' || n === 'try' || n === 'tutar try') {
        columnMap.tutar_tl = idx;
        matched.push('tutar_tl');
        break;
      }
    }
  }
  return { columnMap, matchedFields: matched };
}

function parseNumberTR(val) {
  if (val == null) return 0;
  if (typeof val === 'number' && !Number.isNaN(val)) return val;
  if (val instanceof Date) return 0;
  let s = String(val).trim();
  if (!s || s.toLowerCase() === 'nan') return 0;
  s = s.replace('\xa0', ' ').replace(/[₺€$]/gi, '').replace(/TL|TRY|EUR|Euro|€/gi, '').replace(/\s+/g, '');
  s = s.replace(/[^0-9,.-]/g, '');
  if (s === '' || s === '-' || s === '–') return 0;
  if (s.includes(',') && s.includes('.')) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
  } else if (s.includes(',')) {
    const parts = s.split(',');
    if (parts[parts.length - 1].length <= 3) s = parts.slice(0, -1).join('') + '.' + parts[parts.length - 1];
    else s = s.replace(/,/g, '');
  } else if ((s.match(/\./g) || []).length > 1) {
    const p = s.split('.');
    if (p[p.length - 1].length <= 3) s = p.slice(0, -1).join('') + '.' + p[p.length - 1];
    else s = s.replace(/\./g, '');
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function sheetTo2d(ws) {
  if (!ws || !ws['!ref']) return [[]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });
}

function getCell(row, colMap, key) {
  const j = colMap[key];
  if (j == null) return null;
  if (!row || j < 0 || j >= row.length) return null;
  return row[j];
}

function metaFromTop(grid, maxRows) {
  let costPax = null;
  let kur = null;
  const limitR = Math.min(grid.length, maxRows || 50);
  const lens = grid.slice(0, limitR).map((r) => (r && r.length) || 0);
  const w = Math.max(8, ...lens, 0);
  for (let i = 0; i < limitR; i++) {
    const row = grid[i] || [];
    for (let j = 0; j < w; j++) {
      const cell = normalizeText(row[j]);
      if (!cell) continue;
      if (cell === 'cost pax' || cell === 'costpax') {
        if (j + 1 < row.length) {
          const v = parseNumberTR(row[j + 1]);
          if (v > 0) costPax = v;
        }
      }
      if (cell === 'kur' || cell === 'doviz kuru' || cell === 'döviz kuru') {
        if (j + 1 < row.length) {
          const v = parseNumberTR(row[j + 1]);
          if (v > 0) kur = v;
        }
      }
    }
    if (costPax != null && kur != null) break;
  }
  return { costPax, kur };
}

/** "30 EYLÜL 2022" gibi ifadelerden tarih + tip */
function parseTarihVeTipFromText(text) {
  if (!text) return { tarih: null, tip: null };
  const u = String(text);
  const upper = u.toLocaleUpperCase('tr-TR');
  let tip = null;
  if (upper.includes('YİYECEK') || upper.includes('YIYECEK')) tip = 'yiyecek';
  else if (upper.includes('İÇECEK') || upper.includes('IÇECEK') || upper.includes('ICECEK') || upper.includes('İCENEK')) tip = 'icenek';

  let tarih = null;
  for (const { no, names } of AY_CESITLERI) {
    for (const name of names) {
      const re = new RegExp(`\\b(\\d{1,2})\\s+${escapeRe(name)}\\s+(20\\d{2})\\b`, 'iu');
      const m = u.match(re);
      if (m) {
        const gun = parseInt(m[1], 10);
        const yil = parseInt(m[2], 10);
        const last = new Date(yil, no, 0).getDate();
        if (gun < 1 || gun > 31) continue;
        if (new Date(yil, no - 1, gun).getMonth() !== no - 1) continue;
        const base = `${yil}-${String(no).padStart(2, '0')}`;
        const tarih_str = gun === 15 ? `${base}-15g` : base;
        tarih = {
          gun,
          yil,
          ay_no: no,
          ay: AY_GOSTER[no] || name,
          tarih_str,
          is_month_end: gun === last,
        };
        break;
      }
    }
    if (tarih) break;
  }
  return { tarih, tip };
}

/**
 * Rapor: yiyecek tüketim miktarı kaynakta genelde kilogram; DB’de gram tutulur.
 */
function normalizeTukMiktarYiyecekKgToGr(tuk, birim) {
  const t = +tuk || 0;
  const b = normalizeText(birim).replace(/ /g, '');
  if (b.includes('gram') || b === 'gr' || b === 'g' || b.endsWith('gr')) return t;
  return t * 1000;
}

/**
 * yiyecek: P.P. sütunu (P.P. / GR. vb.) gr cinsinden; ürün birim sütunundan bağımsız.
 * icenek: P.P. raporunda değer genelde litredir → DB’de pp_cl = santilitre.
 */
function ppGrClFixed(birim, ppMiktar, tip) {
  const b = normalizeText(birim).replace(/ /g, '');
  const x = +ppMiktar || 0;
  const tipN = tip === 'icecek' ? 'icenek' : tip;
  if (tipN === 'yiyecek') {
    return { pp_gr: x, pp_cl: 0 };
  }
  if (tipN === 'icenek') {
    if (b === 'cl' || (b.includes('santil') && !b.includes('litre'))) return { pp_gr: 0, pp_cl: x };
    if (b.includes('ml') || b.includes('mililitre') || b.includes('milil')) return { pp_gr: 0, pp_cl: x / 10 };
    if ((b.includes('litre') && !b.includes('mili')) || b === 'lt' || b === 'l') return { pp_gr: 0, pp_cl: x * 100 };
    return { pp_gr: 0, pp_cl: x * 100 };
  }
  return { pp_gr: 0, pp_cl: 0 };
}

function isCategoryRow(stokMali, stokNo, nums) {
  if (!stokMali) return false;
  const sn = (stokNo || '').toString().trim().toLowerCase();
  if (sn && sn !== '0' && sn !== 'nan') return false;
  if (nums.some((v) => v !== 0 && v != null)) return false;
  return /^\d{3,}/.test(stokMali) || stokMali.includes(' - ');
}

/**
 * @param {Buffer} buffer
 * @param {string} originalname
 * @returns {{ rows: object[], error?: string }}
 */
function parseExcelToRows(buffer, originalname) {
  const name = (originalname || 'upload.xlsx').split(/[\\/]/).pop() || 'upload.xlsx';
  if (!/\.(xlsx|xlsm|xls)$/i.test(name)) {
    return { rows: [], error: 'Sadece .xlsx / .xlsm / .xls kabul edilir' };
  }

  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, cellNF: false, sheetStubs: true });
  } catch (e) {
    return { rows: [], error: 'Excel açılamadı: ' + (e && e.message) };
  }
  if (!wb.SheetNames || !wb.SheetNames.length) {
    return { rows: [], error: 'Çalışma sayfası yok' };
  }
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const grid = sheetTo2d(ws);
  if (!grid.length) {
    return { rows: [], error: 'Sayfa boş' };
  }

  const titleBlob = grid
    .slice(0, 6)
    .map((r) => (r || []).map((c) => (c != null ? String(c) : '')).join(' '))
    .join(' ');

  const fromFile = parseTarihVeTipFromText(name);
  const fromTitle = parseTarihVeTipFromText(titleBlob);
  const tip = fromFile.tip || fromTitle.tip;
  if (!tip) {
    return { rows: [], error: 'Yiyecek / içecek tespit edilemedi. Başlık veya dosya adında "Yiyecek" / "İçecek" geçmeli.' };
  }
  const tarih = fromFile.tarih || fromTitle.tarih;
  if (!tarih) {
    return { rows: [], error: 'Tarih okunamadı. Başlıkta "30 EYLÜL 2022" gibi (gün + ay + yıl) ifadesi gerekir.' };
  }

  const { costPax, kur } = metaFromTop(grid, 45);

  let bestMap = null;
  let bestScore = -1;
  let headerRowIdx = -1;
  const maxScan = Math.min(grid.length, 50);
  for (let i = 0; i < maxScan; i++) {
    const row = grid[i] || [];
    const { columnMap, matchedFields } = detectColumnMap(row);
    const req = REQUIRED_HEADER_FIELDS.filter((f) => columnMap[f] != null).length;
    if (req < 2) continue;
    const score = req * 10 + matchedFields.length;
    if (score > bestScore) {
      bestScore = score;
      headerRowIdx = i;
      bestMap = columnMap;
    }
  }

  if (headerRowIdx < 0 || !bestMap) {
    return { rows: [], error: 'Tablo başlığı bulunamadı (Stok Malı, Stok No, Birim gerekir).' };
  }
  for (const f of REQUIRED_HEADER_FIELDS) {
    if (bestMap[f] == null) {
      return { rows: [], error: `Eksik sütun: ${f}` };
    }
  }

  const out = [];
  let kategori = null;

  for (let r = headerRowIdx + 1; r < grid.length; r++) {
    const row = grid[r] || [];
    const stokMali = getCell(row, bestMap, 'stok_mali');
    const sm = stokMali != null && String(stokMali).trim() ? String(stokMali).trim() : '';
    if (!sm) continue;
    if (SKIP_STOKLAR.some((s) => sm.toLowerCase().includes(s))) continue;

    const stokNo = getCell(row, bestMap, 'stok_no');
    const stokNoStr = stokNo != null && String(stokNo).trim() ? String(stokNo).trim() : '';
    const birim = getCell(row, bestMap, 'birim') != null ? String(getCell(row, bestMap, 'birim')).trim() : '';

    const numVals = {};
    for (const f of NUMERIC_FIELDS) {
      numVals[f] = parseNumberTR(getCell(row, bestMap, f));
    }

    if (isCategoryRow(sm, stokNoStr, Object.values(numVals))) {
      kategori = sm;
      continue;
    }

    const hasProduct = !!stokNoStr || numVals.tutar_tl > 0 || numVals.tuk_miktar > 0 || numVals.birim_fiyat > 0;
    if (!hasProduct) continue;

    out.push({
      dosya: name,
      tip,
      tarih_str: tarih.tarih_str,
      yil: String(tarih.yil),
      ay_no: String(tarih.ay_no),
      ay: tarih.ay,
      gun: String(tarih.gun),
      cost_pax: costPax != null ? String(costPax) : '',
      kur: kur != null ? String(kur) : '',
      kategori: kategori || '',
      stok_mali: sm,
      stok_no: stokNoStr,
      birim,
      tuk_miktar: String(numVals.tuk_miktar),
      birim_fiyat: String(numVals.birim_fiyat),
      tutar_tl: String(numVals.tutar_tl),
      tutar_eur: String(numVals.tutar_eur),
      pp_miktar: String(numVals.pp_miktar),
      pp_gr: '0',
      pp_cl: '0',
      pp_tl: String(numVals.pp_tl),
      pp_eur: String(numVals.pp_eur),
    });
  }

  if (out.length === 0) {
    return { rows: [], error: 'Ürün satırı bulunamadı.' };
  }
  return { rows: out, error: null };
}

/**
 * Yükleme (Excel/CSV) sonrası DB birimleri: yiyecek tuk gr, icenek pp_cl (lt→×100 cl).
 * pp_miktar gelmezse (eski CSV) mevcut pp_gr/pp_cl korunur; kayıt alanı yok, insert öncesi silinir.
 */
function normalizeTuketimRowForDb(r) {
  const o = { ...r };
  o.tip = o.tip === 'icecek' ? 'icenek' : o.tip;
  const birim = o.birim || '';
  if (o.tip === 'yiyecek') {
    o.tuk_miktar = String(normalizeTukMiktarYiyecekKgToGr(parseFloat(o.tuk_miktar) || 0, birim));
  }
  const ppMik = o.pp_miktar;
  const hasPpMik = ppMik != null && String(ppMik).trim() !== '';
  if (hasPpMik) {
    const { pp_gr, pp_cl } = ppGrClFixed(birim, parseFloat(ppMik) || 0, o.tip);
    o.pp_gr = String(pp_gr);
    o.pp_cl = String(pp_cl);
  } else {
    o.pp_gr = String(parseFloat(o.pp_gr) || 0);
    o.pp_cl = String(parseFloat(o.pp_cl) || 0);
  }
  if (o.pp_miktar !== undefined) {
    delete o.pp_miktar;
  }
  return o;
}

module.exports = { parseExcelToRows, normalizeText, normalizeTuketimRowForDb };
