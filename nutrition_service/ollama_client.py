"""Ollama LLM — USDA arama terimi çevirisi ve anlamsal doğrulama."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass

import httpx

from nutrition_service.name_clean import extract_english_core, preprocess_turkish_stok_name

_DEFAULT_URL = "http://127.0.0.1:11434/api/generate"
_OLLAMA_URL = (os.environ.get("OLLAMA_URL") or _DEFAULT_URL).strip()
_OLLAMA_MODEL = (os.environ.get("OLLAMA_USDA_MODEL") or os.environ.get("OLLAMA_MODEL") or "qwen2.5:32b").strip()
_OLLAMA_TIMEOUT = float(os.environ.get("OLLAMA_TIMEOUT_SEC", "180"))

_TRANSLATE_SYSTEM = """Sen bir otel F&B (yiyecek-içecek) stok ve USDA FoodData Central uzmanısın.
Görevin: Türkçe/İngilizce karışık stok kalemini USDA araması için kısa İngilizce terime çevirmek ve kategorisini belirlemek.

Kategori:
- ham = çiğ kullanılan sebze/meyve, çiğ et parçası, çiğ kümes / balık (mutfak cesedi); yumurta.
- ÖNEMLİ — İŞLEMİŞ süt ürünleri asla ham değildir:
  süt, yoğurt, peynir, ayran, kaymak, krema, tereyağı, labne vb. → her zaman **KATEGORI: islenmis**
  USDA'da: Milk/yogurt/cheese/butter ifadeleri kullanılır; arama için "raw milk" yazma.
- islenmis = un, sıvı/bitki yağı, şeker, salça, konserve, kurutulmuş/pratik ürün, hazır bileşik, baharat vb.

Bağlam (kısaltmalar):
- Kesim / et: ANTİRKOT=Rib/Ribeye/rib primal · BONFILE / FLETO = tenderloin ya da poultry'de breast meat · BUT = lamb/pork için leg primal (but=leg)· ÇATAL BUT = lamb leg şekilli · İNCİK/KEMİK kemikli bacak için shank
- Kuşbaşı = stew cubes / diced meat · KAFES/carcass = whole bird carcass
- Balık: ÇİPURA=sea bream · MEZGİT=whiting veya atlantik bağlamda Haddock yakınları · LEVREK=European sea bass · SOMON=salmon
- FLETO / FILETO deniz ürünü veya kümes ise fillet; ette loin için de kullanılır.
- Türk mutfağı: LAVAŞ=lavash (flatbread) — "bread lava" ASLA yaz, her zaman lavash bread / lavash wrap.
- Börek (=fillo/phyllo börek), su böreği, sigara böreği için generic / US'da yakın kayıt yoksa doğru yaklaşım yine de mantıklı İngilizce (phyllo cheese pastry vb.); USDA'da yoksa bile abartılı uydurma yapma.

Diğer:
- "BEEF" domates kaleminde beefsteak tomato (et değil); AYÇİÇEK YAĞ = sunflower oil; UN = wheat flour

Kurallar:
- TERIM: 1–6 kelime sade İngilizce (raw/search ipucu EKLEME — ham gıdalarda bile sen eklemezsin; tereyağı/süt/yoğurt için özellikle raw kullanma)
- KATEGORI: ham (yalnızca sebze/meyve/çiğ et parçası/çiğ kümes cesedi/ çiğ balık için) VEYA islenmis (işlenmiş süt, yağlar, işlenmiş gıda)
- Gıda değilse: NON_FOOD

Yanıt formatı (tam iki satır, başka metin yok):
TERIM: <english term>
KATEGORI: ham|islenmis"""

_VERIFY_SYSTEM = """Sen gıda eşleştirme denetçisisin.
Verilen Türkçe otel stok kalemi ile USDA (ABD gıda veritabanı) ürün adının AYNI temel gıda olup olmadığını değerlendir.
Yanıtına yalnızca tek kelimeyle başla: EVET veya HAYIR. Sonra istersen kısa açıklama ekle.
Aynı gıda değilse (ör. yumurta vs böğürtlen) HAYIR ile başla."""


def _generate(prompt: str, *, system: str, temperature: float = 0.1) -> str | None:
    """Ollama /api/generate; hata/timeout → None (fail-safe)."""
    url = _OLLAMA_URL
    if "/api/" not in url:
        url = url.rstrip("/") + "/api/generate"

    body = {
        "model": _OLLAMA_MODEL,
        "prompt": prompt,
        "system": system,
        "stream": False,
        "options": {"temperature": temperature, "num_predict": 64},
    }
    try:
        with httpx.Client(timeout=_OLLAMA_TIMEOUT) as client:
            r = client.post(url, json=body)
            r.raise_for_status()
            data = r.json()
            text = (data.get("response") or "").strip()
            return text if text else None
    except Exception:
        return None


def _first_line(text: str) -> str:
    line = (text or "").strip().splitlines()[0].strip()
    line = re.sub(r"^[`\"']+|[`\"']+$", "", line)
    line = re.sub(r"^(answer|translation|term)\s*:\s*", "", line, flags=re.I)
    return line.strip()


_DAIRY_FORCE_ISLENMIS = re.compile(
    r"(?iu)\b(?:"
    r"s[uü]t\b|sut\b|yo[gğ]urt\b|yoğurt\b|peyn[iıİI]r\w*|peyn[Iİ]|"
    r"tereya[gğ]\w*|ayran\b|kaymak\b|krema\b|labne\w*|"
    r"çökelek\b|milks?\b|yogh?urts?\b|\bbuttermilk\b|cottage\b|"
    r"butters?\b|creams?\b|cheeses?\b|(?:ka[sş]ar)\w*|tulum\b|\blor\b|"
    r"sade\s+s[uü]t\b"
    r")\b",
)

_ISLENMIS_HINT_RE = re.compile(
    r"\b("
    r"flour|un|oil|yağ|yag|sugar|şeker|seker|powder|toz|paste|salça|salca|sauce|"
    r"syrup|vinegar|sirke|concentrate|extract|seasoning|butter|margarine|shortening|"
    r"starch|nişasta|nisasta|cornmeal|semolina|baking|yeast|maya|salt|tuz|spice|"
    r"baharat|bouillon|stock\s+cube|sunflower\s+oil|olive\s+oil|canola"
    r")\b",
    re.I,
)
_TERM_LINE_RE = re.compile(r"(?:TERIM|TERM|TERİM|translation)\s*:\s*(.+)", re.I)
_KAT_LINE_RE = re.compile(r"KATEGORI\s*:\s*(ham|islenmis|işlenmiş|islenmiş)", re.I)


@dataclass
class FoodSearchTranslation:
    term: str
    kategori: str  # ham | islenmis


def _normalize_kategori(raw: str | None, term: str, urun_adi: str) -> str:
    blob = f"{term} {urun_adi}"
    blob_l = blob.lower()
    # İşlenmiş süt — LLM yanlış "ham+raw süt" vermesini engelle
    if _DAIRY_FORCE_ISLENMIS.search(blob):
        return "islenmis"

    k = (raw or "").lower().strip()
    k = k.replace("işlenmiş", "islenmis").replace("islenmiş", "islenmis")
    if k in ("ham", "islenmis"):
        return k
    if _ISLENMIS_HINT_RE.search(blob_l):
        return "islenmis"
    return "ham"


def _parse_translate_response(text: str, urun_adi: str) -> FoodSearchTranslation | None:
    lines = [ln.strip() for ln in (text or "").splitlines() if ln.strip()]
    term = ""
    kategori_raw = None

    for ln in lines:
        m_t = _TERM_LINE_RE.match(ln)
        if m_t:
            term = m_t.group(1).strip()
            continue
        m_k = _KAT_LINE_RE.match(ln)
        if m_k:
            kategori_raw = m_k.group(1).strip()
            continue

    if not term and lines:
        first = _first_line(lines[0])
        if first.upper() not in ("NON_FOOD", "NON-FOOD", "N/A", "NA"):
            term = first
        for ln in lines[1:]:
            m_k = _KAT_LINE_RE.match(ln)
            if m_k:
                kategori_raw = m_k.group(1).strip()

    term = re.sub(r"[^\w\s\-,()/]", " ", term)
    term = re.sub(r"\s+", " ", term).strip()
    if not term or len(term) > 120:
        return None
    if term.upper() in ("NON_FOOD", "NON-FOOD", "N/A", "NA"):
        return None

    kategori = _normalize_kategori(kategori_raw, term, urun_adi)
    return FoodSearchTranslation(term=term, kategori=kategori)


def build_usda_search_query(term: str, kategori: str, *, meat_fish_no_raw: bool = False) -> str:
    """
    Ham gıdada USDA aramasına çoğu üründe 'raw' eklenir (USDA SR Legacy uyumu).
    Et/balık için 'raw' sorguya eklenmez (yanlış sıralama); işlenmiş süt/yağ hep ham değildir kategori tarafından.
    """
    t = (term or "").strip()
    if not t:
        return t
    if meat_fish_no_raw:
        return t
    if kategori == "ham" and "raw" not in t.lower().split():
        return f"{t} raw"
    return t


def translate_food_search(urun_adi: str) -> FoodSearchTranslation | None:
    """
    Türkçe stok adı → USDA arama terimi + kategori (ham/islenmis).
    Başarısızlıkta None.
    """
    raw_in = (urun_adi or "").strip()
    if not raw_in:
        return None

    raw = preprocess_turkish_stok_name(raw_in) or raw_in
    hint = extract_english_core(raw_in)
    if hint == raw_in and raw != raw_in:
        hint = extract_english_core(raw)

    hint_part = f'\nİpucu (varsa İngilizce parça): "{hint}"' if hint and hint != raw else ""

    prompt = f"""Stok kalemi: "{raw}"{hint_part}

TERIM ve KATEGORI (ham/islenmis):"""

    out = _generate(prompt, system=_TRANSLATE_SYSTEM, temperature=0.1)
    if not out:
        return None

    if out.strip().upper().startswith("NON_FOOD") or _first_line(out).upper() in ("NON_FOOD", "NON-FOOD"):
        return None

    return _parse_translate_response(out, raw_in)


def translate_food_search_term(urun_adi: str) -> str | None:
    """Geriye dönük: yalnızca arama terimi."""
    tr = translate_food_search(urun_adi)
    return tr.term if tr else None


_NEGATIVE_RE = re.compile(
    r"\b(hay[iı]r|hayir|degil|değil|farkl[iı]|farkli|no|not)\b",
    re.I,
)
_POSITIVE_RE = re.compile(
    r"\b(evet|yes)\b|\b(?:ayn[iı]\s+(?:g[iı]da|temel|ürün|urun)|same\s+food|the\s+same)\b|\b(?:ayn[iı]d[iı]r|ayn[iı])\b",
    re.I,
)
_UNCERTAIN_RE = re.compile(r"\b(belki|san[iı]r|muhtemelen|karars[iı]z|perhaps|maybe)\b", re.I)


def _parse_llm_yes_no(text: str) -> bool | None:
    """
    LLM yanıtından EVET/HAYIR çıkar.
    Olumsuzlamaya öncelik ver; tam satır eşleşmesi şart değil.
    """
    ans = (text or "").strip()
    if not ans:
        return None

    first = re.split(r"[\s,.:;!?]+", ans, maxsplit=1)[0].upper()
    if first in ("EVET", "YES"):
        return True
    if first in ("HAYIR", "NO"):
        return False

    lower = ans.lower()
    has_neg = bool(_NEGATIVE_RE.search(lower))
    has_pos = bool(_POSITIVE_RE.search(lower))

    if has_neg:
        return False
    if _UNCERTAIN_RE.search(lower) and not re.search(r"\b(evet|yes)\b", lower, re.I):
        return None
    if has_pos:
        return True
    return None


def verify_same_food(urun_adi: str, usda_adi: str) -> bool | None:
    """
    LLM anlamsal onay. True=EVET, False=HAYIR, None=timeout/hata (fail-safe).
    """
    if not (urun_adi or "").strip() or not (usda_adi or "").strip():
        return None

    prompt = f"""Türkçe stok kalemi: "{urun_adi.strip()}"
USDA ürün adı: "{usda_adi.strip()}"

Aynı temel gıda mı?
Yanıtına yalnızca tek kelimeyle başla: EVET veya HAYIR. Sonra istersen kısa açıklama ekle."""

    out = _generate(prompt, system=_VERIFY_SYSTEM, temperature=0.0)
    if not out:
        return None

    return _parse_llm_yes_no(out)
