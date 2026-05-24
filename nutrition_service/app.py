"""USDA proxy + Postgres (ingredient_nutrition_* tabloları)."""

from __future__ import annotations

from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from nutrition_service import db
from nutrition_service.usda_client import api_key_required, food_detail_async, foods_search_async, foods_search_with_macros
from nutrition_service.usda_parse import parse_macros_minerals_from_food_payload

_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(_ROOT / ".env")

app = FastAPI(
    title="Voyage Nutrition / USDA bridge",
    docs_url="/api/nutrition/docs",
    openapi_url="/api/nutrition/openapi.json",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/nutrition/health")
async def health():
    return {"ok": True, "service": "nutrition_service"}


class ManualUsdABody(BaseModel):
    fdc_id: int
    secen_kullanici: str | None = None
    not_metni: str | None = None


class ManualEntryBody(BaseModel):
    kaynak: str = Field(..., pattern="^(turkomp|elle)$")
    secen_kullanici: str | None = None
    not_metni: str | None = None
    manuel_usda_fdc_id: int | None = None
    manuel_usda_adi: str | None = None
    protein: float | None = None
    yag: float | None = None
    karbonhidrat: float | None = None
    enerji: float | None = None
    su: float | None = None
    sodyum: float | None = None
    potasyum: float | None = None
    kalsiyum: float | None = None
    demir: float | None = None
    magnezyum: float | None = None
    fosfor: float | None = None
    cinko: float | None = None


class UsdaSearchBody(BaseModel):
    query: str
    page_size: int = Field(15, ge=1, le=50)
    fetch_nutrients: bool = Field(True)


def _row_manual(row_or_none):
    return dict(row_or_none) if row_or_none else None


@app.get("/api/nutrition/summary")
async def summary():
    try:
        rows = db.fetch_all(
            """
            SELECT eslesme_durumu AS durum, COUNT(*)::int AS adet
            FROM fb_cost.ingredient_nutrition
            GROUP BY eslesme_durumu
            """
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"veritabanı: {e!s}") from e
    agg = {"otomatik": 0, "kontrol_gerekli": 0, "eslesmedi": 0, "manuel_onayli": 0}
    for r in rows:
        d = r.get("durum")
        if d in agg:
            agg[d] = r["adet"]
    agg["toplam"] = sum(agg.values())
    return agg


@app.get("/api/nutrition/ingredients")
async def ingredients_list(
    durum: str | None = Query(None),
    limit: int = Query(150, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    where = ""
    params: tuple
    if durum:
        where = "WHERE v.eslesme_durumu = %s"
        params = (durum, limit, offset)
    else:
        params = (limit, offset)

    sql = f"""
      SELECT
        v.urun_id AS id,
        v.stok_no,
        v.urun_adi,
        v.temiz_arama_terimi,
        v.tuketim_miktari,
        v.tip,
        v.birim,
        v.usda_alternatifleri,
        v.usda_fdc_id AS usda_efektif_fdc_id,
        v.usda_adi AS usda_efektif_adi,
        v.usda_data_type,
        v.protein,
        v.yag,
        v.karbonhidrat,
        v.enerji,
        v.su,
        v.sodyum,
        v.potasyum,
        v.kalsiyum,
        v.demir,
        v.magnezyum,
        v.fosfor,
        v.cinko,
        v.guven_skoru,
        v.eslesme_durumu,
        v.veri_kaynagi,
        v.manuel_override_var,
        v.updated_at,
        v.created_at
      FROM fb_cost.v_ingredient_nutrition_resolved v
      {where}
      ORDER BY v.tuketim_miktari DESC NULLS LAST, v.urun_adi ASC
      LIMIT %s OFFSET %s
    """
    try:
        rows = db.fetch_all(sql, params)
        return rows
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.get("/api/nutrition/ingredients/{ingredient_id:int}")
async def ingredient_detail(ingredient_id: int):
    sql_n = """SELECT * FROM fb_cost.ingredient_nutrition WHERE id = %s"""
    sql_m = """SELECT * FROM fb_cost.ingredient_nutrition_manual WHERE ingredient_id = %s"""

    ing = db.fetch_one(sql_n, (ingredient_id,))
    if not ing:
        raise HTTPException(status_code=404, detail="Ürün yok")

    manual = db.fetch_one(sql_m, (ingredient_id,))
    resolved = db.fetch_one(
        "SELECT * FROM fb_cost.v_ingredient_nutrition_resolved WHERE urun_id = %s",
        (ingredient_id,),
    )

    alt = ing.get("usda_alternatifleri")

    otomatik = {
        k: ing.get(k)
        for k in (
            "usda_fdc_id",
            "usda_adi",
            "usda_data_type",
            "protein",
            "yag",
            "karbonhidrat",
            "enerji",
            "su",
            "sodyum",
            "potasyum",
            "kalsiyum",
            "demir",
            "magnezyum",
            "fosfor",
            "cinko",
            "guven_skoru",
        )
    }

    try:
        _ = api_key_required()
        usda_env_ok = True
    except Exception:
        usda_env_ok = False

    alt_out = None
    if alt is None or isinstance(alt, (list, dict)):
        alt_out = alt

    return {
        "otomatik_eslesme": otomatik,
        "manual": _row_manual(manual),
        "resolved": dict(resolved) if resolved else None,
        "alternatif_usda_kaynak": alt_out,
        "usda_env_ok": usda_env_ok,
    }


@app.post("/api/nutrition/ingredients/{ingredient_id:int}/manual-from-usda")
async def manual_from_usda(ingredient_id: int, body: ManualUsdABody):
    ing = db.fetch_one("SELECT id FROM fb_cost.ingredient_nutrition WHERE id=%s", (ingredient_id,))
    if not ing:
        raise HTTPException(status_code=404, detail="Ürün yok")

    raw = await food_detail_async(body.fdc_id)
    desc = raw.get("description") or ""
    nut = parse_macros_minerals_from_food_payload(raw)

    db.execute(
        """
        INSERT INTO fb_cost.ingredient_nutrition_manual (
          ingredient_id, manuel_usda_fdc_id, manuel_usda_adi,
          protein, yag, karbonhidrat, enerji, su,
          sodyum, potasyum, kalsiyum, demir, magnezyum, fosfor, cinko,
          kaynak, secen_kullanici, not_metni
        )
        VALUES (
          %(iid)s, %(fdc)s, %(dsc)s,
          %(protein)s, %(yag)s, %(carb)s, %(energy)s, %(water)s,
          %(na)s, %(k)s, %(ca)s, %(fe)s, %(mg)s, %(p)s, %(zn)s,
          'usda', %(user)s, %(note)s
        )
        ON CONFLICT (ingredient_id) DO UPDATE SET
          manuel_usda_fdc_id = EXCLUDED.manuel_usda_fdc_id,
          manuel_usda_adi = EXCLUDED.manuel_usda_adi,
          protein = EXCLUDED.protein,
          yag = EXCLUDED.yag,
          karbonhidrat = EXCLUDED.karbonhidrat,
          enerji = EXCLUDED.enerji,
          su = EXCLUDED.su,
          sodyum = EXCLUDED.sodyum,
          potasyum = EXCLUDED.potasyum,
          kalsiyum = EXCLUDED.kalsiyum,
          demir = EXCLUDED.demir,
          magnezyum = EXCLUDED.magnezyum,
          fosfor = EXCLUDED.fosfor,
          cinko = EXCLUDED.cinko,
          kaynak = 'usda',
          secen_kullanici = EXCLUDED.secen_kullanici,
          not_metni = EXCLUDED.not_metni,
          secim_tarihi = NOW()
        """,
        {
            "iid": ingredient_id,
            "fdc": body.fdc_id,
            "dsc": desc[:2000],
            "protein": nut["protein"],
            "yag": nut["yag"],
            "carb": nut["karbonhidrat"],
            "energy": nut["enerji"],
            "water": nut["su"],
            "na": nut["sodyum"],
            "k": nut["potasyum"],
            "ca": nut["kalsiyum"],
            "fe": nut["demir"],
            "mg": nut["magnezyum"],
            "p": nut["fosfor"],
            "zn": nut["cinko"],
            "user": body.secen_kullanici,
            "note": body.not_metni,
        },
    )

    db.execute(
        """UPDATE fb_cost.ingredient_nutrition SET eslesme_durumu = 'manuel_onayli',
             updated_at = NOW()
           WHERE id = %s""",
        (ingredient_id,),
    )

    return {"ok": True, "fdc_id": body.fdc_id, "description": desc, "nutrition": nut}


@app.post("/api/nutrition/ingredients/{ingredient_id:int}/manual-entry")
async def manual_entry(ingredient_id: int, body: ManualEntryBody):
    ing = db.fetch_one("SELECT id FROM fb_cost.ingredient_nutrition WHERE id=%s", (ingredient_id,))
    if not ing:
        raise HTTPException(status_code=404, detail="Ürün yok")

    payload = body.model_dump()
    kaynak = payload["kaynak"]

    db.execute(
        """
        INSERT INTO fb_cost.ingredient_nutrition_manual (
          ingredient_id,
          manuel_usda_fdc_id, manuel_usda_adi,
          protein, yag, karbonhidrat, enerji, su,
          sodyum, potasyum, kalsiyum, demir, magnezyum, fosfor, cinko,
          kaynak, secen_kullanici, not_metni
        )
        VALUES (
          %(ingredient_id)s,
          %(manuel_usda_fdc_id)s, %(manuel_usda_adi)s,
          %(protein)s, %(yag)s, %(karbonhidrat)s, %(enerji)s, %(su)s,
          %(sodyum)s, %(potasyum)s, %(kalsiyum)s, %(demir)s,
          %(magnezyum)s, %(fosfor)s, %(cinko)s,
          %(kaynak)s, %(secen_kullanici)s, %(not_metni)s
        )
        ON CONFLICT (ingredient_id) DO UPDATE SET
          manuel_usda_fdc_id = EXCLUDED.manuel_usda_fdc_id,
          manuel_usda_adi = EXCLUDED.manuel_usda_adi,
          protein = EXCLUDED.protein,
          yag = EXCLUDED.yag,
          karbonhidrat = EXCLUDED.karbonhidrat,
          enerji = EXCLUDED.enerji,
          su = EXCLUDED.su,
          sodyum = EXCLUDED.sodyum,
          potasyum = EXCLUDED.potasyum,
          kalsiyum = EXCLUDED.kalsiyum,
          demir = EXCLUDED.demir,
          magnezyum = EXCLUDED.magnezyum,
          fosfor = EXCLUDED.fosfor,
          cinko = EXCLUDED.cinko,
          kaynak = EXCLUDED.kaynak,
          secen_kullanici = EXCLUDED.secen_kullanici,
          not_metni = EXCLUDED.not_metni,
          secim_tarihi = NOW()
        """,
        {**payload, "ingredient_id": ingredient_id},
    )

    db.execute(
        """UPDATE fb_cost.ingredient_nutrition SET eslesme_durumu = 'manuel_onayli'
           WHERE id = %s""",
        (ingredient_id,),
    )

    return {"ok": True, "kaynak": kaynak}


@app.post("/api/nutrition/usda/search")
async def usda_search_post(body: UsdaSearchBody):
    """Foundation + SR Legacy filtresi; istenirse sonuçlara göre ilk N için besin yükle."""
    q = (body.query or "").strip()
    if len(q) < 2:
        raise HTTPException(status_code=400, detail="Arama için en az 2 karakter")
    try:
        if body.fetch_nutrients:
            data = await foods_search_with_macros(query=q, page_size=body.page_size)
            enriched_list = list(data.pop("_enriched") or [])
        else:
            data = await foods_search_async(query=q, page_size=body.page_size)
            enriched_list = []

        enriched_by_id = {int(e["fdc_id"]): e for e in enriched_list if "fdc_id" in e}

        foods_out = []
        for f in data.get("foods") or []:
            fid = f.get("fdcId")
            if fid is None:
                continue
            fid = int(fid)
            merged = dict(f)
            mx = enriched_by_id.get(fid)
            if mx:
                for k in (
                    "protein",
                    "yag",
                    "karbonhidrat",
                    "enerji",
                    "su",
                    "sodyum",
                    "potasyum",
                    "kalsiyum",
                    "demir",
                    "magnezyum",
                    "fosfor",
                    "cinko",
                ):
                    merged[k] = mx.get(k)
            foods_out.append(merged)
            if len(foods_out) >= body.page_size:
                break

        return {
            "foods": foods_out,
            "totalHits": data.get("totalHits"),
        }
    except Exception as e:
        if isinstance(e, RuntimeError):
            raise HTTPException(status_code=503, detail=str(e)) from e
        raise HTTPException(status_code=502, detail=f"USDA isteği: {e!s}") from e


@app.get("/api/nutrition/usda/food/{fdc_id:int}")
async def usda_food_detail(fdc_id: int):
    raw = await food_detail_async(fdc_id)
    nut = parse_macros_minerals_from_food_payload(raw)
    return {
        "fdc_id": fdc_id,
        "description": raw.get("description"),
        "data_type": raw.get("dataType"),
        "nutrition_per_100g": nut,
    }
