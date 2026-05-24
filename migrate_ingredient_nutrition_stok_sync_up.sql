-- ingredient_nutrition: stok_no tabanlı senkron (tuketim → upsert + USDA arama meta)
-- Uygulama: psql … -f migrate_ingredient_nutrition_stok_sync_up.sql
-- Geri alma: migrate_ingredient_nutrition_stok_sync_down.sql
--
-- Önkoşul: migrate_ingredient_nutrition_up.sql uygulanmış olmalı.

-- Tekillik ada göre değil stok koduna göre
ALTER TABLE fb_cost.ingredient_nutrition
  DROP CONSTRAINT IF EXISTS ingredient_nutrition_urun_adi_unique;

ALTER TABLE fb_cost.ingredient_nutrition
  ADD COLUMN IF NOT EXISTS stok_no              TEXT,
  ADD COLUMN IF NOT EXISTS tip                  TEXT,
  ADD COLUMN IF NOT EXISTS birim                TEXT,
  ADD COLUMN IF NOT EXISTS son_arama_tarihi     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS son_arama_urun_adi   TEXT,
  ADD COLUMN IF NOT EXISTS arama_denemesi       INT NOT NULL DEFAULT 0;

COMMENT ON COLUMN fb_cost.ingredient_nutrition.stok_no IS 'Kaynak fb_cost.tuketim.stok_no — upsert anahtarı';
COMMENT ON COLUMN fb_cost.ingredient_nutrition.tip IS 'yiyecek | icenek (tuketim.tip)';
COMMENT ON COLUMN fb_cost.ingredient_nutrition.birim IS 'kg | L vb. (tuketim.birim)';
COMMENT ON COLUMN fb_cost.ingredient_nutrition.son_arama_tarihi IS 'Son USDA /foods/search denemesi';
COMMENT ON COLUMN fb_cost.ingredient_nutrition.son_arama_urun_adi IS 'Son aramada kullanılan urun_adi (ad değişimi tespiti)';
COMMENT ON COLUMN fb_cost.ingredient_nutrition.arama_denemesi IS 'Toplam USDA arama denemesi sayısı';

-- Önce stok_no'suz satırları temizle (upsert anahtarı zorunlu)
DELETE FROM fb_cost.ingredient_nutrition WHERE stok_no IS NULL;

DROP INDEX IF EXISTS fb_cost.uq_ingredient_nutrition_stok_no;

ALTER TABLE fb_cost.ingredient_nutrition
  DROP CONSTRAINT IF EXISTS ingredient_nutrition_stok_no_unique;

ALTER TABLE fb_cost.ingredient_nutrition
  ADD CONSTRAINT ingredient_nutrition_stok_no_unique UNIQUE (stok_no);

CREATE INDEX IF NOT EXISTS idx_ingredient_nutrition_stok_no
  ON fb_cost.ingredient_nutrition (stok_no);

-- Görünüm: stok_no / tip / birim eklendi
DROP VIEW IF EXISTS fb_cost.v_ingredient_nutrition_resolved;

CREATE VIEW fb_cost.v_ingredient_nutrition_resolved AS
SELECT
  n.id AS urun_id,
  n.stok_no,
  n.urun_adi,
  n.temiz_arama_terimi,
  n.tuketim_miktari,
  n.tip,
  n.birim,
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
  n.son_arama_tarihi,
  n.arama_denemesi,
  n.created_at,
  n.updated_at,
  m.secim_tarihi AS manuel_secim_tarihi,
  m.secen_kullanici AS manuel_secen_kullanici
FROM fb_cost.ingredient_nutrition n
LEFT JOIN fb_cost.ingredient_nutrition_manual m ON m.ingredient_id = n.id;

COMMENT ON VIEW fb_cost.v_ingredient_nutrition_resolved IS
  'Manuel katman doluysa onu döndürür; stok_no/tip/birim tuketim senkronundan gelir';
