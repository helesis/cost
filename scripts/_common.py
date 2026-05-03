"""
Voyage F&B Maliyet Analizi - Ortak Tarama Mantığı (v3)
======================================================
Sağlamlaştırılmış importer mantığı:
  - Sadece ismi "KIYAS ANALİZİ" içeren .xlsx dosyaları işlenir
  - Kategori (yiyecek/içecek) dosya adından çıkarılır
  - Tarih dosya adındaki ilk tarih'ten okunur
  - Geçmiş aylar: sadece ay sonu
  - Bulunduğumuz ay: ay sonu öncelikli, yoksa 15 fallback
  - Duplicate seçim: kök yol / daha kısa yol öncelikli
  - İlk sheet zorunlu değildir; tüm sheet'ler taranır, en iyi aday seçilir
  - Kolonlar sabit index ile değil, başlık isimlerine göre eşleştirilir
  - Sayısal değerler TR/EN formatlarına toleranslı parse edilir
  - Sessizce 0 yazmak yerine ham değer + parse durumu saklanır
  - Kontrol raporu ve hata logu üretilir
"""

from __future__ import annotations

import calendar
import math
import re
import unicodedata
import warnings
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any, Optional

warnings.filterwarnings("ignore")

try:
    import pandas as pd
except ImportError:
    raise SystemExit(
        "HATA: pandas kurulu değil.\n"
        "Terminale şunu yaz: pip3 install -r scripts/requirements.txt\n"
        "veya: pip3 install pandas openpyxl"
    )

AYLAR = {
    "OCAK": 1, "ŞUBAT": 2, "SUBAT": 2, "MART": 3, "NİSAN": 4, "NISAN": 4,
    "MAYIS": 5, "HAZİRAN": 6, "HAZIRAN": 6, "TEMMUZ": 7, "AĞUSTOS": 8,
    "AGUSTOS": 8, "EYLÜL": 9, "EYLUL": 9, "EKİM": 10, "EKIM": 10,
    "KASIM": 11, "ARALIK": 12,
}

SKIP_SATIRLAR = [
    "Brüt Tüketim", "Net Tüketim",
    "TOPLAM", "Cost Pax", "Kur", "Stok Malı",
]

HEADER_ALIASES = {
    "stok_mali": [
        "stok mali", "stok malı", "stok adi", "stok adı", "malzeme", "urun", "ürün", "aciklama", "açıklama"
    ],
    "stok_no": [
        "stok no", "stok kodu", "stok kod", "kod", "malzeme kodu", "malzeme no", "urun kodu", "ürün kodu"
    ],
    "birim": [
        "birim", "olcu birimi", "ölçü birimi", "olcu", "ölçü", "unit"
    ],
    "tuk_miktar": [
        "tuk miktar", "tük miktar", "tuketim", "tüketim", "tuketim miktari", "tüketim miktarı", "miktar", "harcama miktari"
    ],
    "birim_fiyat": [
        "birim fiyat", "fiyat", "alis fiyat", "alış fiyat", "unit price"
    ],
    "tutar_tl": [
        "tutar tl", "toplam tl", "tutar try", "tl", "toplam tutar tl"
    ],
    "tutar_eur": [
        "tutar eur", "toplam eur", "eur", "euro", "toplam euro"
    ],
    "pp_miktar": [
        "pp miktar", "kişi basi miktar", "kişi başı miktar", "pax basi miktar", "pax başı miktar", "pp"
    ],
    "pp_tl": [
        "pp tl", "kişi basi tl", "kişi başı tl", "pax basi tl", "pax başı tl"
    ],
    "pp_eur": [
        "pp eur", "pp euro", "kişi basi eur", "kişi başı eur", "kişi başı euro", "pax basi eur", "pax başı eur"
    ],
}

REQUIRED_HEADER_FIELDS = ["stok_mali", "stok_no", "birim"]
NUMERIC_FIELDS = ["tuk_miktar", "birim_fiyat", "tutar_tl", "tutar_eur", "pp_miktar", "pp_tl", "pp_eur"]
ALL_FIELDS = [
    "stok_mali", "stok_no", "birim", "tuk_miktar", "birim_fiyat", "tutar_tl", "tutar_eur", "pp_miktar", "pp_tl", "pp_eur"
]


@dataclass
class ParsedNumber:
    value: Optional[float]
    ok: bool
    raw: str
    reason: str = ""


@dataclass
class SheetCandidate:
    sheet_name: str
    header_row: Optional[int]
    column_map: dict[str, int]
    score: int
    matched_fields: list[str]
    sample_nonempty_rows: int


def normalize_text(value: Any) -> str:
    if value is None:
        return ""
    try:
        if pd.isna(value):
            return ""
    except Exception:
        pass
    s = str(value).strip()
    if not s or s.lower() == "nan":
        return ""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = s.replace("₺", " tl ").replace("€", " eur ").replace("$", " usd ")
    s = s.lower()
    s = re.sub(r"[\n\r\t]+", " ", s)
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


ALIAS_TO_FIELD: dict[str, str] = {}
for field, aliases in HEADER_ALIASES.items():
    for alias in aliases:
        ALIAS_TO_FIELD[normalize_text(alias)] = field


def kategori_bul(dosya_adi: str) -> Optional[str]:
    s = dosya_adi.upper()
    if "YİYECEK" in s or "YIYECEK" in s:
        return "yiyecek"
    if "İÇECEK" in s or "ICECEK" in s:
        return "icecek"
    return None


def dosya_tarih_coz(dosya_adi: str) -> Optional[dict]:
    s = dosya_adi.upper()
    ay_pattern = "|".join(AYLAR.keys())
    m = re.search(rf"\b(\d{{1,2}})\s+({ay_pattern})\s+(20\d{{2}})\b", s)
    if not m:
        return None

    gun = int(m.group(1))
    ay_adi = m.group(2)
    yil = int(m.group(3))
    ay_no = AYLAR[ay_adi]

    try:
        date(yil, ay_no, gun)
    except ValueError:
        return None

    return {
        "gun": gun,
        "ay": ay_adi,
        "ay_no": ay_no,
        "yil": yil,
        "tarih_str": f"{yil}-{ay_no:02d}",
        "tarih_iso": f"{yil}-{ay_no:02d}-{gun:02d}",
    }


def is_ay_sonu(gun: int, yil: int, ay_no: int) -> bool:
    return gun == calendar.monthrange(yil, ay_no)[1]


def bulundugumuz_ay(bugun: Optional[date] = None) -> tuple[int, int]:
    b = bugun or date.today()
    return b.year, b.month


def _yol_skoru(yol: Path) -> tuple[int, int, str]:
    yol_str = str(yol).upper()
    mrkz = 1 if ("MRKZ" in yol_str or "MERKEZ" in yol_str) else 0
    return (mrkz, len(yol.parts), str(yol))


def dosyalari_sec(ana_klasor: Path) -> tuple[list, list]:
    cari_yil, cari_ay = bulundugumuz_ay()
    tum_xlsx = [
        f for f in ana_klasor.rglob("*.xlsx")
        if not f.name.startswith("~") and not f.name.startswith(".")
    ]

    rapor = []
    adaylar = []

    for f in tum_xlsx:
        ad = unicodedata.normalize("NFC", f.name)
        ad_upper = ad.upper()
        has_kiyas = "KIYAS" in ad_upper
        has_analiz = any(x in ad_upper for x in ("ANALİZİ", "ANALIZI", "ANALİZI", "ANALIZİ"))
        if not (has_kiyas and has_analiz):
            rapor.append(("ATLA", f, "KIYAS ANALİZİ değil"))
            continue

        kat = kategori_bul(ad)
        if not kat:
            rapor.append(("ATLA", f, "yiyecek/içecek kategorisi belirsiz"))
            continue

        tarih = dosya_tarih_coz(ad)
        if not tarih:
            rapor.append(("ATLA", f, "dosya adında tarih bulunamadı"))
            continue

        gun = tarih["gun"]
        yil = tarih["yil"]
        ay_no = tarih["ay_no"]
        bu_ay = (yil == cari_yil and ay_no == cari_ay)

        if is_ay_sonu(gun, yil, ay_no):
            pass
        elif gun == 15 and bu_ay:
            pass
        else:
            sebep = "geçmiş ay, ay sonu değil" if not bu_ay else f"gün {gun}, geçerli değil"
            rapor.append(("ATLA", f, sebep))
            continue

        adaylar.append((tarih["tarih_iso"], kat, f, tarih))

    secim: dict[tuple, tuple] = {}
    for tarih_iso, kat, f, tarih in adaylar:
        key = (tarih_iso, kat)
        if key not in secim:
            secim[key] = (f, tarih)
            continue
        mevcut_yol = secim[key][0]
        if _yol_skoru(f) < _yol_skoru(mevcut_yol):
            rapor.append(("DUPLICATE", mevcut_yol, f"aynı tarih+kategori, tercih: {f.name}"))
            secim[key] = (f, tarih)
        else:
            rapor.append(("DUPLICATE", f, f"aynı tarih+kategori, tercih: {mevcut_yol.name}"))

    tarih_bu_ay_sonu = set()
    for (_, kat), (_, tarih) in secim.items():
        if (tarih["yil"], tarih["ay_no"]) == (cari_yil, cari_ay) and is_ay_sonu(tarih["gun"], tarih["yil"], tarih["ay_no"]):
            tarih_bu_ay_sonu.add(kat)

    nihai = {}
    for (tarih_iso, kat), (f, tarih) in secim.items():
        bu_ay = (tarih["yil"], tarih["ay_no"]) == (cari_yil, cari_ay)
        if bu_ay and tarih["gun"] == 15 and kat in tarih_bu_ay_sonu:
            rapor.append(("ATLA", f, "bu ay için ay sonu zaten var, 15 gereksiz"))
            continue
        nihai[(tarih_iso, kat)] = (f, tarih)
        rapor.append(("KABUL", f, f"{tarih_iso} | {kat}"))

    secilenler = [(f, tarih, kat) for (_, kat), (f, tarih) in nihai.items()]
    return secilenler, rapor


def parse_number(val: Any) -> ParsedNumber:
    raw = "" if val is None else str(val).strip()
    if val is None:
        return ParsedNumber(None, False, raw, "empty")
    try:
        if pd.isna(val):
            return ParsedNumber(None, False, raw, "empty")
    except Exception:
        pass

    if isinstance(val, (int, float)) and not isinstance(val, bool):
        if isinstance(val, float) and (math.isnan(val) or math.isinf(val)):
            return ParsedNumber(None, False, raw, "nan_or_inf")
        return ParsedNumber(float(val), True, raw, "")

    s = str(val).strip()
    if not s or s.lower() == "nan":
        return ParsedNumber(None, False, raw, "empty")

    s = s.replace("\xa0", " ")
    s = s.replace("₺", "").replace("€", "").replace("$", "")
    s = s.replace("TL", "").replace("EUR", "").replace("TRY", "").replace("Euro", "")
    s = re.sub(r"[^0-9,\.\-]", "", s)
    if not s:
        return ParsedNumber(None, False, raw, "no_numeric_content")

    if "," in s and "." in s:
        if s.rfind(",") > s.rfind("."):
            s = s.replace(".", "")
            s = s.replace(",", ".")
        else:
            s = s.replace(",", "")
    elif "," in s:
        parts = s.split(",")
        if len(parts[-1]) in (1, 2, 3):
            s = "".join(parts[:-1]).replace(".", "") + "." + parts[-1]
        else:
            s = s.replace(",", "")
    elif s.count(".") > 1:
        parts = s.split(".")
        if len(parts[-1]) in (1, 2, 3):
            s = "".join(parts[:-1]) + "." + parts[-1]
        else:
            s = s.replace(".", "")

    try:
        return ParsedNumber(float(s), True, raw, "")
    except Exception:
        return ParsedNumber(None, False, raw, "parse_error")


def parse_or_default(val: Any, default: float = 0.0) -> tuple[float, str, bool, str]:
    parsed = parse_number(val)
    if parsed.ok and parsed.value is not None:
        return parsed.value, parsed.raw, True, ""
    return default, parsed.raw, False, parsed.reason


def meta_oku(df_raw: pd.DataFrame) -> dict[str, Any]:
    cost_pax = None
    kur = None
    cost_pax_raw = ""
    kur_raw = ""

    limit = min(len(df_raw), 40)
    width = min(df_raw.shape[1], 8)
    for i in range(limit):
        for j in range(width):
            cell_norm = normalize_text(df_raw.iat[i, j])
            if not cell_norm:
                continue
            next_val = df_raw.iat[i, j + 1] if j + 1 < df_raw.shape[1] else None
            if cost_pax is None and cell_norm in {"cost pax", "costpax", "pax cost", "cost per pax"}:
                parsed = parse_number(next_val)
                cost_pax = parsed.value if parsed.ok else None
                cost_pax_raw = parsed.raw
            if kur is None and cell_norm in {"kur", "exchange rate", "doviz kuru", "döviz kuru"}:
                parsed = parse_number(next_val)
                kur = parsed.value if parsed.ok else None
                kur_raw = parsed.raw
        if cost_pax is not None and kur is not None:
            break

    return {
        "cost_pax": cost_pax,
        "kur": kur,
        "cost_pax_raw": cost_pax_raw,
        "kur_raw": kur_raw,
    }


def row_nonempty_count(row: pd.Series) -> int:
    return sum(1 for v in row.tolist() if normalize_text(v))


def detect_column_map(header_values: list[Any]) -> tuple[dict[str, int], list[str]]:
    column_map: dict[str, int] = {}
    matched_fields: list[str] = []
    for idx, value in enumerate(header_values):
        norm = normalize_text(value)
        if not norm:
            continue
        field = ALIAS_TO_FIELD.get(norm)
        if field and field not in column_map:
            column_map[field] = idx
            matched_fields.append(field)
            continue
        # contains/startswith fallback
        for alias_norm, alias_field in ALIAS_TO_FIELD.items():
            if alias_field in column_map:
                continue
            if norm == alias_norm or norm.startswith(alias_norm) or alias_norm in norm:
                column_map[alias_field] = idx
                matched_fields.append(alias_field)
                break
    return column_map, matched_fields


def sheet_name_score(sheet_name: str) -> int:
    norm = normalize_text(sheet_name)
    score = 0

    # Güçlü negatifler: bunlar çoğu zaman referans / eski veri sayfaları
    if "gecen yil" in norm or "gecenyil" in norm:
        score -= 80
    if "onceki yil" in norm or "oncekiyil" in norm:
        score -= 60
    if "gecen ay" in norm:
        score -= 25
    if "rapor" in norm:
        score -= 20
    if "ozet" in norm or "özet" in sheet_name.lower():
        score -= 10
    if "karsilastirma" in norm or "gramaj" in norm:
        score -= 10

    # Pozitifler: gerçek çalışma sayfası sinyalleri
    if "analiz" in norm:
        score += 35
    if "yiyecek" in norm or "icecek" in norm or "içecek" in sheet_name.lower():
        score += 20
    if "cost" in norm:
        score += 5

    # Tarih geçen sayfalar genelde gerçek dönem sayfalarıdır
    if re.search(r"\b(20\d{2}|ocak|subat|mart|nisan|mayis|haziran|temmuz|agustos|eylul|ekim|kasim|aralik)\b", norm):
        score += 8

    return score


def discover_best_sheet(xl: pd.ExcelFile) -> Optional[SheetCandidate]:
    candidates: list[SheetCandidate] = []
    for sheet_name in xl.sheet_names:
        try:
            df_raw = pd.read_excel(xl, sheet_name=sheet_name, header=None)
        except Exception:
            continue
        if df_raw.empty:
            continue

        name_bonus = sheet_name_score(sheet_name)
        max_scan_rows = min(len(df_raw), 40)
        best: Optional[SheetCandidate] = None
        for i in range(max_scan_rows):
            row = df_raw.iloc[i].tolist()
            column_map, matched_fields = detect_column_map(row)
            required_hits = sum(1 for x in REQUIRED_HEADER_FIELDS if x in column_map)
            nonempty_after = 0
            for j in range(i + 1, min(len(df_raw), i + 11)):
                if row_nonempty_count(df_raw.iloc[j]) >= 3:
                    nonempty_after += 1

            header_signal = len(matched_fields) * 10 + required_hits * 20 + nonempty_after
            if required_hits == 0 and len(matched_fields) < 2:
                continue

            meta = meta_oku(df_raw)
            meta_bonus = 0
            if meta.get("cost_pax") is not None:
                meta_bonus += 8
            if meta.get("kur") is not None:
                meta_bonus += 8

            score = header_signal + name_bonus + meta_bonus
            cand = SheetCandidate(sheet_name, i, column_map, score, matched_fields, nonempty_after)
            if best is None or cand.score > best.score:
                best = cand
        if best is not None:
            candidates.append(best)

    if not candidates:
        return None
    candidates.sort(key=lambda c: (c.score, len(c.matched_fields), c.sample_nonempty_rows), reverse=True)
    return candidates[0]


def _norm_tip(tip: str) -> str:
    return "icenek" if tip in ("icecek", "içeçek") else tip


def tutar_tl_from(tip: str, tuk: float, birim_fiyat: float) -> float:
    t = tuk or 0.0
    bf = birim_fiyat or 0.0
    t0 = _norm_tip(tip)
    if t0 == "yiyecek":
        return (t / 1000.0) * bf
    if t0 == "icenek":
        return t * bf
    return t * bf


def normalize_tuk_miktar_yiyecek_kg_to_gr(tuk: float, birim: str) -> float:
    b = normalize_text(birim).replace(" ", "")
    if "kilo" in b or b in ("kg", "kgs"):
        return tuk * 1000.0
    if ("gram" in b and "kilo" not in b) or b in ("gr", "g") or b.endswith("gr"):
        return tuk
    return tuk * 1000.0


def backfill_tuk_birim(tip: str, tuk: float, birim_fiyat: float, tutar_tl: float) -> tuple[float, float]:
    t = tuk or 0.0
    bf = birim_fiyat or 0.0
    tt = tutar_tl or 0.0
    t0 = _norm_tip(tip)
    if t:
        return t, bf
    if bf and tt:
        if t0 == "yiyecek":
            return (tt / bf) * 1000.0, bf
        if t0 == "icenek":
            return tt / bf, bf
    if tt and not t and not bf:
        if t0 == "yiyecek":
            return tt * 1000.0, 1.0
        if t0 == "icenek":
            return tt, 1.0
    return t, bf


def derive_tutar_pp(
    tip: str,
    tuk: float,
    birim_fiyat: float,
    kur: Optional[float],
    cost_pax: Optional[float],
) -> dict[str, float]:
    t0 = _norm_tip(tip)
    cp = cost_pax or 0.0
    k = kur or 0.0
    tt = tutar_tl_from(tip, tuk, birim_fiyat)
    te = (tt / k) if k else 0.0
    pp_tl = (tt / cp) if cp else 0.0
    pp_eur = (te / cp) if (cp and k) else 0.0
    pp_gr = (tuk / cp) if (t0 == "yiyecek" and cp) else 0.0
    pp_cl = ((tuk * 100.0) / cp) if (t0 == "icenek" and cp) else 0.0
    return {
        "tutar_tl": tt,
        "tutar_eur": te,
        "pp_tl": pp_tl,
        "pp_eur": pp_eur,
        "pp_gr": pp_gr,
        "pp_cl": pp_cl,
    }


def get_cell(row: pd.Series, idx: Optional[int]) -> Any:
    if idx is None:
        return None
    if idx < 0 or idx >= len(row):
        return None
    return row.iloc[idx]


def _pn_val(parsed_numeric: dict[str, ParsedNumber], key: str) -> float:
    p = parsed_numeric.get(key)
    if not p or p.value is None:
        return 0.0
    return float(p.value)


def grup_baslik_etiketi(stok_mali: str) -> str:
    sm = str(stok_mali).strip()
    m = re.match(r"^\d+\s*-\s*(.+)$", sm)
    if m:
        return m.group(1).strip()
    return sm


def is_group_header_row(stok_mali: str, stok_no_str: str, parsed_numeric: dict[str, ParsedNumber]) -> bool:
    if not stok_mali or not str(stok_mali).strip():
        return False
    sm = str(stok_mali).strip()
    sn = (stok_no_str or "").strip().lower()
    has_real_stok_no = bool(sn) and sn not in ("0", "nan")

    tutar = _pn_val(parsed_numeric, "tutar_tl")
    bf = _pn_val(parsed_numeric, "birim_fiyat")
    tuk = _pn_val(parsed_numeric, "tuk_miktar")

    if not has_real_stok_no and tutar == 0 and bf == 0 and re.match(r"^\d+\s*-\s", sm):
        return True

    has_amount = tutar != 0 or tuk != 0 or bf != 0
    if has_amount:
        return False
    if has_real_stok_no:
        return False
    starts_digit = bool(re.match(r"^\d", sm))
    looks_section = " - " in sm or bool(re.match(r"^\d{4,}", sm))
    return bool(starts_digit or looks_section)


def scan_footer_deductions(df_raw: pd.DataFrame, header_row: int, col_map: dict[str, int]) -> tuple[float, float]:
    fiyat_farki = 0.0
    odenmez = 0.0
    start_r = max(header_row + 1, len(df_raw) - 45)
    tut_idx = col_map.get("tutar_tl")
    st_idx = col_map.get("stok_mali")
    if tut_idx is None or st_idx is None:
        return 0.0, 0.0
    for i in range(start_r, len(df_raw)):
        row = df_raw.iloc[i]
        sm = get_cell(row, st_idx)
        nsm = normalize_text(sm)
        if not nsm:
            continue
        tut = parse_number(get_cell(row, tut_idx)).value or 0.0
        if "fiyat fark" in nsm:
            fiyat_farki += abs(float(tut))
        elif "odenmez" in nsm:
            odenmez += abs(float(tut))
    return fiyat_farki, odenmez


def kalite_kontrol(rows: list[dict[str, Any]], meta: dict[str, Any], candidate: Optional[SheetCandidate]) -> tuple[str, list[str]]:
    warnings_list: list[str] = []
    if candidate is None:
        return "REJECT", ["uygun sheet/header bulunamadı"]
    if not rows:
        return "REJECT", ["ürün satırı çıkarılamadı"]
    if meta.get("cost_pax") is None:
        warnings_list.append("cost_pax bulunamadı")
    if meta.get("kur") is None:
        warnings_list.append("kur bulunamadı")
    if candidate and "gecen yil" in normalize_text(candidate.sheet_name):
        warnings_list.append("GEÇEN YIL sheet seçildi; kontrol et")

    parse_fail_count = 0
    category_empty = 0
    no_pax_tutar = 0
    for r in rows:
        if not r.get("kategori") and not r.get("grup"):
            category_empty += 1
        if (r.get("tutar_tl") or 0) > 0 and not (r.get("cost_pax") or 0):
            no_pax_tutar += 1
        for f in NUMERIC_FIELDS:
            if not r.get(f"{f}_parse_ok", True) and r.get(f"{f}_raw", ""):
                parse_fail_count += 1

    if parse_fail_count > max(5, len(rows) * 0.2):
        warnings_list.append(f"yüksek parse hata sayısı: {parse_fail_count}")
    if category_empty > max(5, len(rows) * 0.3):
        warnings_list.append(f"kategori boş satır fazla: {category_empty}")
    if no_pax_tutar > max(5, len(rows) * 0.3):
        warnings_list.append(f"cost_pax yok iken tutar>0 satır sayısı yüksek: {no_pax_tutar}")

    status = "OK"
    if warnings_list:
        status = "WARNING"
    if len(rows) < 3:
        status = "REJECT"
        warnings_list.append("ürün satırı sayısı çok düşük")
    return status, warnings_list


def sheet_isle(
    df_raw: pd.DataFrame,
    tip: str,
    tarih: dict[str, Any],
    meta: dict[str, Any],
    dosya_adi: str,
    candidate: SheetCandidate,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    current_kategori = None
    rows: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []

    for i in range(candidate.header_row + 1, len(df_raw)):
        row = df_raw.iloc[i]
        stok_mali_raw = get_cell(row, candidate.column_map.get("stok_mali"))
        stok_no_raw = get_cell(row, candidate.column_map.get("stok_no"))
        birim_raw = get_cell(row, candidate.column_map.get("birim"))

        stok_mali = "" if stok_mali_raw is None or normalize_text(stok_mali_raw) == "" else str(stok_mali_raw).strip()
        stok_no_str = "" if stok_no_raw is None or normalize_text(stok_no_raw) == "" else str(stok_no_raw).strip()
        birim = "" if birim_raw is None or normalize_text(birim_raw) == "" else str(birim_raw).strip()

        raw_numeric_cells = {f: get_cell(row, candidate.column_map.get(f)) for f in NUMERIC_FIELDS}
        parsed_numeric = {f: parse_number(v) for f, v in raw_numeric_cells.items()}

        if not stok_mali:
            continue
        if any(skip.lower() in stok_mali.lower() for skip in SKIP_SATIRLAR):
            continue

        if is_group_header_row(stok_mali, stok_no_str, parsed_numeric):
            current_kategori = grup_baslik_etiketi(stok_mali)
            continue

        # satırı ürün olarak kabul etmek için minimum sinyal
        has_product_signal = bool(stok_no_str) or any((p.ok and (p.value or 0) != 0) for p in parsed_numeric.values()) or bool(birim)
        if not has_product_signal:
            continue

        parsed_out: dict[str, Any] = {}
        for f in NUMERIC_FIELDS:
            p = parsed_numeric[f]
            parsed_out[f] = p.value if p.ok and p.value is not None else 0.0
            parsed_out[f"{f}_raw"] = p.raw
            parsed_out[f"{f}_parse_ok"] = p.ok
            parsed_out[f"{f}_parse_reason"] = p.reason
            if (not p.ok) and p.raw:
                errors.append({
                    "dosya": dosya_adi,
                    "sheet": candidate.sheet_name,
                    "satir_no": i + 1,
                    "alan": f,
                    "ham_deger": p.raw,
                    "sebep": p.reason,
                    "stok_mali": stok_mali,
                    "stok_no": stok_no_str,
                })

        tuk0 = float(parsed_out.get("tuk_miktar") or 0)
        bf0 = float(parsed_out.get("birim_fiyat") or 0)
        tut0 = float(parsed_out.get("tutar_tl") or 0)
        if _norm_tip(tip) == "yiyecek":
            tuk0 = normalize_tuk_miktar_yiyecek_kg_to_gr(tuk0, birim)
        tuk0, bf0 = backfill_tuk_birim(tip, tuk0, bf0, tut0)
        d = derive_tutar_pp(tip, tuk0, bf0, meta.get("kur"), meta.get("cost_pax"))
        row_has_warning = any(not parsed_out.get(f"{f}_parse_ok", True) and parsed_out.get(f"{f}_raw", "") for f in NUMERIC_FIELDS)

        rows.append({
            "dosya": dosya_adi,
            "sheet": candidate.sheet_name,
            "header_row": candidate.header_row + 1,
            "tip": tip,
            "tarih_str": tarih["tarih_str"],
            "tarih_iso": tarih["tarih_iso"],
            "yil": tarih["yil"],
            "ay_no": tarih["ay_no"],
            "ay": tarih["ay"],
            "gun": tarih["gun"],
            "cost_pax": meta["cost_pax"],
            "kur": meta["kur"],
            "cost_pax_raw": meta.get("cost_pax_raw", ""),
            "kur_raw": meta.get("kur_raw", ""),
            "kategori": current_kategori,
            "grup": current_kategori or "",
            "stok_mali": stok_mali,
            "stok_no": stok_no_str,
            "birim": birim,
            **parsed_out,
            "tuk_miktar": tuk0,
            "birim_fiyat": bf0,
            "tutar_tl": round(d["tutar_tl"], 4),
            "tutar_eur": round(d["tutar_eur"], 4),
            "pp_tl": round(d["pp_tl"], 4),
            "pp_eur": round(d["pp_eur"], 4),
            "pp_gr": round(d["pp_gr"], 4),
            "pp_cl": round(d["pp_cl"], 4),
            "satir_warning": row_has_warning,
        })

    ff, od = scan_footer_deductions(df_raw, candidate.header_row, candidate.column_map)
    meta_kur = meta.get("kur")
    meta_pax = meta.get("cost_pax")
    tipn2 = _norm_tip(tip)
    for label, amt in (
        ("— Excel: Fiyat farkı düşümü —", ff),
        ("— Excel: Ödenmez toplamı düşümü —", od),
    ):
        if amt is None or float(amt) <= 0:
            continue
        amt_f = float(amt)
        if tipn2 == "yiyecek":
            tuk_d = -amt_f * 1000.0
            birim_d = "Gram"
        else:
            tuk_d = -amt_f
            birim_d = "Litre"
        d_adj = derive_tutar_pp(tip, tuk_d, 1.0, meta_kur, meta_pax)
        parsed_base: dict[str, Any] = {}
        for f in NUMERIC_FIELDS:
            parsed_base[f] = 0.0
            parsed_base[f"{f}_raw"] = ""
            parsed_base[f"{f}_parse_ok"] = True
            parsed_base[f"{f}_parse_reason"] = ""
        rows.append({
            "dosya": dosya_adi,
            "sheet": candidate.sheet_name,
            "header_row": candidate.header_row + 1,
            "tip": tip,
            "tarih_str": tarih["tarih_str"],
            "tarih_iso": tarih["tarih_iso"],
            "yil": tarih["yil"],
            "ay_no": tarih["ay_no"],
            "ay": tarih["ay"],
            "gun": tarih["gun"],
            "cost_pax": meta.get("cost_pax"),
            "kur": meta.get("kur"),
            "cost_pax_raw": meta.get("cost_pax_raw", ""),
            "kur_raw": meta.get("kur_raw", ""),
            "kategori": "",
            "grup": "",
            "stok_mali": label,
            "stok_no": "__DUZELTME__",
            "birim": birim_d,
            **parsed_base,
            "tuk_miktar": tuk_d,
            "birim_fiyat": 1.0,
            "tutar_tl": round(d_adj["tutar_tl"], 4),
            "tutar_eur": round(d_adj["tutar_eur"], 4),
            "pp_tl": round(d_adj["pp_tl"], 4),
            "pp_eur": round(d_adj["pp_eur"], 4),
            "pp_gr": round(d_adj["pp_gr"], 4),
            "pp_cl": round(d_adj["pp_cl"], 4),
            "satir_warning": False,
        })

    return rows, errors


def build_sheet_preview(df_raw: pd.DataFrame, candidate: Optional[SheetCandidate]) -> str:
    if candidate is None or candidate.header_row is None:
        return ""
    lines = []
    start = candidate.header_row
    end = min(len(df_raw), start + 4)
    for i in range(start, end):
        vals = []
        for v in df_raw.iloc[i].tolist()[:10]:
            txt = str(v).strip() if normalize_text(v) else ""
            vals.append(txt)
        lines.append(" | ".join(vals))
    return " || ".join(lines)


def dosya_isle(filepath: Path, tarih: dict[str, Any], kategori: str) -> tuple[list[dict[str, Any]], dict[str, Any], list[dict[str, Any]]]:
    report: dict[str, Any] = {
        "dosya": filepath.name,
        "dosya_yolu": str(filepath),
        "tip": kategori,
        "tarih_iso": tarih["tarih_iso"],
        "sheet_secildi": "",
        "header_row": "",
        "matched_fields": "",
        "column_map": "",
        "score": 0,
        "status": "REJECT",
        "warninglar": "",
        "satir_sayisi": 0,
        "cost_pax": None,
        "kur": None,
        "ornek_onizleme": "",
    }
    errors: list[dict[str, Any]] = []

    try:
        xl = pd.ExcelFile(filepath)
    except Exception as e:
        report["warninglar"] = f"excel açılamadı: {e}"
        return [], report, errors

    if not xl.sheet_names:
        report["warninglar"] = "sheet yok"
        return [], report, errors

    candidate = discover_best_sheet(xl)
    if candidate is None:
        report["warninglar"] = "uygun sheet/header bulunamadı"
        return [], report, errors

    try:
        df_raw = pd.read_excel(xl, sheet_name=candidate.sheet_name, header=None)
    except Exception as e:
        report["warninglar"] = f"sheet okunamadı: {candidate.sheet_name} -> {e}"
        return [], report, errors

    meta = meta_oku(df_raw)
    rows, errors = sheet_isle(df_raw, kategori, tarih, meta, filepath.name, candidate)
    status, warn_list = kalite_kontrol(rows, meta, candidate)

    report.update({
        "sheet_secildi": candidate.sheet_name,
        "header_row": candidate.header_row + 1 if candidate.header_row is not None else "",
        "matched_fields": ", ".join(candidate.matched_fields),
        "column_map": ", ".join(f"{k}:{v + 1}" for k, v in sorted(candidate.column_map.items(), key=lambda x: x[1])),
        "score": candidate.score,
        "status": status,
        "warninglar": " | ".join(warn_list),
        "satir_sayisi": len(rows),
        "cost_pax": meta.get("cost_pax"),
        "kur": meta.get("kur"),
        "ornek_onizleme": build_sheet_preview(df_raw, candidate),
    })

    if rows:
        print(
            f"  [{status}] {filepath.name[:70]}... | sheet={candidate.sheet_name} | "
            f"header={candidate.header_row + 1} | ürün={len(rows)} | Pax={meta.get('cost_pax')} | Kur={meta.get('kur')}"
        )
    else:
        print(f"  [{status}] {filepath.name[:70]}... | veri çıkarılamadı")

    return rows, report, errors


def yaz_kontrol_ciktilari(ana_klasor: Path, reports: list[dict[str, Any]], errors: list[dict[str, Any]]) -> None:
    report_df = pd.DataFrame(reports)
    report_csv = ana_klasor / "fb_kontrol_raporu.csv"
    report_df.to_csv(report_csv, index=False, encoding="utf-8-sig")

    error_csv = ana_klasor / "fb_hata_logu.csv"
    if errors:
        pd.DataFrame(errors).to_csv(error_csv, index=False, encoding="utf-8-sig")
    else:
        pd.DataFrame(columns=["dosya", "sheet", "satir_no", "alan", "ham_deger", "sebep", "stok_mali", "stok_no"]).to_csv(
            error_csv, index=False, encoding="utf-8-sig"
        )


def run_scan(ana_klasor: Path, cikti_adi: str = "fb_analiz.csv", dry_run: bool = False) -> int:
    if not ana_klasor.exists():
        print(f"HATA: Klasör bulunamadı: {ana_klasor}")
        return 1

    cari_yil, cari_ay = bulundugumuz_ay()
    print(f"\n[Voyage F&B Tarama — v3]")
    print(f"Klasör      : {ana_klasor}")
    print(f"Bugün       : {date.today()} (bu ay fallback: {cari_yil}-{cari_ay:02d})")
    print(f"Mod         : {'DRY RUN (liste + kontrol)' if dry_run else 'REAL (CSV + kontrol raporu)'}")
    print("-" * 80)

    secilenler, rapor = dosyalari_sec(ana_klasor)
    kabul = [r for r in rapor if r[0] == "KABUL"]
    atla = [r for r in rapor if r[0] == "ATLA"]
    dup = [r for r in rapor if r[0] == "DUPLICATE"]

    print(f"\n── SEÇİM RAPORU ──")
    print(f"  KABUL     : {len(kabul)}")
    print(f"  DUPLICATE : {len(dup)} (eşleniği tercih edildi)")
    print(f"  ATLA      : {len(atla)}")

    if len(secilenler) == 0:
        print("\n[!] Uygun dosya bulunamadı.")
        return 1

    if dry_run:
        print(f"\n── KABUL EDİLENLER ──")
        for _, f, msg in sorted(kabul, key=lambda x: str(x[1])):
            print(f"  [+] {msg}")
            print(f"      {f.relative_to(ana_klasor)}")
        if dup:
            print(f"\n── DUPLICATE (atlandı) ──")
            for _, f, msg in sorted(dup, key=lambda x: str(x[1])):
                print(f"  [~] {f.relative_to(ana_klasor)}")
                print(f"      → {msg}")
        if atla:
            print(f"\n── ATLANDI ──")
            for _, f, msg in sorted(atla, key=lambda x: str(x[1])):
                print(f"  [-] {f.relative_to(ana_klasor)}")
                print(f"      → {msg}")

    print(f"\n── EXCEL OKUMA / KONTROL ──")
    tum_satirlar: list[dict[str, Any]] = []
    kontrol_raporu: list[dict[str, Any]] = []
    tum_hatalar: list[dict[str, Any]] = []

    for f, tarih, kat in sorted(secilenler, key=lambda x: (x[1]["tarih_iso"], x[2], str(x[0]))):
        rows, report, errors = dosya_isle(f, tarih, kat)
        kontrol_raporu.append(report)
        tum_hatalar.extend(errors)
        if not dry_run:
            tum_satirlar.extend(rows)

    yaz_kontrol_ciktilari(ana_klasor, kontrol_raporu, tum_hatalar)

    if dry_run:
        print("\n[DRY RUN tamamlandı]")
        print(f"   Kontrol raporu : {ana_klasor / 'fb_kontrol_raporu.csv'}")
        print(f"   Hata logu      : {ana_klasor / 'fb_hata_logu.csv'}")
        return 0

    if not tum_satirlar:
        print("\n[!] Hiç veri çıkarılamadı.")
        return 1

    df = pd.DataFrame(tum_satirlar)
    sort_cols = [c for c in ["yil", "ay_no", "gun", "tip", "kategori", "stok_mali"] if c in df.columns]
    if sort_cols:
        df = df.sort_values(sort_cols).reset_index(drop=True)

    cikti = ana_klasor / cikti_adi
    df.to_csv(cikti, index=False, encoding="utf-8-sig")

    print(f"\n── TAMAMLANDI ──")
    print(f"   Toplam satır    : {len(df):,}")
    print(f"   Dönem sayısı    : {df['tarih_iso'].nunique() if 'tarih_iso' in df.columns else 0}")
    if 'tarih_iso' in df.columns:
        print(f"   Dönemler        : {sorted(df['tarih_iso'].dropna().unique())}")
    print(f"   Ana çıktı       : {cikti}")
    print(f"   Kontrol raporu  : {ana_klasor / 'fb_kontrol_raporu.csv'}")
    print(f"   Hata logu       : {ana_klasor / 'fb_hata_logu.csv'}")
    return 0
