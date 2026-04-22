#!/usr/bin/env python3
"""
Voyage F&B Maliyet Analizi — Akıllı Tarayıcı (v2)
===================================================
Her KIYAS ANALİZİ dosyasının İLK sheet'ini okur.
  - Geçmiş aylar: sadece ay sonu (28/29/30/31)
  - Bulunduğumuz ay: ay sonu öncelikli, yoksa 15 fallback
  - MRKZ duplicate: kök tercih edilir
  - Tarih duplicate: tek kopya alınır

Kullanım:
  pip3 install -r scripts/requirements.txt           # ilk kurulum

  python3 scripts/fb_tarama.py /klasor/yolu --dry    # önce kontrol et
  python3 scripts/fb_tarama.py /klasor/yolu          # CSV oluştur

Çıktı: <klasor>/fb_analiz.csv
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import run_scan  # noqa: E402


def main() -> int:
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
        return 1

    dry = False
    klasor_arg = None
    for a in args:
        if a in ("--dry", "--dry-run", "-n"):
            dry = True
        elif a.startswith("-"):
            print(f"Bilinmeyen seçenek: {a}")
            return 1
        else:
            klasor_arg = a

    if not klasor_arg:
        print("HATA: klasör yolu eksik.")
        print(__doc__)
        return 1

    klasor = Path(klasor_arg).expanduser().resolve()
    return run_scan(ana_klasor=klasor, cikti_adi="fb_analiz.csv", dry_run=dry)


if __name__ == "__main__":
    raise SystemExit(main())
