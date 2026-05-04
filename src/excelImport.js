/**
 * Voyage F&B — Excel (tek sayfa) → tuketim satırları
 * /api/upload akışı ile aynı alanlara dönüştürür.
 */

'use strict';

const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

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

/** Uzun özet ifadeler — includes; 'kur'/'toplam' tek başına satır için kelime sınırı (kuru ≠ kur) */
const SKIP_STOKLAR_INCLUDES = [
  'brüt tüketim', 'net tüketim',
  'brut tuketim', 'net tuketim',
  'cost pax', 'stok malı', 'stok mali',
];
const SKIP_STOKLAR_WORD = ['toplam', 'kur'];
/* fiyat farkı / ödenmez (düşüm), KDV ilave: footer’dan okunur; gövdede çift sayım yok */

/** data/kiyas-group-headers.txt — [yiyecek] / [icenek] bölümleri */
function parseKiyasGroupHeadersFile(content) {
  const out = { yiyecek: [], icenek: [] };
  let section = null;
  for (const line of String(content).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const br = /^\[(yiyecek|icenek)\]$/i.exec(t);
    if (br) {
      section = br[1].toLowerCase();
      continue;
    }
    if (section === 'yiyecek' || section === 'icenek') {
      out[section].push(t);
    }
  }
  return out;
}

function loadKiyasGroupHeaders() {
  const filePath = path.join(__dirname, '..', 'data', 'kiyas-group-headers.txt');
  try {
    if (!fs.existsSync(filePath)) {
      console.warn('[excelImport] Eksik dosya (grup başlıkları boş):', filePath);
      return { yiyecek: [], icenek: [] };
    }
    return parseKiyasGroupHeadersFile(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.warn('[excelImport] kiyas-group-headers.txt okunamadı:', e.message);
    return { yiyecek: [], icenek: [] };
  }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function shouldSkipStokMaliLine(sm) {
  const low = sm.toLowerCase();
  if (SKIP_STOKLAR_INCLUDES.some((p) => low.includes(p))) return true;
  for (const w of SKIP_STOKLAR_WORD) {
    if (new RegExp(`\\b${escapeRe(w)}\\b`, 'i').test(sm)) return true;
  }
  return false;
}

/** Birleşik hücre: stok_mali boş ama satırda kod/bönim veya sıfır dışı sayı varsa doldurulur */
function rowHasMeaningfulData(numVals, stokNoStr, birim) {
  if (stokNoStr && String(stokNoStr).trim()) return true;
  if (birim && String(birim).trim()) return true;
  return NUMERIC_FIELDS.some((f) => {
    const n = numVals[f];
    return typeof n === 'number' && !Number.isNaN(n) && n !== 0;
  });
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

const _kiyasGroupHeaders = loadKiyasGroupHeaders();
const KNOWN_YIYECEK_GROUP_HEADERS = _kiyasGroupHeaders.yiyecek;
const KNOWN_ICENEK_GROUP_HEADERS = _kiyasGroupHeaders.icenek;

const FIXED_GROUP_HEADER_NORM_TO_LABEL = (() => {
  const m = new Map();
  for (const lab of KNOWN_YIYECEK_GROUP_HEADERS) {
    const k = `yiyecek:${normalizeText(lab)}`;
    if (k !== 'yiyecek:') m.set(k, lab);
  }
  for (const lab of KNOWN_ICENEK_GROUP_HEADERS) {
    const k = `icenek:${normalizeText(lab)}`;
    if (k !== 'icenek:') m.set(k, lab);
  }
  return m;
})();

function fixedGroupHeaderLabel(stokMali, tip) {
  const tipN = tip === 'icecek' ? 'icenek' : tip;
  if (tipN !== 'yiyecek' && tipN !== 'icenek') return null;
  const key = `${tipN}:${normalizeText(stokMali)}`;
  return FIXED_GROUP_HEADER_NORM_TO_LABEL.get(key) ?? null;
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
  // "kilogram" contains "gram" — önce kg / kilo
  if (b.includes('kilo') || b === 'kg' || b.endsWith('kg')) return t * 1000;
  if ((b.includes('gram') && !b.includes('kilo')) || b === 'gr' || b === 'g' || b.endsWith('gr')) {
    return t;
  }
  return t * 1000;
}

/**
 * İçecek: Excel miktarı litreye, birim fiyat TL/lt — tutar = lt × TL/lt korunur.
 * Pax başı cl DB’de (lt×100)/pax; özet toplamda sum(lt)/pax ile uyum için lt tek tip olmalı.
 */
function normalizeIcenekTukBirimFiyatToLitre(tuk, birimFiyat, birim) {
  const t = +tuk || 0;
  let bf = +birimFiyat || 0;
  const b = normalizeText(birim).replace(/ /g, '');
  if (!b) return { tuk_miktar: t, birim_fiyat: bf };
  if (b.includes('adet') || b.includes('piece') || b === 'pk') return { tuk_miktar: t, birim_fiyat: bf };
  if (b.includes('metrekup') || b === 'm3') {
    return { tuk_miktar: t * 1000, birim_fiyat: bf ? bf / 1000 : 0 };
  }
  if (b.includes('mili') || b === 'ml' || (b.endsWith('ml') && !b.includes('litre'))) {
    return { tuk_miktar: t / 1000, birim_fiyat: bf * 1000 };
  }
  if (b.includes('santi') || b === 'cl' || (b.endsWith('cl') && !b.includes('mili'))) {
    return { tuk_miktar: t / 100, birim_fiyat: bf * 100 };
  }
  if ((b.includes('decilit') || b === 'dl') && !b.includes('mili')) {
    return { tuk_miktar: t / 10, birim_fiyat: bf * 10 };
  }
  if (b.includes('litre') || b === 'lt' || b === 'l' || b.endsWith('lt')) {
    return { tuk_miktar: t, birim_fiyat: bf };
  }
  return { tuk_miktar: t, birim_fiyat: bf };
}

/**
 * tuk=0, tutar>0, birim>0: Excel D/E'den türet.
 * tuk=0, birim=0, tutar>0: sadece tutarı korumak için (KDV satırı vb.) birim fiyat=1, tuk sanal.
 */
function backfillTukBirim(tip, tuk, birimFiyat, tutarTl) {
  let t = +tuk || 0;
  let bf = +birimFiyat || 0;
  const tt = +tutarTl || 0;
  const tipN = tip === 'icecek' ? 'icenek' : tip;
  if (t !== 0) {
    return { tuk_miktar: t, birim_fiyat: bf };
  }
  if (bf > 0 && tt > 0) {
    if (tipN === 'yiyecek') {
      return { tuk_miktar: (tt / bf) * 1000, birim_fiyat: bf };
    }
    if (tipN === 'icenek') {
      return { tuk_miktar: tt / bf, birim_fiyat: bf };
    }
  }
  if (tt > 0 && t === 0 && bf === 0) {
    if (tipN === 'yiyecek') {
      return { tuk_miktar: tt * 1000, birim_fiyat: 1 };
    }
    if (tipN === 'icenek') {
      return { tuk_miktar: tt, birim_fiyat: 1 };
    }
  }
  return { tuk_miktar: t, birim_fiyat: bf };
}

const DIGER_GIDER = 'Diğer Giderler';

/**
 * Ürün değil, grup/kategori başlığı: yalnızca data/kiyas-group-headers.txt ile
 * normalizeText/normalize_text eşleşmesi (heuristik yok; listeye eklenmeyen satırlar ürün sayılır).
 */
function isGroupHeaderRow(stokMali, stokNoStr, numVals, tip) {
  return !!fixedGroupHeaderLabel(stokMali, tip);
}

/** Fiyat farkı / ödenmez (düşüm), KDV ilave (toplama): footer’da okunur; ürün gövdesinde aynı satır atlanır */
const STOK_NO_KDV_ILAVE = '__KDV_ILAVE__';

/**
 * Footer’da ayrı işlenen satırlar — ürün döngüsüne alınmaz (çift sayım olmasın).
 * normalizeText çıktısı ile çağırın.
 */
function isFooterFinanceSummaryNormalized(smn) {
  if (!smn) return false;
  if (smn.includes('fiyat fark')) return true;
  if (smn.includes('odenmez')) return true;
  if (smn.includes('kdv') && (smn.includes('ilave') || smn.includes('edilecek'))) return true;
  return false;
}

/** Sayfa sonu: fiyat farkı + ödenmez (düşüm, TL), KDV ilave (toplama, TL) */
function scanFooterDeductions(grid, startRow, colMap) {
  let fiyatFarki = 0;
  let odenmez = 0;
  let kdvIlave = 0;
  const tailFrom = Math.max(startRow, grid.length - 45);
  for (let r = tailFrom; r < grid.length; r++) {
    const row = grid[r] || [];
    const raw = getCell(row, colMap, 'stok_mali');
    const smn = normalizeText(raw);
    if (!smn) continue;
    const tut = parseNumberTR(getCell(row, colMap, 'tutar_tl'));
    if (smn.includes('fiyat fark')) {
      fiyatFarki += Math.abs(tut);
    } else if (smn.includes('odenmez')) {
      odenmez += Math.abs(tut);
    } else if (smn.includes('kdv') && (smn.includes('ilave') || smn.includes('edilecek'))) {
      kdvIlave += Math.abs(tut);
    }
  }
  return { fiyatFarki, odenmez, kdvIlave };
}

function buildDeductionRow(label, amountTl, tip, tarih, dosyaName, costPax, kur) {
  if (!(amountTl > 0)) return null;
  const tipN = tip === 'icecek' ? 'icenek' : tip;
  let tuk;
  let birim;
  if (tipN === 'yiyecek') {
    tuk = -amountTl * 1000;
    birim = 'Gram';
  } else {
    tuk = -amountTl;
    birim = 'Litre';
  }
  return {
    dosya: dosyaName,
    tip,
    tarih_str: tarih.tarih_str,
    yil: String(tarih.yil),
    ay_no: String(tarih.ay_no),
    ay: tarih.ay,
    gun: String(tarih.gun),
    cost_pax: costPax != null ? String(costPax) : '',
    kur: kur != null ? String(kur) : '',
    kategori: DIGER_GIDER,
    grup: DIGER_GIDER,
    stok_mali: label,
    stok_no: '__DUZELTME__',
    birim,
    tuk_miktar: String(tuk),
    birim_fiyat: '1',
  };
}

/** KDV ilave: tutara pozitif ekler (__KDV_ILAVE__); pp metrikleri API’de hariç */
function buildKdvIlaveRow(amountTl, tip, tarih, dosyaName, costPax, kur) {
  if (!(amountTl > 0)) return null;
  const tipN = tip === 'icecek' ? 'icenek' : tip;
  let tuk;
  let birim;
  if (tipN === 'yiyecek') {
    tuk = amountTl * 1000;
    birim = 'Gram';
  } else {
    tuk = amountTl;
    birim = 'Litre';
  }
  return {
    dosya: dosyaName,
    tip,
    tarih_str: tarih.tarih_str,
    yil: String(tarih.yil),
    ay_no: String(tarih.ay_no),
    ay: tarih.ay,
    gun: String(tarih.gun),
    cost_pax: costPax != null ? String(costPax) : '',
    kur: kur != null ? String(kur) : '',
    kategori: DIGER_GIDER,
    grup: DIGER_GIDER,
    stok_mali: '— Excel: KDV ilave —',
    stok_no: STOK_NO_KDV_ILAVE,
    birim,
    tuk_miktar: String(tuk),
    birim_fiyat: '1',
  };
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
  const pending = [];
  let forwardKategori = null;
  let lastStokMaliMerge = '';

  function flushPending(label) {
    const lab = label != null && String(label).trim() ? String(label).trim() : '';
    for (const pr of pending) {
      pr.kategori = lab;
      pr.grup = lab;
    }
    out.push(...pending);
    pending.length = 0;
  }

  for (let r = headerRowIdx + 1; r < grid.length; r++) {
    const row = grid[r] || [];
    const stokMali = getCell(row, bestMap, 'stok_mali');
    let sm = stokMali != null && String(stokMali).trim() ? String(stokMali).trim() : '';

    const stokNo = getCell(row, bestMap, 'stok_no');
    const stokNoStr = stokNo != null && String(stokNo).trim() ? String(stokNo).trim() : '';
    const birim = getCell(row, bestMap, 'birim') != null ? String(getCell(row, bestMap, 'birim')).trim() : '';

    const numVals = {};
    for (const f of NUMERIC_FIELDS) {
      numVals[f] = parseNumberTR(getCell(row, bestMap, f));
    }

    if (!sm && lastStokMaliMerge && rowHasMeaningfulData(numVals, stokNoStr, birim)) {
      sm = lastStokMaliMerge;
    }
    if (!sm) continue;
    if (shouldSkipStokMaliLine(sm)) continue;
    const smnBody = normalizeText(sm);
    if (isFooterFinanceSummaryNormalized(smnBody)) continue;

    if (isGroupHeaderRow(sm, stokNoStr, numVals, tip)) {
      lastStokMaliMerge = '';
      const label = fixedGroupHeaderLabel(sm, tip) || sm;
      if (pending.length > 0) {
        flushPending(label);
        forwardKategori = null;
      } else {
        forwardKategori = label;
      }
      continue;
    }

    /* stok_mali dolu, skip/grup başlığı değilse satırı atlamıyoruz (stok_no boş / tüm
     * sayılar 0 olsa bile kayıt oluşsun; aksi halde Excel’de görünen kalemler DB’de eksik kalıyordu). */

    lastStokMaliMerge = sm;

    const rowObj = {
      dosya: name,
      tip,
      tarih_str: tarih.tarih_str,
      yil: String(tarih.yil),
      ay_no: String(tarih.ay_no),
      ay: tarih.ay,
      gun: String(tarih.gun),
      cost_pax: costPax != null ? String(costPax) : '',
      kur: kur != null ? String(kur) : '',
      kategori: forwardKategori || '',
      grup: forwardKategori || '',
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
    };

    if (forwardKategori) {
      out.push(rowObj);
    } else {
      pending.push(rowObj);
    }
  }

  if (pending.length > 0) {
    flushPending(forwardKategori || '');
  }
  const { fiyatFarki, odenmez, kdvIlave } = scanFooterDeductions(grid, headerRowIdx + 1, bestMap);
  const dff = buildDeductionRow('— Excel: Fiyat farkı düşümü —', fiyatFarki, tip, tarih, name, costPax, kur);
  const dod = buildDeductionRow('— Excel: Ödenmez toplamı düşümü —', odenmez, tip, tarih, name, costPax, kur);
  const kdvR = buildKdvIlaveRow(kdvIlave, tip, tarih, name, costPax, kur);
  if (dff) {
    out.push({
      ...dff,
      tutar_tl: '0',
      tutar_eur: '0',
      pp_miktar: '0',
      pp_tl: '0',
      pp_eur: '0',
      pp_gr: '0',
      pp_cl: '0',
    });
  }
  if (dod) {
    out.push({
      ...dod,
      tutar_tl: '0',
      tutar_eur: '0',
      pp_miktar: '0',
      pp_tl: '0',
      pp_eur: '0',
      pp_gr: '0',
      pp_cl: '0',
    });
  }
  if (kdvR) {
    out.push({
      ...kdvR,
      tutar_tl: '0',
      tutar_eur: '0',
      pp_miktar: '0',
      pp_tl: '0',
      pp_eur: '0',
      pp_gr: '0',
      pp_cl: '0',
    });
  }

  if (out.length === 0) {
    return { rows: [], error: 'Ürün satırı bulunamadı.' };
  }
  return { rows: out, error: null };
}

/**
 * Yükleme: yiyecek tuk → gram, icenek tuk = litre. Tutar/pp DB'de türetilir; burada sadece
 * miktar/birim fiyat (ve kur, cost pax) kalır. Eski CSV'lerde tuk yoksa tutar_tl + birim fiyatle doldurur.
 */
function normalizeTuketimRowForDb(r) {
  const o = { ...r };
  o.tip = o.tip === 'icecek' ? 'icenek' : o.tip;
  const birim = o.birim || '';
  let tuk = parseFloat(o.tuk_miktar) || 0;
  let birimF = parseFloat(o.birim_fiyat) || 0;
  const tutar = parseFloat(o.tutar_tl) || 0;
  if (o.tip === 'yiyecek') {
    tuk = normalizeTukMiktarYiyecekKgToGr(tuk, birim);
  }
  const filled = backfillTukBirim(o.tip, tuk, birimF, tutar);
  tuk = filled.tuk_miktar;
  birimF = filled.birim_fiyat;
  if (o.tip === 'icenek') {
    const lit = normalizeIcenekTukBirimFiyatToLitre(tuk, birimF, birim);
    tuk = lit.tuk_miktar;
    birimF = lit.birim_fiyat;
  }
  o.tuk_miktar = String(tuk);
  o.birim_fiyat = String(birimF);
  if ((o.grup == null || String(o.grup).trim() === '') && o.kategori) {
    o.grup = o.kategori;
  }
  delete o.tutar_tl;
  delete o.tutar_eur;
  delete o.pp_gr;
  delete o.pp_cl;
  delete o.pp_tl;
  delete o.pp_eur;
  delete o.pp_miktar;
  return o;
}

module.exports = { parseExcelToRows, normalizeText, normalizeTuketimRowForDb };
