"""
Compound dump (tb_inglist / tb_nutvalue) ile otomatik USDA eşleştirme fallback.

`fb_cost.ingredient_compound_legacy` boşsa veya uygun bes_name satırı yoksa işlem no-op döner.

İçe aktarma için:
  python -m nutrition_service.import_compound_legacy --sql-file=.../1779714761656_compounds.sql
"""

from __future__ import annotations

import os

from nutrition_service import db
from nutrition_service.usda_client import foods_search_sync
from nutrition_service.usda_match import decide_match_status, rank_usda_foods

try:
    from rapidfuzz import fuzz
except ImportError:
    fuzz = None  # type: ignore[misc, assignment]


_CACHE_ROWS: list[dict] | None = None

_DEFAULT_COMPOUND_NAME_MIN_SCORE = int(os.environ.get("COMPOUND_LEGACY_NAME_SCORE_MIN", "74"))


def invalidate_cache():
    global _CACHE_ROWS
    _CACHE_ROWS = None


def get_compound_legacy_rows(force_reload: bool = False) -> list[dict]:
    global _CACHE_ROWS
    if force_reload:
        _CACHE_ROWS = None
    if _CACHE_ROWS is None:
        _CACHE_ROWS = db.fetch_all(
            """
            SELECT ing_no,
                   trim(ing_name) AS ing_name,
                   trim(bes_name) AS bes_name,
                   nut_no,
                   protein,
                   carboh,
                   energy_legacy,
                   water_legacy
            FROM fb_cost.ingredient_compound_legacy
            WHERE bes_name IS NOT NULL AND btrim(bes_name) <> ''
            ORDER BY ing_no
            """
        )
    return _CACHE_ROWS


def best_legacy_match(urun_adi: str) -> dict | None:
    """Türkçe stok adına en yakın ing_name (bes_name dolu olan satırlar arasında)."""
    if not urun_adi or fuzz is None:
        return None
    rows = get_compound_legacy_rows()
    if not rows:
        return None

    ua = urun_adi.strip().lower()
    best: dict | None = None
    best_sc = -1
    min_sc = max(55, min(95, _DEFAULT_COMPOUND_NAME_MIN_SCORE))
    for r in rows:
        name = str(r.get("ing_name") or "").strip().lower()
        if not name:
            continue
        sc = int(fuzz.token_set_ratio(ua, name))
        if sc > best_sc:
            best_sc = sc
            best = r
    if best is None or best_sc < min_sc:
        return None
    out = dict(best)
    out["_name_match_score"] = best_sc
    return out


def try_compound_fallback_bundle(row: dict, primary_note: str | None):
    """
    USDA primary yolu eslesmedi döndüyse legacy bes_name ile tekrar dene.

    Dönüş: rank/final öncesi ham paket dict veya None.
      llm_term, ranked, best, llm_approved, durum, guven, note
    detail / nut yükleme sync_ingredients içinde ortak blokta yapılır.
    """
    from nutrition_service.ollama_client import verify_same_food

    lg = best_legacy_match(row.get("urun_adi") or "")
    if not lg:
        return None
    bes = str(lg.get("bes_name") or "").strip()
    urun_adi = str(row.get("urun_adi") or "").strip()
    if len(bes) < 8:
        return None

    payload = foods_search_sync(
        query=bes,
        page_size=25,
        data_types=["SR Legacy", "Foundation"],
    )
    foods = payload.get("foods") or []
    ranked = rank_usda_foods(
        bes,
        foods,
        top_n=25,
        ham_food_mode=False,
        meat_cut_preference=False,
    )
    best_c = ranked[0] if ranked else None
    if not best_c:
        return None

    llm_bes = verify_same_food(bes, best_c.description)
    llm_urun = verify_same_food(urun_adi, best_c.description) if urun_adi else None
    llm_merge: bool | None
    if llm_bes is True or llm_urun is True:
        llm_merge = True
    elif llm_bes is False and llm_urun is False:
        llm_merge = False
    else:
        llm_merge = None

    fuzzy_score = int(best_c.score)
    durum = decide_match_status(fuzzy_score=fuzzy_score, llm_approved=llm_merge)
    if durum == "eslesmedi":
        return None

    ing_sc = lg.get("_name_match_score")
    note = (
        f"Compound legacy: SR bes_name ile USDA yeniden arama "
        f"(ing_no={lg.get('ing_no')}, ing≈ürün fuzzy={ing_sc})"
    )
    if primary_note:
        note = f"{primary_note} | {note}"

    return {
        "llm_term": bes[:2048],
        "ranked": ranked,
        "best": best_c,
        "llm_approved": llm_merge,
        "durum": durum,
        "guven": fuzzy_score if durum != "eslesmedi" else None,
        "note": note[:2000],
        "compound_ing_no": lg.get("ing_no"),
    }
