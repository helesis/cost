#!/usr/bin/env python3
"""
PostgreSQL compounds dump (*.sql) içindeki tb_inglist + tb_nutvalue bloklarını ayrıştırıp
fb_cost.ingredient_compound_legacy tablosunu doldurur.

Örn.:
  psql … -f migrate_ingredient_compound_legacy_up.sql
  python -m nutrition_service.import_compound_legacy --sql-file=/path/to/1779714761656_compounds.sql
"""

from __future__ import annotations

import argparse
import csv
import re
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path

from dotenv import load_dotenv

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

load_dotenv(_ROOT / ".env")

from nutrition_service import db


def norm_desc(key: str) -> str:
    return " ".join(key.strip().upper().split())


def pg_field(x: str | None):
    if x is None:
        return None
    s = x.strip()
    if s == "" or s == r"\N":
        return None
    return s


def num_or_none(raw: str | None):
    x = pg_field(raw)
    if x is None:
        return None
    try:
        return Decimal(str(x))
    except (InvalidOperation, ValueError):
        return None


def int_or_none(raw: str | None):
    x = pg_field(raw)
    if x is None:
        return None
    try:
        return int(float(x))
    except ValueError:
        return None


def parse_copy_blocks(text: str, table_simple: str) -> list[list[str]]:
    """COPY tb_xxx (...) FROM stdin; sonrası satırlar (\\ ile biter)."""
    pat = re.compile(
        rf"^COPY\s+{re.escape(table_simple)}\s+\([^)]+\)\s+FROM\s+stdin;",
        re.IGNORECASE | re.MULTILINE,
    )
    m = pat.search(text)
    if not m:
        return []
    rest = text[m.end() :]
    lines_out: list[list[str]] = []
    for line in rest.splitlines():
        ls = line.rstrip("\n")
        if ls == r"\.":
            break
        if not ls.strip():
            continue
        row = next(csv.reader([ls], delimiter="\t"))
        lines_out.append(row)
    return lines_out


def build_nut_index(nut_rows: list[list[str]]):
    by_desc: dict[str, dict] = {}
    for r in nut_rows:
        if len(r) < 6:
            continue
        nut_no_s, desc, prot, carb, ener, wat = (
            r[0],
            r[1],
            r[2],
            r[3],
            r[4],
            r[5],
        )
        d = pg_field(desc)
        if not d:
            continue
        by_desc[norm_desc(d)] = {
            "nut_no": int_or_none(nut_no_s),
            "description": d,
            "protein": num_or_none(prot),
            "carboh": num_or_none(carb),
            "energy_legacy": int_or_none(ener),
            "water_legacy": num_or_none(wat),
        }
    return by_desc


UPSERT_SQL = """
INSERT INTO fb_cost.ingredient_compound_legacy (
  ing_no, ing_name, bes_name, nut_no, protein, carboh, energy_legacy, water_legacy
) VALUES (
  %(ing_no)s, %(ing_name)s, %(bes_name)s, %(nut_no)s, %(protein)s, %(carboh)s, %(energy_legacy)s, %(water_legacy)s
)
ON CONFLICT (ing_no) DO UPDATE SET
  ing_name = EXCLUDED.ing_name,
  bes_name = EXCLUDED.bes_name,
  nut_no = EXCLUDED.nut_no,
  protein = EXCLUDED.protein,
  carboh = EXCLUDED.carboh,
  energy_legacy = EXCLUDED.energy_legacy,
  water_legacy = EXCLUDED.water_legacy
"""

# Dump'taki COPY sırası: ing_name … bes_name (16. sütun, 0-tabanlı 15) … ing_no (16)
_IDX_ING_NAME = 0
_IDX_BES = 15
_IDX_ING_NO = 16


def ingest_from_sql(sql_path: Path, *, chunk: int = 150) -> dict:
    text = sql_path.read_text(encoding="utf8", errors="replace")

    raw_nut = parse_copy_blocks(text, "tb_nutvalue")
    raw_ing = parse_copy_blocks(text, "tb_inglist")
    if not raw_nut:
        raise SystemExit(
            "tb_nutvalue COPY bloğu bulunamadı — dosya uygun PostgreSQL dump mı?",
        )
    if not raw_ing:
        raise SystemExit("tb_inglist COPY bloğu bulunamadı.")

    need = max(_IDX_ING_NAME, _IDX_BES, _IDX_ING_NO) + 1
    if len(raw_ing[0]) < need:
        raise SystemExit(
            f"tb_inglist satırı beklenen sütun sayısından kısa ({len(raw_ing[0])} < {need}).",
        )

    nut_idx = build_nut_index(raw_nut)

    batch: list[dict] = []
    stats = {"ing_rows": 0, "with_bes": 0, "nut_join": 0, "upserts": 0}

    for r in raw_ing:
        if len(r) < need:
            continue
        stats["ing_rows"] += 1
        ing_name = pg_field(r[_IDX_ING_NAME]) or ""
        bes = pg_field(r[_IDX_BES])
        ing_no = int_or_none(r[_IDX_ING_NO])
        if ing_no is None:
            continue
        if bes:
            stats["with_bes"] += 1
        nut_blob = nut_idx.get(norm_desc(bes)) if bes else None
        nut_no_v = nut_blob["nut_no"] if nut_blob and nut_blob.get("nut_no") else None
        if nut_blob:
            stats["nut_join"] += 1
        prot = carb = wat = None
        energy_legacy = None
        if nut_blob:
            prot = nut_blob.get("protein")
            carb = nut_blob.get("carboh")
            wat = nut_blob.get("water_legacy")
            energy_legacy = nut_blob.get("energy_legacy")

        batch.append(
            {
                "ing_no": ing_no,
                "ing_name": ing_name,
                "bes_name": bes,
                "nut_no": nut_no_v,
                "protein": float(prot) if prot is not None else None,
                "carboh": float(carb) if carb is not None else None,
                "energy_legacy": energy_legacy,
                "water_legacy": float(wat) if wat is not None else None,
            }
        )

        if len(batch) >= chunk:
            db.execute_many(UPSERT_SQL, batch)
            stats["upserts"] += len(batch)
            batch.clear()

    if batch:
        db.execute_many(UPSERT_SQL, batch)
        stats["upserts"] += len(batch)

    return stats


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Compounds SQL dump → fb_cost.ingredient_compound_legacy")
    parser.add_argument("--sql-file", type=Path, required=True)
    args = parser.parse_args(argv)

    if not args.sql_file.is_file():
        print(f"Dosya yok: {args.sql_file}", file=sys.stderr)
        return 2

    st = ingest_from_sql(args.sql_file)
    print("İçe aktarma özeti:")
    for k, v in st.items():
        print(f"  {k}: {v}")

    try:
        from nutrition_service.compound_legacy import invalidate_cache

        invalidate_cache()
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
