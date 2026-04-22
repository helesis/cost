-- Mevcut fb_cost.tuketim → tutar/pp türetilmiş sütunlar (miktar, birim fiyat, kur, cost pax = tek kaynak)
-- Yedek: pg_dump veya tuketim_mig_bak. PostgreSQL 12+.
-- psql -U cost -d cost_analysis -f migrate_v2_tuketim_computed.sql
--
-- İkinci kez çalıştırılırsa hata: "migrate_v2: zaten uygulandı" ve durur (veri korunur).

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

DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'fb_cost' AND table_name = 'tuketim'
  ) THEN
    RAISE EXCEPTION 'migrate_v2: fb_cost.tuketim yok. Önce migrate.sql veya en azından tabloyu oluşturun.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'fb_cost' AND table_name = 'tuketim'
      AND column_name = 'tutar_tl' AND is_generated = 'ALWAYS'
  ) THEN
    RAISE EXCEPTION 'migrate_v2: tuketim zaten yeni şemada. İkinci kez uygulamayın.' USING HINT = 'Beklenmeyense şema yedeğini kontrol edin';
  END IF;
END
$guard$;

CREATE TABLE IF NOT EXISTS fb_cost.tuketim_mig_bak (LIKE fb_cost.tuketim INCLUDING ALL);
TRUNCATE fb_cost.tuketim_mig_bak;
INSERT INTO fb_cost.tuketim_mig_bak SELECT * FROM fb_cost.tuketim;

DROP TABLE IF EXISTS fb_cost.tuketim_new;

CREATE TABLE fb_cost.tuketim_new (
  id              SERIAL PRIMARY KEY,
  dosya           TEXT,
  tip             TEXT NOT NULL,
  tarih_str       TEXT NOT NULL,
  yil             INTEGER NOT NULL,
  ay_no           INTEGER NOT NULL,
  ay              TEXT,
  gun             INTEGER,
  cost_pax        NUMERIC,
  kur             NUMERIC,
  kategori        TEXT,
  stok_mali       TEXT NOT NULL,
  stok_no         TEXT,
  birim           TEXT,
  tuk_miktar      NUMERIC NOT NULL DEFAULT 0,
  birim_fiyat     NUMERIC NOT NULL DEFAULT 0,
  yukleme_zamani  TIMESTAMPTZ DEFAULT NOW(),
  tutar_tl  NUMERIC GENERATED ALWAYS AS (fb_cost.tuketim_tutar_tl(tip, tuk_miktar, birim_fiyat)) STORED,
  tutar_eur NUMERIC GENERATED ALWAYS AS (fb_cost.tuketim_tutar_eur(tip, tuk_miktar, birim_fiyat, kur)) STORED,
  pp_tl     NUMERIC GENERATED ALWAYS AS (fb_cost.tuketim_pp_tl(tip, tuk_miktar, birim_fiyat, cost_pax)) STORED,
  pp_eur    NUMERIC GENERATED ALWAYS AS (fb_cost.tuketim_pp_eur(tip, tuk_miktar, birim_fiyat, kur, cost_pax)) STORED,
  pp_gr     NUMERIC GENERATED ALWAYS AS (fb_cost.tuketim_pp_gr(tip, tuk_miktar, cost_pax)) STORED,
  pp_cl     NUMERIC GENERATED ALWAYS AS (fb_cost.tuketim_pp_cl(tip, tuk_miktar, cost_pax)) STORED
);

INSERT INTO fb_cost.tuketim_new (
  dosya, tip, tarih_str, yil, ay_no, ay, gun, cost_pax, kur, kategori, stok_mali, stok_no, birim,
  tuk_miktar, birim_fiyat, yukleme_zamani
)
SELECT
  o.dosya, o.tip, o.tarih_str, o.yil, o.ay_no, o.ay, o.gun, o.cost_pax, o.kur, o.kategori, o.stok_mali, o.stok_no, o.birim,
  o.tuk_miktar_new, o.birim_fiyat_new, o.yukleme_zamani
FROM (
  SELECT
    t.dosya, t.tip, t.tarih_str, t.yil, t.ay_no, t.ay, t.gun, t.cost_pax, t.kur, t.kategori, t.stok_mali, t.stok_no, t.birim,
    t.yukleme_zamani,
    COALESCE(
      NULLIF(t.tuk_miktar, 0),
      CASE
        WHEN t.tip = 'yiyecek' AND NULLIF(t.birim_fiyat, 0) IS NOT NULL AND COALESCE(t.tutar_tl, 0) > 0
          THEN (t.tutar_tl / t.birim_fiyat) * 1000.0
        WHEN t.tip IN ('icenek', 'icecek') AND NULLIF(t.birim_fiyat, 0) IS NOT NULL AND COALESCE(t.tutar_tl, 0) > 0
          THEN t.tutar_tl / t.birim_fiyat
        ELSE 0
      END,
      CASE
        WHEN COALESCE(t.tutar_tl, 0) > 0 AND COALESCE(t.tuk_miktar, 0) = 0 AND COALESCE(t.birim_fiyat, 0) = 0
             AND t.tip = 'yiyecek'
          THEN t.tutar_tl * 1000.0
        WHEN COALESCE(t.tutar_tl, 0) > 0 AND COALESCE(t.tuk_miktar, 0) = 0 AND COALESCE(t.birim_fiyat, 0) = 0
             AND t.tip IN ('icenek', 'icecek')
          THEN t.tutar_tl
        ELSE 0
      END
    )::NUMERIC AS tuk_miktar_new,
    CASE
      WHEN COALESCE(t.tutar_tl, 0) > 0 AND COALESCE(t.tuk_miktar, 0) = 0 AND COALESCE(t.birim_fiyat, 0) = 0
        THEN 1::NUMERIC
      ELSE COALESCE(t.birim_fiyat, 0)
    END::NUMERIC AS birim_fiyat_new
  FROM fb_cost.tuketim t
) o;

DROP TABLE fb_cost.tuketim;

ALTER TABLE fb_cost.tuketim_new RENAME TO tuketim;

CREATE INDEX IF NOT EXISTS idx_tuketim_tarih   ON fb_cost.tuketim(tarih_str);
CREATE INDEX IF NOT EXISTS idx_tuketim_tip     ON fb_cost.tuketim(tip);
CREATE INDEX IF NOT EXISTS idx_tuketim_stok    ON fb_cost.tuketim(stok_mali);
CREATE INDEX IF NOT EXISTS idx_tuketim_yil_ay  ON fb_cost.tuketim(yil, ay_no);
CREATE INDEX IF NOT EXISTS idx_tuketim_kategori ON fb_cost.tuketim(kategori);
