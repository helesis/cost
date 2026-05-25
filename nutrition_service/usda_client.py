"""USDA FDC REST (api key query param)."""

from __future__ import annotations

import asyncio
import os
import time

import httpx

from nutrition_service.usda_parse import parse_macros_minerals_from_food_payload

_USDA_BASE = "https://api.nal.usda.gov/fdc/v1"
DEFAULT_REQUEST_DELAY_SEC = float(os.environ.get("USDA_REQUEST_DELAY_SEC", "0.35"))


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


# ── Senkron istemci (sync_ingredients.py) ─────────────────────────────────────

_last_sync_request_at = 0.0


def _throttle_sync():
    global _last_sync_request_at
    delay = DEFAULT_REQUEST_DELAY_SEC
    if delay <= 0:
        return
    now = time.monotonic()
    wait = delay - (now - _last_sync_request_at)
    if wait > 0:
        time.sleep(wait)
    _last_sync_request_at = time.monotonic()


def _request_with_backoff_sync(method: str, url: str, *, params=None, json_body=None, max_retries: int = 5):
    params = dict(params or {})
    params.setdefault("api_key", api_key_required())
    last_err = None
    for attempt in range(max_retries):
        _throttle_sync()
        try:
            with httpx.Client(timeout=60.0) as client:
                if method.upper() == "GET":
                    r = client.get(url, params=params)
                else:
                    r = client.post(url, params=params, json=json_body)
                if r.status_code == 429:
                    time.sleep(min(60.0, 2.0 ** attempt))
                    continue
                r.raise_for_status()
                return r.json()
        except httpx.HTTPStatusError as e:
            last_err = e
            if e.response.status_code in (429, 502, 503, 504):
                time.sleep(min(60.0, 2.0 ** attempt))
                continue
            raise
        except httpx.HTTPError as e:
            last_err = e
            time.sleep(min(30.0, 1.5 ** attempt))
    raise RuntimeError(f"USDA isteği başarısız ({url}): {last_err}") from last_err


def foods_search_sync(
    *,
    query: str,
    page_size: int = 15,
    data_types: list[str] | None = None,
) -> dict:
    url = f"{_USDA_BASE}/foods/search"
    if data_types is None:
        data_types = ["Foundation", "SR Legacy"]
    body = {
        "query": query,
        "pageSize": page_size,
        "dataType": list(data_types),
    }
    return _request_with_backoff_sync("POST", url, json_body=body)


def food_detail_sync(fdc_id: int) -> dict:
    url = f"{_USDA_BASE}/food/{int(fdc_id)}"
    return _request_with_backoff_sync("GET", url)


def food_nutrition_sync(fdc_id: int) -> dict:
    detail = food_detail_sync(fdc_id)
    return parse_macros_minerals_from_food_payload(detail)

