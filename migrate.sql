-- cost_analysis schema ve tuketim (türetilmiş tutar/pp sütunları)
-- Sıfır kurulum: tüm .sql'yi uygulayın.
-- Mevcut tuketim verisini korumak için: migrate_v2_tuketim_computed.sql
--
-- Çalıştır: psql -U postgres -d cost_analysis -f migrate.sql
-- (ve önce: CREATE DATABASE cost_analysis; gerekirse)

CREATE SCHEMA IF NOT EXISTS fb_cost;

-- Formül yardımcıları (fb_cost_functions.sql ile aynı; tek dosyada çalışsın diye gömülü)
CREATE OR REPLACE FUNCTION fb_cost.tuketim_tutar_tl(
  p_tip      TEXT,
  p_tuk      NUMERIC,
  p_birim    NUMERIC
) RETURNS NUMERIC
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT
    (CASE
      WHEN p_tip = 'yiyecek' THEN (COALESCE(p_tuk, 0) / 1000.0) * COALESCE(p_birim, 0)
      WHEN p_tip IN ('icenek', 'icecek') THEN COALESCE(p_tuk, 0) * COALESCE(p_birim, 0)
      ELSE COALESCE(p_tuk, 0) * COALESCE(p_birim, 0)
    END)::NUMERIC
$$;

CREATE OR REPLACE FUNCTION fb_cost.tuketim_tutar_eur(
  p_tip   TEXT,
  p_tuk   NUMERIC,
  p_birim NUMERIC,
  p_kur   NUMERIC
) RETURNS NUMERIC
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT
    CASE
      WHEN COALESCE(p_kur, 0) > 0
      THEN fb_cost.tuketim_tutar_tl(p_tip, p_tuk, p_birim) / p_kur
      ELSE 0::NUMERIC
    END
$$;

CREATE OR REPLACE FUNCTION fb_cost.tuketim_pp_tl(
  p_tip      TEXT,
  p_tuk      NUMERIC,
  p_birim    NUMERIC,
  p_cost_pax NUMERIC
) RETURNS NUMERIC
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT
    CASE
      WHEN COALESCE(p_cost_pax, 0) > 0
      THEN fb_cost.tuketim_tutar_tl(p_tip, p_tuk, p_birim) / p_cost_pax
      ELSE 0::NUMERIC
    END
$$;

CREATE OR REPLACE FUNCTION fb_cost.tuketim_pp_eur(
  p_tip      TEXT,
  p_tuk      NUMERIC,
  p_birim    NUMERIC,
  p_kur      NUMERIC,
  p_cost_pax NUMERIC
) RETURNS NUMERIC
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT
    CASE
      WHEN COALESCE(p_kur, 0) > 0 AND COALESCE(p_cost_pax, 0) > 0
      THEN fb_cost.tuketim_tutar_tl(p_tip, p_tuk, p_birim) / p_kur / p_cost_pax
      ELSE 0::NUMERIC
    END
$$;

CREATE OR REPLACE FUNCTION fb_cost.tuketim_pp_gr(
  p_tip      TEXT,
  p_tuk      NUMERIC,
  p_cost_pax NUMERIC
) RETURNS NUMERIC
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT
    CASE
      WHEN p_tip = 'yiyecek' AND COALESCE(p_cost_pax, 0) > 0
      THEN (COALESCE(p_tuk, 0) / p_cost_pax)::NUMERIC
      ELSE 0::NUMERIC
    END
$$;

CREATE OR REPLACE FUNCTION fb_cost.tuketim_pp_cl(
  p_tip      TEXT,
  p_tuk      NUMERIC,
  p_cost_pax NUMERIC
) RETURNS NUMERIC
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT
    CASE
      WHEN p_tip IN ('icenek', 'icecek') AND COALESCE(p_cost_pax, 0) > 0
      THEN ((COALESCE(p_tuk, 0) * 100) / p_cost_pax)::NUMERIC
      ELSE 0::NUMERIC
    END
$$;

-- UYARI: Aşağıdaki DROP, tüketim satırlarını siler. Veriyi koruyun veya yedeği alın.
DROP TABLE IF EXISTS fb_cost.tuketim CASCADE;

CREATE TABLE fb_cost.tuketim (
  id              SERIAL PRIMARY KEY,
  dosya           TEXT,
  tip             TEXT NOT NULL,          -- 'yiyecek' | 'icenek'
  tarih_str       TEXT NOT NULL,          -- '2025-04' | '2025-04-15g'
  yil             INTEGER NOT NULL,
  ay_no           INTEGER NOT NULL,
  ay              TEXT,
  gun             INTEGER,
  cost_pax        NUMERIC,                -- misafir sayısı (pax)
  kur             NUMERIC,                 -- TL cinsinden: 1 EUR = kur TL
  kategori        TEXT,
  grup            TEXT,
  stok_mali       TEXT NOT NULL,
  stok_no         TEXT,
  birim           TEXT,
  tuk_miktar      NUMERIC NOT NULL DEFAULT 0,  -- yiyecek: gram, icenek: litre
  birim_fiyat     NUMERIC NOT NULL DEFAULT 0,   -- yiyecek: TL/kg, icenek: TL/lt
  yukleme_zamani  TIMESTAMPTZ DEFAULT NOW(),

  tutar_tl  NUMERIC GENERATED ALWAYS AS (fb_cost.tuketim_tutar_tl(tip, tuk_miktar, birim_fiyat)) STORED,
  tutar_eur NUMERIC GENERATED ALWAYS AS (fb_cost.tuketim_tutar_eur(tip, tuk_miktar, birim_fiyat, kur)) STORED,
  pp_tl     NUMERIC GENERATED ALWAYS AS (fb_cost.tuketim_pp_tl(tip, tuk_miktar, birim_fiyat, cost_pax)) STORED,
  pp_eur    NUMERIC GENERATED ALWAYS AS (fb_cost.tuketim_pp_eur(tip, tuk_miktar, birim_fiyat, kur, cost_pax)) STORED,
  pp_gr     NUMERIC GENERATED ALWAYS AS (fb_cost.tuketim_pp_gr(tip, tuk_miktar, cost_pax)) STORED,
  pp_cl     NUMERIC GENERATED ALWAYS AS (fb_cost.tuketim_pp_cl(tip, tuk_miktar, cost_pax)) STORED
);

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
