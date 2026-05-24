#!/usr/bin/env python3
"""
tuketim → ingredient_nutrition senkronu + USDA eşleştirme.

Aşama A: stok_no ile upsert (besin/eşleşme durumunu bozmaz).
Aşama B: eslesme_durumu='eslesmedi' için USDA araması (akıllı atlama + --force).

Örnek:
  python -m nutrition_service.sync_ingredients --only-sync
  python -m nutrition_service.sync_ingredients --limit 20
  python -m nutrition_service.sync_ingredients --force all --limit 50
  python -m nutrition_service.sync_ingredients --force STK00123
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from dotenv import load_dotenv

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

load_dotenv(_ROOT / ".env")

from nutrition_service import db
from nutrition_service.name_clean import clean_search_term
from nutrition_service.usda_client import food_detail_sync, foods_search_sync
from nutrition_service.usda_match import (
    ScoredCandidate,
    alternatives_json,
    classify_match,
    rank_usda_foods,
)
from nutrition_service.usda_parse import parse_macros_minerals_from_food_payload

EXCLUDED_STOK = ("__DUZELTME__", "__KDV_ILAVE__")

SOURCE_SQL = """
WITH agg AS (
  SELECT
    stok_no,
    stok_mali,
    SUM(tuk_miktar)::numeric AS part_tuk,
    COUNT(*)::int AS name_cnt
  FROM fb_cost.tuketim
  WHERE stok_no IS NOT NULL
    AND btrim(stok_no) <> ''
    AND stok_no NOT IN ('__DUZELTME__', '__KDV_ILAVE__')
  GROUP BY stok_no, stok_mali
),
picked AS (
  SELECT DISTINCT ON (stok_no)
    stok_no,
    stok_mali AS urun_adi,
    SUM(part_tuk) OVER (PARTITION BY stok_no) AS tuketim_miktari
  FROM agg
  ORDER BY stok_no, name_cnt DESC, stok_mali
),
tip_pick AS (
  SELECT DISTINCT ON (stok_no) stok_no, tip
  FROM (
    SELECT stok_no, tip, COUNT(*)::int AS c
    FROM fb_cost.tuketim
    WHERE stok_no IS NOT NULL AND btrim(stok_no) <> ''
      AND stok_no NOT IN ('__DUZELTME__', '__KDV_ILAVE__')
    GROUP BY stok_no, tip
  ) x
  ORDER BY stok_no, c DESC, tip
),
birim_pick AS (
  SELECT DISTINCT ON (stok_no) stok_no, birim
  FROM (
    SELECT stok_no, birim, COUNT(*)::int AS c
    FROM fb_cost.tuketim
    WHERE stok_no IS NOT NULL AND btrim(stok_no) <> ''
      AND stok_no NOT IN ('__DUZELTME__', '__KDV_ILAVE__')
    GROUP BY stok_no, birim
  ) x
  ORDER BY stok_no, c DESC, birim
)
SELECT p.stok_no, p.urun_adi, p.tuketim_miktari, t.tip, b.birim
FROM picked p
LEFT JOIN tip_pick t USING (stok_no)
LEFT JOIN birim_pick b USING (stok_no)
ORDER BY p.tuketim_miktari DESC NULLS LAST
"""

UPSERT_SQL = """
INSERT INTO fb_cost.ingredient_nutrition (
  stok_no, urun_adi, tuketim_miktari, tip, birim, eslesme_durumu
) VALUES (
  %(stok_no)s, %(urun_adi)s, %(tuketim_miktari)s, %(tip)s, %(birim)s, 'eslesmedi'
)
ON CONFLICT (stok_no) DO UPDATE SET
  urun_adi = EXCLUDED.urun_adi,
  tuketim_miktari = EXCLUDED.tuketim_miktari,
  tip = EXCLUDED.tip,
  birim = EXCLUDED.birim,
  updated_at = NOW()
RETURNING id, (xmax = 0) AS inserted
"""


def stage_a_sync() -> dict:
    rows = db.fetch_all(SOURCE_SQL)
    inserted = updated = 0
    for row in rows:
        out = db.execute_returning(UPSERT_SQL, row)
        if not out:
            continue
        if out[0].get("inserted"):
            inserted += 1
        else:
            updated += 1
    total = db.fetch_one("SELECT COUNT(*)::int AS n FROM fb_cost.ingredient_nutrition")
    return {
        "kaynak_stok_sayisi": len(rows),
        "yeni_eklenen": inserted,
        "guncellenen": updated,
        "tablo_toplam": total["n"] if total else 0,
    }


def _candidates_for_row(row: dict) -> tuple[str, list[ScoredCandidate]]:
    term = clean_search_term(row["urun_adi"])
    if not term:
        return "", []
    payload = foods_search_sync(query=term, page_size=15)
    foods = payload.get("foods") or []
    ranked = rank_usda_foods(term, foods, top_n=5)
    return term, ranked


def _apply_match_update(row_id: int, row: dict, term: str, ranked: list[ScoredCandidate]) -> dict:
    best = ranked[0] if ranked else None
    durum, guven = classify_match(best)

    usda_fdc_id = None
    usda_adi = None
    usda_data_type = None
    alts = None
    nut: dict = {
        "protein": None,
        "yag": None,
        "karbonhidrat": None,
        "enerji": None,
        "su": None,
        "sodyum": None,
        "potasyum": None,
        "kalsiyum": None,
        "demir": None,
        "magnezyum": None,
        "fosfor": None,
        "cinko": None,
    }

    if durum in ("otomatik", "kontrol_gerekli") and best:
        detail = food_detail_sync(best.fdc_id)
        parsed = parse_macros_minerals_from_food_payload(detail)
        nut = {k: parsed.get(k) for k in nut}
        usda_fdc_id = best.fdc_id
        usda_adi = detail.get("description") or best.description
        usda_data_type = detail.get("dataType") or best.data_type
        alts = alternatives_json(ranked, skip_first=True) if durum == "kontrol_gerekli" else None
    elif durum == "eslesmedi" and ranked:
        alts = alternatives_json(ranked, skip_first=False)[:3]

    db.execute(
        """
        UPDATE fb_cost.ingredient_nutrition SET
          temiz_arama_terimi = %(term)s,
          usda_fdc_id = %(usda_fdc_id)s,
          usda_adi = %(usda_adi)s,
          usda_data_type = %(usda_data_type)s,
          protein = %(protein)s,
          yag = %(yag)s,
          karbonhidrat = %(karbonhidrat)s,
          enerji = %(enerji)s,
          su = %(su)s,
          sodyum = %(sodyum)s,
          potasyum = %(potasyum)s,
          kalsiyum = %(kalsiyum)s,
          demir = %(demir)s,
          magnezyum = %(magnezyum)s,
          fosfor = %(fosfor)s,
          cinko = %(cinko)s,
          guven_skoru = %(guven)s,
          eslesme_durumu = %(durum)s,
          usda_alternatifleri = %(alts)s::jsonb,
          son_arama_tarihi = NOW(),
          son_arama_urun_adi = %(urun_adi)s,
          arama_denemesi = COALESCE(arama_denemesi, 0) + 1,
          updated_at = NOW()
        WHERE id = %(id)s
        """,
        {
            "id": row_id,
            "term": term or None,
            "usda_fdc_id": usda_fdc_id,
            "usda_adi": usda_adi,
            "usda_data_type": usda_data_type,
            **nut,
            "guven": guven,
            "durum": durum,
            "alts": json.dumps(alts) if alts is not None else None,
            "urun_adi": row["urun_adi"],
        },
    )

    return {
        "stok_no": row.get("stok_no"),
        "urun_adi": row["urun_adi"],
        "temiz_arama_terimi": term,
        "eslesme_durumu": durum,
        "guven_skoru": guven,
        "usda_adi": usda_adi,
        "usda_fdc_id": usda_fdc_id,
    }


def _fetch_stage_b_rows(*, limit: int | None, force: str | None) -> list[dict]:
    params: dict = {}
    if force and force.lower() != "all":
        sql = """
          SELECT id, stok_no, urun_adi, tuketim_miktari, son_arama_tarihi, son_arama_urun_adi
          FROM fb_cost.ingredient_nutrition
          WHERE stok_no = %(stok)s
            AND eslesme_durumu <> 'manuel_onayli'
          ORDER BY tuketim_miktari DESC NULLS LAST
        """
        params["stok"] = force
        if limit:
            sql += " LIMIT %(lim)s"
            params["lim"] = limit
        return db.fetch_all(sql, params)

    sql = """
      SELECT id, stok_no, urun_adi, tuketim_miktari, son_arama_tarihi, son_arama_urun_adi
      FROM fb_cost.ingredient_nutrition
      WHERE eslesme_durumu = 'eslesmedi'
    """
    if not force or force.lower() != "all":
        sql += """
          AND (
            son_arama_tarihi IS NULL
            OR urun_adi IS DISTINCT FROM son_arama_urun_adi
          )
        """
    sql += " ORDER BY tuketim_miktari DESC NULLS LAST"
    if limit:
        sql += " LIMIT %(lim)s"
        params["lim"] = limit
    return db.fetch_all(sql, params)


def stage_b_usda(*, limit: int | None = None, force: str | None = None) -> dict:
    rows = _fetch_stage_b_rows(limit=limit, force=force)
    results = []
    counts = {"otomatik": 0, "kontrol_gerekli": 0, "eslesmedi": 0, "hata": 0}

    for row in rows:
        try:
            term, ranked = _candidates_for_row(row)
            summary = _apply_match_update(row["id"], row, term, ranked)
            results.append(summary)
            d = summary["eslesme_durumu"]
            if d in counts:
                counts[d] += 1
        except Exception as e:
            counts["hata"] += 1
            results.append(
                {
                    "stok_no": row.get("stok_no"),
                    "urun_adi": row["urun_adi"],
                    "hata": str(e),
                }
            )

    return {"islenen": len(rows), "sayac": counts, "sonuclar": results}


def _print_report(title: str, data: dict):
    print(f"\n=== {title} ===")
    for k, v in data.items():
        if k == "sonuclar":
            continue
        print(f"  {k}: {v}")
    if data.get("sonuclar"):
        print("\n  Sonuçlar:")
        for r in data["sonuclar"]:
            if "hata" in r:
                print(f"    ✗ {r.get('stok_no')} {r.get('urun_adi')}: {r['hata']}")
            else:
                print(
                    f"    · {r.get('stok_no')} | {r.get('urun_adi')[:50]}"
                    f" → {r.get('eslesme_durumu')} ({r.get('guven_skoru')})"
                    f" | {r.get('usda_adi') or '—'}"
                )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="tuketim → ingredient_nutrition USDA senkronu")
    parser.add_argument(
        "--only-sync",
        action="store_true",
        help="Yalnız Aşama A (tuketim upsert); USDA araması yapma",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        metavar="N",
        help="Aşama B: en fazla N ürün işle",
    )
    parser.add_argument(
        "--force",
        nargs="?",
        const="all",
        default=None,
        metavar="STOK_NO|all",
        help="USDA aramasını zorla (stok_no veya all)",
    )
    args = parser.parse_args(argv)

    try:
        rep_a = stage_a_sync()
        _print_report("Aşama A — tuketim upsert", rep_a)

        if args.only_sync:
            print("\n(--only-sync: Aşama B atlandı)")
            return 0

        rep_b = stage_b_usda(limit=args.limit, force=args.force)
        _print_report("Aşama B — USDA eşleştirme", rep_b)
        return 0
    except Exception as e:
        print(f"HATA: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
