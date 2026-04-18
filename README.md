# Voyage Cost — F&B Maliyet Analizi

Voyage Sorgun için geliştirilmiş, yiyecek & içecek (F&B) tüketim maliyetlerini izleyen, analiz eden ve alarmlarla uyarı veren web uygulaması.

CSV dosyalarından dönemsel tüketim verilerini PostgreSQL veritabanına yükler; özet KPI, trend, kategori dağılımı, ürün arama ve eşik bazlı alarm özellikleri sunar.

---

## Özellikler

- **CSV Yükleme**: 50 MB'a kadar CSV dosyası ile dönemsel tüketim verisi içe aktarma (yeniden yükleme / üzerine yazma desteği).
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
| Dosya İşleme | Multer, csv-parse |

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
| `POST` | `/api/upload` | CSV dosyası yükler (form-data: `csv`) |
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
- `tarih_str`: `YYYY-MM` formatında (örn. `2025-04`)
- Aynı `tarih_str + tip` ile yeniden yükleme yapıldığında mevcut kayıtlar silinip yenileri eklenir.

---

## Veritabanı Şeması

`fb_cost` şeması altında iki tablo bulunur:

- `fb_cost.tuketim` — tüketim verilerinin ana tablosu
- `fb_cost.alarm_esikleri` — alarm eşik tanımları

Detaylar için `migrate.sql` dosyasına bakın.

---

## Lisans

Özel (Proprietary) — Voyage Sorgun iç kullanımı.
# cost
