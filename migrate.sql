-- cost_analysis schema ve tablo
-- Çalıştır: psql -U postgres -d voyagestars -f migrate.sql

CREATE SCHEMA IF NOT EXISTS fb_cost;

CREATE TABLE IF NOT EXISTS fb_cost.tuketim (
  id            SERIAL PRIMARY KEY,
  dosya         TEXT,
  tip           TEXT NOT NULL,          -- 'yiyecek' | 'icenek'
  tarih_str     TEXT NOT NULL,          -- '2025-04'
  yil           INTEGER NOT NULL,
  ay_no         INTEGER NOT NULL,
  ay            TEXT,
  gun           INTEGER,
  cost_pax      NUMERIC,
  kur           NUMERIC,
  kategori      TEXT,
  stok_mali     TEXT NOT NULL,
  stok_no       TEXT,
  birim         TEXT,
  tuk_miktar    NUMERIC DEFAULT 0,
  birim_fiyat   NUMERIC DEFAULT 0,
  tutar_tl      NUMERIC DEFAULT 0,
  tutar_eur     NUMERIC DEFAULT 0,
  pp_gr         NUMERIC DEFAULT 0,
  pp_cl         NUMERIC DEFAULT 0,
  pp_tl         NUMERIC DEFAULT 0,
  pp_eur        NUMERIC DEFAULT 0,
  yukleme_zamani TIMESTAMPTZ DEFAULT NOW()
);

-- Hızlı sorgu için index
CREATE INDEX IF NOT EXISTS idx_tuketim_tarih   ON fb_cost.tuketim(tarih_str);
CREATE INDEX IF NOT EXISTS idx_tuketim_tip     ON fb_cost.tuketim(tip);
CREATE INDEX IF NOT EXISTS idx_tuketim_stok    ON fb_cost.tuketim(stok_mali);
CREATE INDEX IF NOT EXISTS idx_tuketim_yil_ay  ON fb_cost.tuketim(yil, ay_no);
CREATE INDEX IF NOT EXISTS idx_tuketim_kategori ON fb_cost.tuketim(kategori);

-- OTP kodları tablosu (login sistemi)
CREATE TABLE IF NOT EXISTS fb_cost.otp_kodlari (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL,
  kod           TEXT NOT NULL,
  gecerli_until TIMESTAMPTZ NOT NULL,
  kullanildi    BOOLEAN DEFAULT FALSE,
  ip_adresi     TEXT,
  olusturma     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_otp_email ON fb_cost.otp_kodlari(email);
CREATE INDEX IF NOT EXISTS idx_otp_gecerli ON fb_cost.otp_kodlari(gecerli_until);

-- Alarm eşikleri tablosu
CREATE TABLE IF NOT EXISTS fb_cost.alarm_esikleri (
  id          SERIAL PRIMARY KEY,
  ad          TEXT NOT NULL,
  tip         TEXT,                     -- 'yiyecek' | 'icenek' | NULL (ikisi de)
  metrik      TEXT NOT NULL,            -- 'pp_tl' | 'pp_eur' | 'pp_gr' | 'pp_cl' | 'tutar_tl'
  kategori    TEXT,                     -- NULL = tüm kategoriler
  stok_mali   TEXT,                     -- NULL = kategori geneli
  esik_deger  NUMERIC NOT NULL,
  yon         TEXT NOT NULL DEFAULT 'yukari', -- 'yukari' | 'asagi'
  aktif       BOOLEAN DEFAULT TRUE,
  olusturma   TIMESTAMPTZ DEFAULT NOW()
);
