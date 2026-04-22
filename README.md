# Voyage Cost — F&B Maliyet Analizi

Voyage Sorgun için geliştirilmiş, yiyecek & içecek (F&B) tüketim maliyetlerini izleyen, analiz eden ve alarmlarla uyarı veren web uygulaması.

CSV veya Excel (.xlsx) dosyalarından dönemsel tüketim verilerini PostgreSQL veritabanına yükler; özet KPI, trend, kategori dağılımı, ürün arama ve eşik bazlı alarm özellikleri sunar.

---

## Özellikler

- **Veri yükleme**: 50 MB'a kadar **Excel (.xlsx / .xlsm / .xls)** veya **CSV** ile dönemsel tüketim verisi (yeniden yükleme / üzerine yazma desteği). Excel için `src/excelImport.js` ilk sayfayı okur; başlıkta "Yiyecek/İçecek" ve tarih (örn. `30 EYLÜL 2022`) olmalıdır.
- **Genel Özet**: Dönem bazında toplam TL / EUR tutarı, PP (per-person) g/cl, cost pax, kur gibi KPI'lar.
- **Trend Analizi**: Aylar arası karşılaştırma.
- **Kategori Dağılımı**: Yiyecek / içecek ayrımında kategori bazlı maliyet dağılımı.
- **Ürün Arama**: Stok malı (ürün) bazında dönemsel hareket takibi.
- **Alarm Sistemi**: `pp_tl`, `pp_eur`, `pp_gr`, `pp_cl`, `tutar_tl` gibi metriklerde yukarı/aşağı eşik alarmları.
- **Modern UI**: Voyage Design System tabanlı, Chart.js ile görselleştirme.

---

## Teknoloji Yığını

| Katman | Teknoloji |
| --- | --- |
| Backend | Node.js, Express 4 |
| Veritabanı | PostgreSQL (şema: `fb_cost`) |
| Frontend | HTML + CSS (Voyage Design System) + Chart.js |
| Dosya İşleme | Multer, csv-parse, [SheetJS (xlsx)](https://www.npmjs.com/package/xlsx) |

---

## Proje Yapısı

```
cost/
├── migrate.sql                    # Sıfır kurulum: fb_cost + tuketim (türetilmiş tutar/pp)
├── migrate_v2_tuketim_computed.sql # Mevcut DB'yi yeni şemaya taşır (yedek alın)
├── fb_cost_functions.sql          # İsteğe bağlı: SQL tutar fonksiyonları (migrate.sql içinde de var)
├── package.json
├── src/
│   └── index.js                   # Express API sunucusu
├── public/
│   ├── index.html                 # SPA arayüzü
│   └── voyage-design-system.css   # Tasarım sistemi
├── scripts/
│   ├── _common.py                 # Excel→CSV ortak parse mantığı
│   ├── fb_tarama.py               # Tam ay (ay sonu) Excel tarayıcısı
│   ├── fb_tarama_15.py            # Kısmi 15 gün (ay ortası) tarayıcısı
│   └── requirements.txt           # pandas + openpyxl
└── uploads/                       # CSV geçici yükleme klasörü (otomatik)
```

---

## Kurulum

### Gereksinimler

- Node.js 18+
- PostgreSQL 12+ (türetilmiş `STORED` sütunlar için)
- Örnek: `cost_analysis` veya `voyagestars` adında bir veritabanı

### Adımlar

1. Bağımlılıkları yükleyin:

   ```bash
   npm install
   ```

2. Veritabanı şemasını oluşturun (sıfırdan; `tuketim` mevcut veriyi **siler**):

   ```bash
   psql -U postgres -d cost_analysis -f migrate.sql
   ```

   **Mevcut** eski `tuketim` tablonuz (düz `tutar_tl` sütunlu) varsa yedek alıp:

   ```bash
   psql -U postgres -d cost_analysis -f migrate_v2_tuketim_computed.sql
   ```

   (İkinci kez çalıştırmayın: hata verir ve durur. Yedek: `fb_cost.tuketim_mig_bak`.)

3. (İsteğe bağlı) Veritabanı parolası için ortam değişkeni:

   ```bash
   export DB_PASSWORD=your_password
   ```

4. Uygulamayı başlatın:

   ```bash
   npm start
   # veya geliştirme modu (nodemon)
   npm run dev
   ```

5. Tarayıcınızda açın: [http://localhost:3010](http://localhost:3010)

---

## Yapılandırma

`src/index.js` içinde varsayılan bağlantı bilgileri:

| Parametre | Varsayılan |
| --- | --- |
| Host | `127.0.0.1` |
| Port (DB) | `5432` |
| Database | `cost_analysis` veya `voyagestars` (`.env` / `DB_NAME`) |
| User | `postgres` |
| Password | `$DB_PASSWORD` veya `postgres` |
| App Port | `3010` |

---

## API Uç Noktaları

| Method | Path | Açıklama |
| --- | --- | --- |
| `POST` | `/api/upload` | CSV veya Excel (çoklu: form-data alanı `files[]`, tek: `file` / `csv`) |
| `GET`  | `/api/ozet` | Dönem bazlı özet KPI |
| `GET`  | `/api/kategoriler?tarih=&tip=` | Kategori dağılımı |
| `GET`  | `/api/urun?q=&tip=` | Ürün arama |
| `GET`  | `/api/donemler` | Yüklenmiş dönemlerin listesi |
| `DELETE` | `/api/donemler?tarih_str=` | O `tarih_str` için tüm tüketim satırlarını siler |
| `GET`  | `/api/alarmlar` | Tetiklenen alarmlar |
| `GET`  | `/api/alarmlar/esikler` | Alarm eşiklerini listele |
| `POST` | `/api/alarmlar/esikler` | Yeni alarm eşiği ekle |
| `DELETE` | `/api/alarmlar/esikler/:id` | Alarm eşiği sil |

---

## CSV / Excel ve veri modeli (tek kaynak alanlar)

`fb_cost.tuketim` satırı **doldururken** sadece şunlar yazılır: dönem meta (`dosya`, `tip`, `tarih_str`, yıl/ay), **cost_pax**, **kur**, stok alanları, **birim**, **tuk_miktar**, **birim_fiyat**.

Aşağıdakiler **veritabanında türetilir** (Excel’de F–J sütunlarıyla uyumlu formül):

- **tutar TL** = yiyecek: `(gram / 1000) × TL/kg` · içecek: `litre × TL/lt`
- **tutar EUR** = `tutar TL / kur` (kur: 1 EUR’nun kaç TL olduğu)
- **P.P. TL / P.P. EUR** = toplam tutar ÷ `cost_pax` (ve EUR için kur)
- **P.P. gr** = yiyecek: `gram / cost_pax` · **P.P. cl** = içecek: `(litre × 100) / cost_pax`

`tip` sütununda: `yiyecek` veya `icenek`. **CSV** eski dışa aktarımlarda `tutar_tl`, `pp_*` sütunları da bulunabilir; yüklerken doldurma için yalnızca **miktar ve birim fiyat yoksa** (veya 0) `tutar_tl` tüketim miktarsız satırlarda kullanılır, sonra türetim yine aynı kuralla yapılır.

Zorunlu/önerilen başlıklar (örnek):

```
dosya, tip, tarih_str, yil, ay_no, ay, gun, cost_pax, kur,
kategori, stok_mali, stok_no, birim, tuk_miktar, birim_fiyat
```

- `tarih_str`: `YYYY-MM` (tam ay) veya kısmi raporlarda `YYYY-MM-15g`
- Aynı `tarih_str + tip` ile yeniden yüklemede o dönem satırları silinir ve yenileri eklenir.
- **Yiyedeğ** Excel’de miktar **kg** ise, `birim` “Kilogram” iken (önce `gram` eşleşmesi yapılmaz) g’ye çevrilir. **KDV vb.** satır: miktar ve birim fiyat yok, yalnızca tutar varsa, tutar korumak için `birim_fiyat = 1` ve sanal miktar atanır.

---

## Excel → CSV (fb_tarama)

Voyage'ın aylık F&B Excel raporlarını otomatik tarayıp yukarıdaki formatta
CSV üreten iki Python script projeyle birlikte gelir:

| Script | Hangi sheet'leri tarar | Çıktı CSV | Üretilen `tarih_str` |
| --- | --- | --- | --- |
| `scripts/fb_tarama.py` | Ayın **son günü** (örn. 30 NİSAN 2025) | `fb_analiz.csv` | `2025-04` |
| `scripts/fb_tarama_15.py` | Ayın **15'i** (örn. 15 NİSAN 2025) | `fb_analiz_15g.csv` | `2025-04-15g` |

İlk kurulum:

```bash
pip3 install -r scripts/requirements.txt
```

Kullanım:

```bash
# Tam ay verisi
python3 scripts/fb_tarama.py /path/to/excel-klasoru

# Ay ortası (15 günlük) kısmi veri
python3 scripts/fb_tarama_15.py /path/to/excel-klasoru
```

Her iki script de:

- Klasörü ve alt klasörlerini özyinelemeli olarak `*.xlsx` için tarar.
- Sheet adından tip (`yiyecek` / `icenek`), gün, ay, yıl çıkarır.
- "Cost Pax" ve "Kur" değerlerini sheet'in meta alanından okur.
- Ürün satırlarını ayrıştırır; özet/toplam/kategori başlık satırlarını atlar.
- Aynı formül mantığıyla `tutar_*` ve `pp_*` değerlerini **hesaplayarak** CSV’ye yazar
  (yiyecek: kg → g; içecek: litre; kur ve cost pax üstten okunur).

Çıktı CSV'sini web arayüzünden **Veri Yükle** sayfasından yükleyin.

---

## Veritabanı Şeması

- `fb_cost.tuketim` — kayıt: `tuk_miktar`, `birim_fiyat`, `kur`, `cost_pax` + meta; `tutar_tl`, `tutar_eur`, `pp_*` sütunları **GENERATED** (formüller `fb_cost.tuketim_*` SQL fonksiyonları ve `migrate.sql` ile aynı).
- `fb_cost.otp_kodlari`, `fb_cost.alarm_esikleri` — giriş ve alarmlar

Detay: `migrate.sql` ve `fb_cost_functions.sql`.

---

## Lisans

Özel (Proprietary) — Voyage Sorgun iç kullanımı.
