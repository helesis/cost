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
├── migrate_add_grup_column.sql     # Sadece `grup` sütunu ekler (eski kurulumlar)
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

2. Veritabanı şemasını oluşturun. **`migrate.sql` `fb_cost.tuketim` tablosunu `DROP` edip yeniden oluşturur**; üretimde mevcut satırlar silinir. Yedek almadan çalıştırmayın. Sıfır kurulumda:

   ```bash
   psql -U postgres -d cost_analysis -f migrate.sql
   ```

   Üretimde yalnızca sütun eklemek için `migrate_add_grup_column.sql` gibi hedefli dosyaları tercih edin; tam şema taşıması için `migrate_v2_tuketim_computed.sql` (bir kez, yedekli) kullanın.

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

Ortam değişkenleri `src/index.js` içinde `dotenv` ile okunur (proje kökünde `.env`). Tanımlı değilse kod içi varsayılanlar kullanılır:

| Parametre | Ortam değişkeni | Kod varsayılanı |
| --- | --- | --- |
| Host | `DB_HOST` | `127.0.0.1` |
| Port (DB) | `DB_PORT` | `5432` |
| Database | `DB_NAME` | `voyagestars` |
| User | `DB_USER` | `postgres` |
| Password | `DB_PASSWORD` | `postgres` |
| App Port | `PORT` | `3010` |

Üretimde sık görülen örnek: `DB_NAME=cost_analysis`, `DB_USER=cost`, `DB_PORT=5434` (PostgreSQL Docker konteynerinin host’a map ettiği port; uygulama ile **aynı** portu kullanın).

---

## Üretim sunucusu (notlar)

- Uygulama örnek dizin: `/var/www/cost-analysis`. Kod güncellemesi: `git pull`, ardından süreç yöneticisiyle yeniden başlatma (ör. `pm2 restart <uygulama_adı>`).
- **PostgreSQL çoğu kurulumda Docker’da** çalışır (ör. konteyner adı `cost-analysis-db`, host’ta `127.0.0.1:5434` → konteyner `5432`). Aynı makinede başka bir Postgres örneği `5432` kullanıyor olabilir. **`psql` veya GUI ile bağlanırken mutlaka `.env` içindeki `DB_PORT` değerini kullanın** (`-p 5434`); aksi halde yanlış veritabanı örneğine gidip “password authentication failed” alırsınız.
- Komut satırından migrate: `psql` **yalnızca `PGPASSWORD`** okur; `.env` içindeki `DB_PASSWORD` otomatik gitmez. `.env` yüklendikten sonra eşleştirin:

  ```bash
  cd /var/www/cost-analysis
  set -a && source .env && set +a
  export PGPASSWORD="$DB_PASSWORD"
  psql -h 127.0.0.1 -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f ./migrate.sql
  ```

  `.env` satırında Windows satır sonu (`^M`) varsa parolaya `\r` karışabilir; sorun yaşarsanız `dos2unix .env` veya editörden LF kullanın. **`migrate.sql` çalıştıktan sonra** `fb_cost.tuketim` satır sayısını kontrol edin; beklenmedik şekilde boşaldıysa veriyi Excel/CSV ile yeniden yükleyin.
- Konteyner içinde süper kullanıcı (`postgres`) ile bakım için (konteyner ve compose’daki `POSTGRES_PASSWORD` sizin ortamınıza göre):

  ```bash
  docker exec -it cost-analysis-db psql -U postgres -d cost_analysis -c '\du'
  ```
- SQL dosyasını yerel makineden sunucuya aktarmak için örnek: `scp migrate.sql kullanici@sunucu:/var/www/cost-analysis/` (SSH kullanıcı ve host kendi ortamınıza göre).

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
- **grup**: Liste başlığı (stok malı başında rakam veya bölüm metni, stok no yok / tutar yok); alt ürün satırlarına `grup` + `kategori` olarak yazılır; toplam ürün satırı değildir.
- **Fiyat farkı / ödenmez toplamı**: Sayfanın **son ~45 satırında** aranır; tutar TL toplanıp **negatif düzeltme satırı** olarak veri tabanına eklenir (toplam tüketimden düşer).

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

## Sunucuda çalıştırma

Örnek kurulum dizini: `/var/www/cost-analysis`. Veritabanı (Docker) ayakta ve `.env` doğru (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, gerekiyorsa `PORT`, `JWT_SECRET`, vb.) olmalı.

1. **Güncelleme ve bağımlılık**

   ```bash
   cd /var/www/cost-analysis
   git pull
   npm install --omit=dev
   ```

2. **Doğrudan Node (ön planda test)**

   ```bash
   cd /var/www/cost-analysis
   npm start
   ```

   Varsayılan dinleme: `http://0.0.0.0:3010` (`PORT` ile değişir). Durdurmak için `Ctrl+C`.

3. **PM2 ile sürekli çalışma (önerilen)**

   İlk kez:

   ```bash
   cd /var/www/cost-analysis
   pm2 start src/index.js --name cost-analysis --cwd /var/www/cost-analysis
   pm2 save
   ```

   Kod veya `.env` değişince:

   ```bash
   pm2 restart cost-analysis
   ```

   Log ve durum: `pm2 logs cost-analysis`, `pm2 status`.

4. **Ön koşullar**

   - PostgreSQL konteyneri çalışıyor olmalı (`docker ps` ile `cost-analysis-db` veya sizin compose adınız).
   - Sunucuda güvenlik duvarı / ters vekil (nginx, Caddy, …) kullanıyorsanız dışarıya genelde 80/443 açılır; uygulama 3010’da dinliyorsa vekil bu porta `proxy_pass` yapmalıdır.

---

## Lisans

Özel (Proprietary) — Voyage Sorgun iç kullanımı.
