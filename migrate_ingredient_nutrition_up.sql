-- USDA / besin değeri eşleştirme tabloları (fb_cost)
-- Uygulama: psql -h … -p … -U … -d … -f migrate_ingredient_nutrition_up.sql
-- Geri alma: migrate_ingredient_nutrition_down.sql

-- ── Yardımcı: updated_at ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fb_cost.ingredient_nutrition_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

-- ── Hammadde başına otomatik eşleştirme + USDA besin özeti ───────────────────
CREATE TABLE IF NOT EXISTS fb_cost.ingredient_nutrition (
  id                    BIGSERIAL PRIMARY KEY,
  urun_adi              TEXT NOT NULL,
  temiz_arama_terimi    TEXT,
  tuketim_miktari       NUMERIC,
  usda_alternatifleri   JSONB,
  usda_fdc_id           BIGINT,
  usda_adi              TEXT,
  usda_data_type        TEXT,
  protein               NUMERIC,
  yag                   NUMERIC,
  karbonhidrat          NUMERIC,
  enerji                NUMERIC,
  su                    NUMERIC,
  sodyum                NUMERIC,
  potasyum              NUMERIC,
  kalsiyum              NUMERIC,
  demir                 NUMERIC,
  magnezyum             NUMERIC,
  fosfor                NUMERIC,
  cinko                 NUMERIC,
  guven_skoru           SMALLINT CHECK (guven_skoru IS NULL OR (guven_skoru BETWEEN 0 AND 100)),
  eslesme_durumu        TEXT NOT NULL DEFAULT 'eslesmedi'
    CHECK (eslesme_durumu IN ('otomatik','kontrol_gerekli','eslesmedi','manuel_onayli')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ingredient_nutrition_urun_adi_unique UNIQUE (urun_adi)
);

CREATE INDEX IF NOT EXISTS idx_ingredient_nutrition_eslesme
  ON fb_cost.ingredient_nutrition (eslesme_durumu);
CREATE INDEX IF NOT EXISTS idx_ingredient_nutrition_tuketim
  ON fb_cost.ingredient_nutrition (tuketim_miktari DESC NULLS LAST);

DROP TRIGGER IF EXISTS trg_ingredient_nutrition_updated ON fb_cost.ingredient_nutrition;
CREATE TRIGGER trg_ingredient_nutrition_updated
  BEFORE UPDATE ON fb_cost.ingredient_nutrition
  FOR EACH ROW EXECUTE PROCEDURE fb_cost.ingredient_nutrition_touch_updated_at();

COMMENT ON TABLE fb_cost.ingredient_nutrition IS 'Hammadde USDA eşlemesi ve 100 g başına besin (otomatik/script); manuel katman ingredient_nutrition_manual';
COMMENT ON COLUMN fb_cost.ingredient_nutrition.usda_alternatifleri IS 'İsteğe bağlı [{fdcId, description, …}] otomatik eşleştirici adayları';
COMMENT ON COLUMN fb_cost.ingredient_nutrition.protein IS 'g / 100g';
COMMENT ON COLUMN fb_cost.ingredient_nutrition.enerji IS 'kcal / 100g';

-- ── Manuel seçim — otomatik sütunları EZMEz ─────────────────────────────────
CREATE TABLE IF NOT EXISTS fb_cost.ingredient_nutrition_manual (
  id                    BIGSERIAL PRIMARY KEY,
  ingredient_id        BIGINT NOT NULL REFERENCES fb_cost.ingredient_nutrition(id) ON DELETE CASCADE,
  manuel_usda_fdc_id   BIGINT,
  manuel_usda_adi      TEXT,
  protein               NUMERIC,
  yag                   NUMERIC,
  karbonhidrat          NUMERIC,
  enerji                NUMERIC,
  su                    NUMERIC,
  sodyum                NUMERIC,
  potasyum              NUMERIC,
  kalsiyum              NUMERIC,
  demir                 NUMERIC,
  magnezyum             NUMERIC,
  fosfor                NUMERIC,
  cinko                 NUMERIC,
  kaynak                TEXT NOT NULL CHECK (kaynak IN ('usda','turkomp','elle')),
  secen_kullanici       TEXT,
  secim_tarihi          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  not_metni             TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ingredient_nutrition_manual_ingredient
  ON fb_cost.ingredient_nutrition_manual (ingredient_id);

COMMENT ON COLUMN fb_cost.ingredient_nutrition_manual.not_metni IS 'Opsiyonel açıklama (SQL NOT anahtarı değil)';
COMMENT ON COLUMN fb_cost.ingredient_nutrition_manual.protein IS 'g / 100g; kaynak elle/turkomp/usda(API) için manuel katman';

-- ── Tek noktadan okuma görünümü (manuel öncelikli) ──────────────────────────
CREATE OR REPLACE VIEW fb_cost.v_ingredient_nutrition_resolved AS
SELECT
  n.id AS urun_id,
  n.urun_adi,
  n.temiz_arama_terimi,
  n.tuketim_miktari,
  n.eslesme_durumu,
  (m.id IS NOT NULL) AS manuel_override_var,
  COALESCE(m.kaynak::text, CASE
    WHEN n.usda_fdc_id IS NOT NULL AND n.eslesme_durumu IN ('otomatik','kontrol_gerekli','manuel_onayli')
      THEN 'otomatik'::text
    ELSE NULL::text
  END) AS veri_kaynagi,
  COALESCE(m.manuel_usda_fdc_id, n.usda_fdc_id) AS usda_fdc_id,
  COALESCE(m.manuel_usda_adi, n.usda_adi) AS usda_adi,
  n.usda_data_type AS usda_data_type,
  COALESCE(m.protein, n.protein) AS protein,
  COALESCE(m.yag, n.yag) AS yag,
  COALESCE(m.karbonhidrat, n.karbonhidrat) AS karbonhidrat,
  COALESCE(m.enerji, n.enerji) AS enerji,
  COALESCE(m.su, n.su) AS su,
  COALESCE(m.sodyum, n.sodyum) AS sodyum,
  COALESCE(m.potasyum, n.potasyum) AS potasyum,
  COALESCE(m.kalsiyum, n.kalsiyum) AS kalsiyum,
  COALESCE(m.demir, n.demir) AS demir,
  COALESCE(m.magnezyum, n.magnezyum) AS magnezyum,
  COALESCE(m.fosfor, n.fosfor) AS fosfor,
  COALESCE(m.cinko, n.cinko) AS cinko,
  n.usda_alternatifleri,
  n.guven_skoru,
  n.created_at,
  n.updated_at,
  m.secim_tarihi AS manuel_secim_tarihi,
  m.secen_kullanici AS manuel_secen_kullanici
FROM fb_cost.ingredient_nutrition n
LEFT JOIN fb_cost.ingredient_nutrition_manual m ON m.ingredient_id = n.id;

COMMENT ON VIEW fb_cost.v_ingredient_nutrition_resolved IS 'Manuel katman doluysa onu (COALESCE ile) yoksa otomatik sütunları döndürür — matris/analiz bu görünümü kullanır';

-- ── SQL fonksiyon (tek kayıt): get_ingredient_nutrition(urun_id) ─────────────
CREATE OR REPLACE FUNCTION fb_cost.get_ingredient_nutrition(p_urun_id BIGINT)
RETURNS SETOF fb_cost.v_ingredient_nutrition_resolved
LANGUAGE SQL
STABLE
AS $$
  SELECT v.*
  FROM fb_cost.v_ingredient_nutrition_resolved v
  WHERE v.urun_id = p_urun_id;
$$;

COMMENT ON FUNCTION fb_cost.get_ingredient_nutrition(BIGINT) IS 'Tek hammadde id (ingredient_nutrition.id) için çözümlenmiş besin satırı; uygulamalar doğrudan tablo yerine bunu kullanır';
