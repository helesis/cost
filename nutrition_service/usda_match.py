"""USDA arama sonuçlarından rapidfuzz ile eşleştirme (token_set_ratio skoru)."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from rapidfuzz import fuzz

RAW_BOOST = 3
HAM_RAW_BOOST = 10

_HAM_DERIVATIVE_WORDS = frozenset(
    {
        "bread",
        "flour",
        "babyfood",
        "baby",
        "pancake",
        "juice",
        "dried",
        "dehydrated",
        "canned",
        "cooked",
        "fried",
        "pickled",
        "frozen",
        "sweetened",
        "concentrate",
        "powder",
        "snacks",
        "cookie",
        "cookies",
        "cracker",
        "crackers",
        "muffin",
        "cake",
        "pie",
        "babyfood",
        "beverage",
        "beverages",
        "infant",
        "formula",
        "pickle",
        "pickles",
    }
)

_USDA_SUFFIX_RE = re.compile(
    r",\s*(raw|peeled|cooked|frozen|dried|boiled|steamed|blanched)\s*$",
    re.I,
)

_GENERIC_PRIMARY = frozenset(
    {
        "oil",
        "oils",
        "flour",
        "milk",
        "cheese",
        "beans",
        "peas",
        "nuts",
        "seeds",
        "juice",
        "sauce",
        "soup",
        "bread",
        "fish",
        "meat",
        "lamb",
        "beef",
        "pork",
        "chicken",
        "turkey",
        "game",
        "snacks",
        "babyfood",
        "beverages",
        "beverage",
        "cookies",
        "pie",
        "toppings",
        "candies",
    }
)

_PROCESS_WORDS = frozenset(
    {
        "cookies",
        "cookie",
        "pie",
        "juice",
        "beverage",
        "beverages",
        "canned",
        "bottled",
        "frozen",
        "sweetened",
        "commercial",
        "commercially",
        "babyfood",
        "dessert",
        "bread",
        "muffin",
        "cake",
        "snacks",
        "chips",
        "candy",
        "syrup",
        "concentrate",
        "mix",
        "powder",
        "supplement",
        "wafer",
        "prepared",
        "pickles",
        "pickle",
        "refrigerated",
        "imported",
        "peel",
        "rind",
        "zest",
        "pulp",
        "kernels",
        "kernel",
        "seed",
        "seeds",
        "brains",
    }
)

_UNRELATED_SECOND_SEGMENT = frozenset(
    {
        "banana",
        "grass",
        "beef",
        "chicken",
        "turkey",
        "pork",
        "fish",
        "apple",
        "grape",
        "orange",
        "chocolate",
        "vanilla",
        "coffee",
        "tea",
        "wheat",
        "corn",
        "rice",
        "soy",
        "almond",
        "coconut",
    }
)

_NOISE_TOKENS = frozenset(
    {
        "raw",
        "peeled",
        "cooked",
        "frozen",
        "dried",
        "fresh",
        "whole",
        "without",
        "added",
        "vitamin",
        "and",
        "or",
        "the",
        "with",
        "from",
        "all",
        "types",
        "varieties",
    }
)


def normalize_usda_for_scoring(description: str) -> tuple[str, str]:
    """
    USDA adını skorlama için hafifçe normalize et.
    Virgül sonrası alt-tanımları tamamen atmaz; sondaki 'raw' vb. ekleri sadeleştirir.
    """
    d = (description or "").lower().strip()
    d = re.sub(r"\s+", " ", d)
    if not d:
        return "", ""

    full = _USDA_SUFFIX_RE.sub("", d).strip()
    primary = full.split(",", 1)[0].strip() if "," in full else full
    return full, primary


def _usda_compare_variants(description: str) -> list[str]:
    """USDA adının skorlanacak parçaları (Oil, sunflower → sunflower / oil sunflower)."""
    full, primary = normalize_usda_for_scoring(description)
    if not full:
        return []

    parts = [p.strip() for p in full.split(",") if p.strip()]
    variants: list[str] = []

    def add(value: str) -> None:
        value = re.sub(r"\s+", " ", (value or "").strip())
        if value and value not in variants:
            variants.append(value)

    add(full)
    if len(parts) >= 2:
        add(parts[1])
        add(f"{parts[0]} {parts[1]}")
        if len(parts) >= 3:
            add(" ".join(parts[:3]))
    if primary and primary not in _GENERIC_PRIMARY:
        add(primary)

    return variants


def _processing_penalty(query: str, description: str) -> int:
    q_words = set(re.findall(r"\w+", (query or "").lower()))
    d_words = set(re.findall(r"\w+", (description or "").lower()))
    penalty = 0
    for word in _PROCESS_WORDS:
        if word in d_words and word not in q_words:
            penalty += 10
    return min(penalty, 40)


def _extra_token_penalty(query: str, description: str) -> int:
    q_words = set(re.findall(r"\w+", (query or "").lower()))
    d_words = set(re.findall(r"\w+", (description or "").lower())) - _NOISE_TOKENS
    extras = {w for w in d_words if w not in q_words and not any(w in q or q in w for q in q_words)}
    return min(len(extras) * 4, 24)


@dataclass
class ScoredCandidate:
    fdc_id: int
    description: str
    data_type: str
    score: int
    raw: dict[str, Any] = field(repr=False, default_factory=dict)


def _compound_mismatch_penalty(query: str, description: str) -> int:
    """Lemon grass / melon banana gibi birleşik adlarda sorguda olmayan ikinci kelimeye ceza."""
    q = (query or "").lower().strip()
    tokens = [t for t in re.split(r"\s+", q) if t]
    if not tokens:
        return 0

    full, primary = normalize_usda_for_scoring(description)
    parts = [p.strip() for p in full.split(",") if p.strip()]
    if not parts:
        return 0

    lead_segment = parts[1] if primary in _GENERIC_PRIMARY and len(parts) >= 2 else parts[0]
    lead_words = [w for w in re.split(r"\W+", lead_segment) if w and w not in _NOISE_TOKENS]

    if len(lead_words) >= 2:
        for word in lead_words[1:]:
            if word in _PROCESS_WORDS or word in _NOISE_TOKENS:
                continue
            if any(word.startswith(t) or t.startswith(word.rstrip("s")) for t in tokens):
                continue
            if word in q:
                continue
            return 15

    if len(parts) >= 2:
        second_words = [w for w in re.split(r"\W+", parts[1]) if w and w not in _NOISE_TOKENS]
        if second_words and second_words[0] in _UNRELATED_SECOND_SEGMENT:
            if not any(
                second_words[0].startswith(t) or t.startswith(second_words[0].rstrip("s"))
                for t in tokens
            ):
                return 15
    return 0


def _leading_word_boost(query: str, description: str) -> int:
    """USDA adının önde gelen gıda kökü sorguyla uyumluysa küçük bonus."""
    tokens = [t for t in re.split(r"\s+", (query or "").lower().strip()) if t]
    if not tokens:
        return 0

    full, primary = normalize_usda_for_scoring(description)
    parts = [p.strip() for p in full.split(",") if p.strip()]
    if not parts:
        return 0

    lead_segment = parts[1] if primary in _GENERIC_PRIMARY and len(parts) >= 2 else parts[0]
    lead_words = [w for w in re.split(r"\W+", lead_segment) if w and w not in _NOISE_TOKENS]
    if not lead_words:
        return 0

    first_word = lead_words[0]
    for token in tokens:
        if first_word.startswith(token) or token.startswith(first_word.rstrip("s")):
            return 5
    return 0


def _ham_derivative_penalty(query: str, description: str) -> int:
    """Ham gıda aramasında un/ekmek/babyfood/dehydrated gibi türevlere ek ceza."""
    q_words = set(re.findall(r"\w+", (query or "").lower()))
    d_words = set(re.findall(r"\w+", (description or "").lower()))
    d_lower = (description or "").lower()
    penalty = 0
    for word in _HAM_DERIVATIVE_WORDS:
        if word in d_words and word not in q_words:
            penalty += 18
    for mark in ("dehydrated", "dried", "freeze", "frozen", "cooked", "fried", "canned", "pickled"):
        if mark in d_lower and mark not in (query or "").lower():
            penalty += 16
    _, primary = normalize_usda_for_scoring(description)
    if primary in _HAM_DERIVATIVE_WORDS and primary not in q_words:
        penalty += 22
    return min(penalty, 72)


def fuzzy_match_score(
    query: str,
    description: str,
    data_type: str = "",
    *,
    ham_food_mode: bool = False,
) -> int:
    """
    token_set_ratio (0–100): kelime sırası / fazla-eksik kelimeye toleranslı.
    USDA virgül formatı ve işlenmiş gıda adları için ek normalizasyon/ceza uygular.
    """
    q = (query or "").lower().strip()
    if not q:
        return 0

    variants = _usda_compare_variants(description)
    if not variants:
        return 0

    desc_lower = (description or "").lower().strip()
    score = max(int(fuzz.token_set_ratio(q, variant)) for variant in variants)

    if ham_food_mode:
        score -= _ham_derivative_penalty(q, desc_lower)
        score -= _processing_penalty(q, desc_lower)
        score -= _extra_token_penalty(q, desc_lower)
        score -= _compound_mismatch_penalty(q, desc_lower)
        score += _leading_word_boost(q, desc_lower)
        if "raw" in desc_lower:
            score = min(100, score + HAM_RAW_BOOST)
    else:
        score -= _processing_penalty(q, desc_lower)
        score -= _extra_token_penalty(q, desc_lower)
        score -= _compound_mismatch_penalty(q, desc_lower)
        score += _leading_word_boost(q, desc_lower)
        if "raw" in desc_lower:
            score = min(100, score + RAW_BOOST)

    if data_type and "branded" in data_type.lower():
        score = max(0, score - 5)

    return max(0, min(100, score))


# Geriye dönük isim
fuzzy_token_sort_score = fuzzy_match_score


def rank_usda_foods(
    query: str,
    foods: list[dict[str, Any]],
    *,
    top_n: int = 25,
    ham_food_mode: bool = False,
) -> list[ScoredCandidate]:
    scored: list[ScoredCandidate] = []
    seen: set[int] = set()

    for f in foods or []:
        fid = f.get("fdcId")
        if fid is None:
            continue
        fid = int(fid)
        if fid in seen:
            continue
        seen.add(fid)

        desc = f.get("description") or ""
        dtype = f.get("dataType") or ""
        sc = fuzzy_match_score(query, desc, dtype, ham_food_mode=ham_food_mode)
        scored.append(
            ScoredCandidate(
                fdc_id=fid,
                description=desc,
                data_type=dtype,
                score=sc,
                raw=f,
            )
        )

    scored.sort(key=lambda c: (-c.score, c.description))
    return scored[:top_n]


def decide_match_status(*, fuzzy_score: int | None, llm_approved: bool | None) -> str:
    """
    İki kapılı karar:
    - rapidfuzz ≥ 85 VE LLM EVET → otomatik
    - LLM EVET ve 60 ≤ rapidfuzz < 85 → kontrol_gerekli
    - LLM HAYIR ama rapidfuzz ≥ 85 → kontrol_gerekli (manuel inceleme)
    - Diğer → eslesmedi
    """
    sc = int(fuzzy_score or 0)
    if llm_approved is True:
        if sc >= 85:
            return "otomatik"
        if sc >= 60:
            return "kontrol_gerekli"
        return "eslesmedi"
    if llm_approved is False and sc >= 85:
        return "kontrol_gerekli"
    return "eslesmedi"


def llm_onay_label(approved: bool | None) -> str:
    if approved is True:
        return "EVET"
    if approved is False:
        return "HAYIR"
    return "—"


def alternatives_json(candidates: list[ScoredCandidate], *, skip_first: bool = False) -> list[dict]:
    items = candidates[1:] if skip_first else candidates
    out = []
    for c in items[:3]:
        out.append(
            {
                "fdcId": c.fdc_id,
                "description": c.description,
                "dataType": c.data_type,
                "guven_skoru": c.score,
            }
        )
    return out
