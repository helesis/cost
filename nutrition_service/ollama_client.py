"""Ollama LLM — USDA arama terimi çevirisi ve anlamsal doğrulama."""

from __future__ import annotations

import os
import re

import httpx

from nutrition_service.name_clean import extract_english_core

_DEFAULT_URL = "http://127.0.0.1:11434/api/generate"
_OLLAMA_URL = (os.environ.get("OLLAMA_URL") or _DEFAULT_URL).strip()
_OLLAMA_MODEL = (os.environ.get("OLLAMA_USDA_MODEL") or os.environ.get("OLLAMA_MODEL") or "qwen2.5:32b").strip()
_OLLAMA_TIMEOUT = float(os.environ.get("OLLAMA_TIMEOUT_SEC", "180"))

_TRANSLATE_SYSTEM = """Sen bir otel F&B (yiyecek-içecek) stok ve USDA FoodData Central uzmanısın.
Görevin: Türkçe/İngilizce karışık stok kalemi adını USDA'da aranacak KISA İngilizce gıda terimine çevirmek.

Bağlam:
- Otel mutfağı hammadde listesi; tedarikçi jargonu olabilir.
- FLETO / FILETO = fillet
- SOKLU = on the bone
- KAFES = whole / carcass (bağlama göre)
- "BEEF" domates çeşidi olabilir (beefsteak tomato) — et değil
- AYÇICEK YAG = sunflower oil
- YUMURTA = egg (eggs)
- UN = flour (wheat flour)
- SÜT = milk

Kurallar:
- Yalnızca kısa İngilizce arama terimi yaz (1–4 kelime ideal).
- Açıklama, cümle, JSON, markdown YAZMA.
- Gıda değilse (temizlik, ekipman) sadece: NON_FOOD"""

_VERIFY_SYSTEM = """Sen gıda eşleştirme denetçisisin.
Verilen Türkçe otel stok kalemi ile USDA (ABD gıda veritabanı) ürün adının AYNI temel gıda olup olmadığını değerlendir.
Yalnızca tek kelime yanıt: EVET veya HAYIR.
Aynı gıda değilse (ör. yumurta vs böğürtlen) HAYIR de."""


def _generate(prompt: str, *, system: str, temperature: float = 0.1) -> str | None:
    """Ollama /api/generate; hata/timeout → None (fail-safe)."""
    url = _OLLAMA_URL
    if "/api/" not in url:
        url = url.rstrip("/") + "/api/generate"

    body = {
        "model": _OLLAMA_MODEL,
        "prompt": prompt,
        "system": system,
        "stream": False,
        "options": {"temperature": temperature, "num_predict": 64},
    }
    try:
        with httpx.Client(timeout=_OLLAMA_TIMEOUT) as client:
            r = client.post(url, json=body)
            r.raise_for_status()
            data = r.json()
            text = (data.get("response") or "").strip()
            return text if text else None
    except Exception:
        return None


def _first_line(text: str) -> str:
    line = (text or "").strip().splitlines()[0].strip()
    line = re.sub(r"^[`\"']+|[`\"']+$", "", line)
    line = re.sub(r"^(answer|translation|term)\s*:\s*", "", line, flags=re.I)
    return line.strip()


def translate_food_search_term(urun_adi: str) -> str | None:
    """
    Türkçe stok adı → USDA arama terimi (İngilizce).
    Başarısızlıkta None.
    """
    raw = (urun_adi or "").strip()
    if not raw:
        return None

    hint = extract_english_core(raw)
    hint_part = f'\nİpucu (varsa İngilizce parça): "{hint}"' if hint and hint != raw else ""

    prompt = f"""Stok kalemi: "{raw}"{hint_part}

USDA arama terimi (yalnızca kısa İngilizce):"""

    out = _generate(prompt, system=_TRANSLATE_SYSTEM)
    if not out:
        return None

    term = _first_line(out)
    if not term or len(term) > 120:
        return None
    if term.upper() in ("NON_FOOD", "NON-FOOD", "N/A", "NA"):
        return None
    # Markdown/code blok temizliği
    term = re.sub(r"[^\w\s\-,()/]", " ", term)
    term = re.sub(r"\s+", " ", term).strip()
    return term or None


_EvetRe = re.compile(r"^\s*EVET\s*$", re.I)
_HayirRe = re.compile(r"^\s*HAYIR\s*$", re.I)


def verify_same_food(urun_adi: str, usda_adi: str) -> bool | None:
    """
    LLM anlamsal onay. True=EVET, False=HAYIR, None=timeout/hata (fail-safe).
    """
    if not (urun_adi or "").strip() or not (usda_adi or "").strip():
        return None

    prompt = f"""Türkçe stok kalemi: "{urun_adi.strip()}"
USDA ürün adı: "{usda_adi.strip()}"

Aynı temel gıda mı? (EVET veya HAYIR):"""

    out = _generate(prompt, system=_VERIFY_SYSTEM, temperature=0.0)
    if not out:
        return None

    ans = _first_line(out).upper()
    if _EvetRe.match(ans) or ans.startswith("EVET"):
        return True
    if _HayirRe.match(ans) or ans.startswith("HAYIR") or ans.startswith("NO"):
        return False
    # Belirsiz yanıt → güvenli taraf
    return None
