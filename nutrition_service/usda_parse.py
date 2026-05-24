"""USDA FoodData Central yanıtlarından makro/mineraller (100 g başına)."""

from typing import Any

# FDC yüzey bileşenleri (tipik Survey / SR Legacy nutrient id map)
_IDS = {
    "enerji_kcal": 1008,
    "protein": 1003,
    "fat": 1004,
    "carb": 1005,
    "water": 1051,
    "sodium_mg": 1093,
    "potassium_mg": 1092,
    "calcium_mg": 1087,
    "iron_mg": 1089,
    "magnesium_mg": 1090,
    "phosphorus_mg": 1091,
    "zinc_mg": 1095,
}


def _find_amount(
    nutrients: list[dict[str, Any]], wanted_ids: set[int]
) -> float | None:
    for fn in nutrients or []:
        nut = fn.get("nutrient") if isinstance(fn.get("nutrient"), dict) else {}
        nid = fn.get("nutrientId")
        if nid is None:
            nid = nut.get("id")
        try:
            nid_int = int(nid) if nid is not None else None
        except (TypeError, ValueError):
            nid_int = None

        amt = fn.get("amount")
        val = fn.get("value")

        if nid_int not in wanted_ids:
            continue
        if amt is not None:
            try:
                return round(float(amt), 6)
            except (TypeError, ValueError):
                pass
        if val is not None:
            try:
                return round(float(val), 6)
            except (TypeError, ValueError):
                continue
    return None


def parse_macros_minerals_from_food_payload(food: dict[str, Any]) -> dict[str, Any | None]:
    """foodNutrients birleşimi (survey veya ara endpoint). Kolon anahtarları Türkçe kolonlarla uyumlu."""
    nlist = food.get("foodNutrients") or []

    return {
        "protein": _find_amount(nlist, {_IDS["protein"]}),
        "yag": _find_amount(nlist, {_IDS["fat"]}),
        "karbonhidrat": _find_amount(nlist, {_IDS["carb"]}),
        "enerji": _find_amount(nlist, {_IDS["enerji_kcal"]}),
        "su": _find_amount(nlist, {_IDS["water"]}),
        "sodyum": _find_amount(nlist, {_IDS["sodium_mg"]}),
        "potasyum": _find_amount(nlist, {_IDS["potassium_mg"]}),
        "kalsiyum": _find_amount(nlist, {_IDS["calcium_mg"]}),
        "demir": _find_amount(nlist, {_IDS["iron_mg"]}),
        "magnezyum": _find_amount(nlist, {_IDS["magnesium_mg"]}),
        "fosfor": _find_amount(nlist, {_IDS["phosphorus_mg"]}),
        "cinko": _find_amount(nlist, {_IDS["zinc_mg"]}),
    }
