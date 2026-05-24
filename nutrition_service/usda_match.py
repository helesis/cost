"""USDA arama sonuçlarından rapidfuzz ile eşleştirme (gerçek token_sort_ratio skoru)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from rapidfuzz import fuzz

RAW_BOOST = 3


@dataclass
class ScoredCandidate:
    fdc_id: int
    description: str
    data_type: str
    score: int
    raw: dict[str, Any] = field(repr=False, default_factory=dict)


def fuzzy_token_sort_score(query: str, description: str, data_type: str = "") -> int:
    """
    Gerçek matematiksel skor: token_sort_ratio (0–100).
    Sabit/uydurma skor yok. 'raw' içeren adaylara hafif kaydırma.
    """
    q = (query or "").lower().strip()
    d = (description or "").lower().strip()
    if not q or not d:
        return 0

    score = int(fuzz.token_sort_ratio(q, d))

    if "raw" in d:
        score = min(100, score + RAW_BOOST)

    if data_type and "branded" in data_type.lower():
        score = max(0, score - 5)

    return score


def rank_usda_foods(
    query: str,
    foods: list[dict[str, Any]],
    *,
    top_n: int = 5,
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
        sc = fuzzy_token_sort_score(query, desc, dtype)
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
    - LLM HAYIR VEYA rapidfuzz < 60 VEYA LLM yanıt yok → eslesmedi
    """
    sc = int(fuzzy_score or 0)
    if llm_approved is not True:
        return "eslesmedi"
    if sc >= 85:
        return "otomatik"
    if sc >= 60:
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
