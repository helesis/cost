"""USDA FDC REST (api key query param)."""

from __future__ import annotations

import asyncio
import os

import httpx

from nutrition_service.usda_parse import parse_macros_minerals_from_food_payload

_USDA_BASE = "https://api.nal.usda.gov/fdc/v1"


def api_key_required() -> str:
    key = (
        os.environ.get("USDA_API_KEY")
        or os.environ.get("USDA_FOOD_DATA_CENTRAL_KEY")
        or ""
    ).strip()
    if not key:
        raise RuntimeError(
            "USDA_API_KEY veya USDA_FOOD_DATA_CENTRAL_KEY tanımlayın "
            "(FoodData Central API anahtarı)."
        )
    return key


async def foods_search_async(
    *,
    query: str,
    page_size: int = 15,
    data_types: tuple[str, ...] | None = None,
) -> dict:
    if data_types is None:
        data_types = ("Foundation", "SR Legacy")
    url = f"{_USDA_BASE}/foods/search"
    params = {"api_key": api_key_required()}
    body = {"query": query, "pageSize": page_size, "dataType": list(data_types)}
    async with httpx.AsyncClient(timeout=45.0) as client:
        r = await client.post(url, params=params, json=body)
        r.raise_for_status()
        return r.json()


async def _food_detail_with_client(client: httpx.AsyncClient, fdc_id: int) -> dict:
    url = f"{_USDA_BASE}/food/{int(fdc_id)}"
    params = {"api_key": api_key_required()}
    r = await client.get(url, params=params)
    r.raise_for_status()
    return r.json()


async def foods_search_with_macros(
    *, query: str, page_size: int = 12, nutrient_fetch_limit: int = 12
) -> dict:
    """
    USDA araması + ilk `nutrient_fetch_limit` sonuç için ayrı /food çağrısıyla makro özeti.
    """
    sr = await foods_search_async(query=query, page_size=page_size)
    foods_meta = sr.get("foods") or []
    fds: list[int] = []
    for f in foods_meta:
        fid = f.get("fdcId")
        if fid is not None:
            fds.append(int(fid))
    fds = fds[:nutrient_fetch_limit]

    summaries: list[dict] = []

    async with httpx.AsyncClient(timeout=45.0) as client:
        sem = asyncio.Semaphore(5)

        async def enriched(fdc: int):
            async with sem:
                detail = await _food_detail_with_client(client, fdc)
                nut = parse_macros_minerals_from_food_payload(detail)
                return {
                    "fdc_id": fdc,
                    "description": detail.get("description") or "",
                    "data_type": detail.get("dataType") or "",
                    **nut,
                }

        if fds:
            summaries = await asyncio.gather(*(enriched(x) for x in fds))

    sr_out = dict(sr)
    sr_out["_enriched"] = summaries
    return sr_out


async def food_detail_async(fdc_id: int) -> dict:
    async with httpx.AsyncClient(timeout=45.0) as client:
        return await _food_detail_with_client(client, int(fdc_id))
