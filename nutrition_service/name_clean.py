"""Hammadde adından USDA arama terimi çıkarımı."""

from __future__ import annotations

import re

# Tedarikçi / ambalaj / ithalat gürültüsü (case-insensitive)
_NOISE_PATTERNS = [
    r"\bsoklu\b",
    r"\bithal\b",
    r"\bimported\b",
    r"\bfor juice\b",
    r"\bfor cooking\b",
    r"\bfrozen\b",
    r"\bdiced\b",
    r"\bsliced\b",
    r"\bwhole\b",
    r"\bpack\b",
    r"\bpkg\b",
    r"\bx\b",
    r"\(\s*\d+\s*\)",
]
_NOISE_RE = re.compile("|".join(_NOISE_PATTERNS), re.IGNORECASE)
_DIM_RE = re.compile(
    r"\b\d+\s*[x×]\s*\d+\b|\b\d+[\.,]?\d*\s*(kg|g|gr|lt|l|ml|cl|adet|pcs|pc)\b",
    re.IGNORECASE,
)
_PARENS_RE = re.compile(r"\([^)]*\)")
_MULTI_SPACE = re.compile(r"\s+")

# Tedarikçi kodları: 10-1, 1-5, 3-4, 02-07 vb. (tire ya da slash)
_SUPPLIER_NUM_DASH = re.compile(r"\b\d{1,3}\s*[-–\/]\s*\d{1,4}\b", re.IGNORECASE)

_ROMAN_KALITE = re.compile(
    r"\b(?:I{1,3}|IV|V|VI{0,3}|IX|X{1,3})\s*\.?\s*(?:kalite|KALİTE|KALITE)\b"
    r"|(?:^|\s)(?:kalite|KALİTE|KALITE)\s*\.?\s*(?:I{1,3}|IV|VI{0,3}|IX|X{1,3})(?=\s|$)",
    re.IGNORECASE,
)

_BEŞLI_SET = re.compile(
    r"\b(?:BESLI|BEŞLİ|beşli|besli)\s+SET\b|\b\d{1,2}\s+[Ll]\s+[Ss]ET\b|\b(?:SET|TAKIM)\s+"
    r"(?:OF|ÖF|ÖFÜ)?\s*\d{1,3}\b",
    re.IGNORECASE,
)

_DOKME = re.compile(r"\bDÖKME\b|\bDOKME\b", re.IGNORECASE)

_LT_KG_STANDALONE = re.compile(
    r"\d+[\.,]?\d*\s*(?:LT|lt|Kg|KG|kg|Kg\.|Lt\.|GR|GR\.|Gr|gr)\b|\b(?:LT|lt)\s*\d",
    re.IGNORECASE,
)
_PACK_ABBREV = re.compile(r"\b(?:LT|Kg|KG|kg|GR|Gr|Lt)\b(?![A-Za-zğüşıöçĞÜŞİÖÇ])", re.IGNORECASE)

# Et / kümes / balık — arama stratejisi (DOMATES beef … ayrıca elenir)
_MEAT_OR_FISH_RE = re.compile(
    r"(?ix)\b(?:"
    r"dana|kuzu|sigir|sığır|s[iı]ğ[iı]r|tavuk|pilic|piliç|pili[cç]|hindi"
    r"|ordek|ördek|keci|keçi|koyun"
    r"|beef|veal|\blamb\b|\bmutton\b|\bpork\b|\bgoat\b|chicken|turkey|duck|quail"
    r"|\bgiblets?\b|\boffal\b|\b(?:liver|kidney|tripe)\b"
    r"|\b(?:drum)?sticks?\b|\bwings?\b|\bbreasts?\b|\bthighs?\b"
    r"|\bribs?\b|\b(?:rib\s*eyes?)\b|\bsirloin\b|\bloin\b|\btenderloin\b|\bbrisket\b|\bshank\b|\bcutlets?\b"
    r"|\bcarcass(?:es)?\b|\broast\b"
    r"|\bbenfile\b|\bbon\s*f[iı]l[eé]\w*\b|\bbonfil\w*|\bantrikot\b"
    r"|(?:çatal|catal)\s+but\b|ku[sş]ba[sşıı]\w*|\bku[sş]\s*ba[sş][iı]\w*"
    r"|\bstew\s+meat\b|\bcubes?\b|\bground\s+(?:beef|lamb|turkey|chicken|pork)\b|\bmince\b"
    r"|\bk[iı]ym\w*\b"
    r"|\bfish\b|\bseafood\b|\bmezgit\b|(?:ç|c)ipura|levrek|hamsi|somon"
    r"|\b(?:tunas?|cods?|haddock|whiting|salmon|trout|mackerel)s?\b"
    r"|\b(?:shrimp|crab|squid)s?\b|\b(?:sea\s*bass|sea\s*bream)\b|\bfillets?\b"
    r")\b"
)


def extract_english_core(name: str) -> str:
    """«TÜRKÇe/İngilizce» formatından İngilizce çekirdeği al."""
    raw = (name or "").strip()
    if not raw:
        return ""

    parts = re.split(r"\s*[/|\\|\u2013\u2014\-]\s*", raw, maxsplit=1)
    if len(parts) == 2:
        left, right = parts[0].strip(), parts[1].strip()
        if _latin_ratio(right) >= _latin_ratio(left):
            return right
        return right or left

    return raw


def _latin_ratio(s: str) -> float:
    if not s:
        return 0.0
    latin = sum(1 for c in s if ("A" <= c <= "Z") or ("a" <= c <= "z"))
    return latin / max(len(s), 1)


def preprocess_turkish_stok_name(name: str) -> str:
    """
    LLM'e gitmeden önce tedarikçi kodları, paket kalite etiketi ve ölçü gürültüsünü çıkarır.
    Orijinal stok kimliği (DB) için değil — yalnızca çeviri/arama için.
    """
    t = (name or "").strip()
    if not t:
        return ""

    # Parantez içi çoğu kod / lot
    t = _PARENS_RE.sub(" ", t)
    # II KALİTE, kalite IV
    t = _ROMAN_KALITE.sub(" ", t)
    t = _BEŞLI_SET.sub(" ", t)
    t = _DOKME.sub(" ", t)
    t = _SUPPLIER_NUM_DASH.sub(" ", t)

    t_norm = _DIM_RE.sub(" ", t)
    t_norm = _LT_KG_STANDALONE.sub(" ", t_norm)
    t_norm = _PACK_ABBREV.sub(" ", t_norm)
    t_norm = _NOISE_RE.sub(" ", t_norm)
    # Unicode kelimeler için \w kullanır
    t_norm = re.sub(r"[^\w\s\-]", " ", t_norm, flags=re.UNICODE)
    return _MULTI_SPACE.sub(" ", t_norm).strip()


def blob_is_meat_or_fish(*parts: str) -> bool:
    """Türkçe stok adı ve (varsa) LLM çıktısı üzerinden et/balık stratejisini seç."""
    blob = _MULTI_SPACE.sub(" ", " ".join((p or "") for p in parts if p).strip()).lower()
    # Domates/beef steak — et değil, sebze varyantı
    if ("domates" in blob or "tomato" in blob) and re.search(
        r"\b(beef(?:steak)?|dana|\bsirloin\b|\bribs?\b)", blob, re.I
    ):
        return False

    return bool(_MEAT_OR_FISH_RE.search(blob))


def clean_search_term(urun_adi: str, *, prefer_raw: bool = True) -> str:
    """
    USDA /foods/search sorgusu için temiz İngilizce terim.
    Sayılar, ebat ve marka gürültüsünü düşürür; ham madde için 'raw' ekler.
    """
    core = extract_english_core(urun_adi)
    t = core.upper()
    t = _PARENS_RE.sub(" ", t)
    t = _DIM_RE.sub(" ", t)
    t = _NOISE_RE.sub(" ", t)
    t = re.sub(r"[^\w\s]", " ", t, flags=re.UNICODE)
    t = _MULTI_SPACE.sub(" ", t).strip()

    # Tek kelime kalmışsa ve zaten raw içermiyorsa ekleme
    words = t.split()
    if not words:
        return ""

    lower = t.lower()
    if prefer_raw and "raw" not in lower.split():
        # Çok kısa veya genel terimlerde raw ekle (USDA SR Legacy uyumu)
        if len(words) <= 4:
            t = f"{t} raw"

    return _MULTI_SPACE.sub(" ", t).strip()
