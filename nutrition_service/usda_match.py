"""USDA arama sonuçlarından rapidfuzz ile eşleştirme."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from rapidfuzz import fuzz

RAW_BOOST = 5
BRANDED_PENALTY = 8


@dataclass
class ScoredCandidate:
    fdc_id: int
    description: str
    data_type: str
    score: int
    raw: dict[str, Any] = field(repr=False, default_factory=dict)


def score_description(query: str, description: str, data_type: str = "") -> int:
    q = (query or "").lower().strip()
    d = (description or "").lower().strip()
    if not q or not d:
        return 0

    base = max(
        fuzz.token_set_ratio(q, d),
        fuzz.partial_ratio(q, d),
        fuzz.WRatio(q, d),
    )
    score = int(base)

    if "raw" in d and "raw" in q:
        score = min(100, score + RAW_BOOST)
    elif "raw" in d:
        score = min(100, score + RAW_BOOST // 2)

    if data_type and "branded" in data_type.lower():
        score = max(0, score - BRANDED_PENALTY)

    # İşlenmiş / hazır ürün cezası
    for bad in ("canned", "frozen meal", "prepared", "restaurant"):
        if bad in d:
            score = max(0, score - 4)

    return min(100, score)


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
        sc = score_description(query, desc, dtype)
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


def classify_match(best: ScoredCandidate | None) -> tuple[str, int | None]:
    """
    Güven skoru ve eslesme_durumu.
    ≥85 otomatik, 60–84 kontrol_gerekli, <60 eslesmedi.
    """
    if best is None or best.score < 60:
        return "eslesmedi", best.score if best else None
    if best.score >= 85:
        return "otomatik", best.score
    return "kontrol_gerekli", best.score


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
