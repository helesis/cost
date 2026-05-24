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
    r"\bkg\b",
    r"\blt\b",
    r"\bl\b",
    r"\bgr\b",
    r"\bg\b",
    r"\bml\b",
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


def extract_english_core(name: str) -> str:
    """«TÜRKÇe/ENGLISH» formatından İngilizce çekirdeği al."""
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
