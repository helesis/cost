#!/usr/bin/env python3
"""
Voyage F&B Maliyet Analizi — KISMİ (15 GÜN) Tarayıcı
=====================================================
Sadece ayın 15'INDEKI Excel sheet'lerini işler.
Ay henüz bitmeden, ilk yarının kümülatif verisi için kullanılır.

Kullanım:
  pip3 install -r scripts/requirements.txt          # ilk kurulum
  python3 scripts/fb_tarama_15.py /klasor/yolu

Çıktı: <klasor>/fb_analiz_15g.csv
       tarih_str formatı: '2025-04-15g' (kısmi 15 gün)

Tam ay verisinden ayrı bir döneme yazılır; aynı ayın hem 15 günlük hem
tam ay versiyonu DB'de yan yana durabilir. Web arayüzünde dropdown'da
"(15 gün)" etiketiyle görünür.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import run_scan, is_ay_orta_15  # noqa: E402


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        print("\nÖrnek: python3 scripts/fb_tarama_15.py /Users/ali/Desktop/FB_Dosyalari")
        return 1

    klasor = Path(sys.argv[1]).expanduser().resolve()
    return run_scan(
        ana_klasor=klasor,
        gun_filter=is_ay_orta_15,
        tarih_str_fn=lambda t: f"{t['tarih_str']}-15g",  # '2025-04-15g'
        cikti_adi="fb_analiz_15g.csv",
        etiket="KISMI 15 GUN (ay ortasi)",
    )


if __name__ == "__main__":
    raise SystemExit(main())
