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
├── migrate.sql                    # PostgreSQL şema & tablo tanımları
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
- PostgreSQL 13+
- `voyagestars` adında bir veritabanı

### Adımlar

1. Bağımlılıkları yükleyin:

   ```bash
   npm install
   ```

2. Veritabanı şemasını oluşturun:

   ```bash
   psql -U postgres -d voyagestars -f migrate.sql
   ```

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
| Database | `voyagestars` |
| User | `postgres` |
| Password | `$DB_PASSWORD` veya `postgres` |
| App Port | `3010` |

---

## API Uç Noktaları

| Method | Path | Açıklama |
| --- | --- | --- |
| `POST` | `/api/upload` | CSV veya Excel yükler (form-data: `file`) |
| `GET`  | `/api/ozet` | Dönem bazlı özet KPI |
| `GET`  | `/api/kategoriler?tarih=&tip=` | Kategori dağılımı |
| `GET`  | `/api/urun?q=&tip=` | Ürün arama |
| `GET`  | `/api/donemler` | Yüklenmiş dönemlerin listesi |
| `GET`  | `/api/alarmlar` | Tetiklenen alarmlar |
| `GET`  | `/api/alarmlar/esikler` | Alarm eşiklerini listele |
| `POST` | `/api/alarmlar/esikler` | Yeni alarm eşiği ekle |
| `DELETE` | `/api/alarmlar/esikler/:id` | Alarm eşiği sil |

---

## CSV Format Beklentisi

CSV dosyasının başlık satırı aşağıdaki kolonları içermelidir:

```
dosya, tip, tarih_str, yil, ay_no, ay, gun, cost_pax, kur,
kategori, stok_mali, stok_no, birim,
tuk_miktar, birim_fiyat, tutar_tl, tutar_eur,
pp_gr, pp_cl, pp_tl, pp_eur
```

- `tip`: `yiyecek` veya `icenek`
- `tarih_str`: `YYYY-MM` formatında (örn. `2025-04`) — tam ay verisi için.
  Ayın 15'inde alınan kısmi veri için `YYYY-MM-15g` formatı kullanılır
  (örn. `2025-11-15g`). Bu sayede aynı ayın hem tam hem kısmi versiyonu
  yan yana saklanabilir; yıllık aggregasyonlar `-15g` dönemleri otomatik
  hariç tutar.
- Aynı `tarih_str + tip` ile yeniden yükleme yapıldığında mevcut kayıtlar silinip yenileri eklenir.

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
- `birim` kolonuna göre `pp_gr` (g) ve `pp_cl` (cl) değerlerini normalize eder
  (KG → ×1000, GR → ×1, LT → ×100, ML → ÷10, ADET/PORS → 0).

Çıktı CSV'sini web arayüzünden **Veri Yükle** sayfasından yükleyin.

---

## Veritabanı Şeması

`fb_cost` şeması altında iki tablo bulunur:

- `fb_cost.tuketim` — tüketim verilerinin ana tablosu
- `fb_cost.alarm_esikleri` — alarm eşik tanımları

Detaylar için `migrate.sql` dosyasına bakın.

---

## Lisans

Özel (Proprietary) — Voyage Sorgun iç kullanımı.
