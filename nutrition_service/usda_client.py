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


_RETRYABLE_SEARCH_STATUS = frozenset((429, 502, 503, 504))
_SEARCH_ATTEMPTS = int(os.environ.get("USDA_SEARCH_MAX_ATTEMPTS", "6"))


async def foods_search_async(
    *,
    query: str,
    page_size: int = 15,
    data_types: tuple[str, ...] | None = None,
) -> dict:
    """USDA POST /foods/search — geçici ağ/USDA kapısı hatalarında birkaç kez yeniden dener."""
    if data_types is None:
        data_types = ("Foundation", "SR Legacy")
    url = f"{_USDA_BASE}/foods/search"
    params = {"api_key": api_key_required()}
    body = {"query": query, "pageSize": page_size, "dataType": list(data_types)}
    last_detail = ""
    for attempt in range(max(1, _SEARCH_ATTEMPTS)):
        try:
            timeout = httpx.Timeout(connect=15.0, read=55.0, write=30.0, pool=30.0)
            async with httpx.AsyncClient(timeout=timeout) as client:
                r = await client.post(url, params=params, json=body)
                sc = int(r.status_code)
                if sc in _RETRYABLE_SEARCH_STATUS:
                    snippet = (r.text or "").strip().replace("\n", " ")
                    last_detail = (
                        snippet[:260] + "…" if len(snippet) > 260 else snippet or f"(gövde yok)"
                    )
                    await asyncio.sleep(min(45.0, 1.7**attempt))
                    continue
                r.raise_for_status()
                return r.json()
        except httpx.TimeoutException as e:
            last_detail = repr(e)
            await asyncio.sleep(min(30.0, 1.5**attempt))
        except httpx.RequestError as e:
            last_detail = repr(e)
            await asyncio.sleep(min(30.0, 1.5**attempt))
        except httpx.HTTPStatusError as e:
            isc = int(e.response.status_code)
            snippet = ""
            try:
                snippet = (e.response.text or "").strip().replace("\n", " ")
            except Exception:
                pass
            last_detail = f"HTTP {isc}" + (
                f" — {(snippet[:200] + '…') if len(snippet) > 200 else (snippet or '')}"
            )
            if isc in _RETRYABLE_SEARCH_STATUS:
                await asyncio.sleep(min(45.0, 1.7**attempt))
                continue
            raise
    raise RuntimeError(
        "USDA foods/search yanıt veremedi (birkaç deneme sonra). Son bilgi: "
        + (last_detail or "bilinmeyen")
    ) from None


async def _food_detail_with_client(client: httpx.AsyncClient, fdc_id: int) -> dict:
    url = f"{_USDA_BASE}/food/{int(fdc_id)}"
    params = {"api_key": api_key_required()}
    last_exc: BaseException | None = None
    for attempt in range(4):
        try:
            r = await client.get(url, params=params)
            sc = int(r.status_code)
            if sc in _RETRYABLE_SEARCH_STATUS:
                await asyncio.sleep(min(40.0, 1.6**attempt))
                continue
            r.raise_for_status()
            return r.json()
        except httpx.TimeoutException as e:
            last_exc = e
            await asyncio.sleep(min(25.0, 1.4**attempt))
        except httpx.RequestError as e:
            last_exc = e
            await asyncio.sleep(min(25.0, 1.4**attempt))
        except httpx.HTTPStatusError as e:
            last_exc = e
            isc = int(e.response.status_code)
            if isc in _RETRYABLE_SEARCH_STATUS:
                await asyncio.sleep(min(40.0, 1.6**attempt))
                continue
            raise
    raise RuntimeError(
        f"USDA food/{fdc_id} yanıt veremedi: {repr(last_exc) if last_exc else 'bilinmeyen'}"
    ) from last_exc


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

    async with httpx.AsyncClient(timeout=httpx.Timeout(15.0, read=65.0, write=35.0, pool=35.0)) as client:
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
    timeout = httpx.Timeout(connect=15.0, read=65.0, write=35.0, pool=35.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
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

