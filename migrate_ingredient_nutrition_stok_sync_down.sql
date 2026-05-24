-- migrate_ingredient_nutrition_stok_sync_up.sql geri alması

DROP VIEW IF EXISTS fb_cost.v_ingredient_nutrition_resolved;

CREATE VIEW fb_cost.v_ingredient_nutrition_resolved AS
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

DROP INDEX IF EXISTS fb_cost.idx_ingredient_nutrition_stok_no;

ALTER TABLE fb_cost.ingredient_nutrition
  DROP CONSTRAINT IF EXISTS ingredient_nutrition_stok_no_unique;

ALTER TABLE fb_cost.ingredient_nutrition
  DROP COLUMN IF EXISTS arama_denemesi,
  DROP COLUMN IF EXISTS son_arama_urun_adi,
  DROP COLUMN IF EXISTS son_arama_tarihi,
  DROP COLUMN IF EXISTS birim,
  DROP COLUMN IF EXISTS tip,
  DROP COLUMN IF EXISTS stok_no;

-- urun_adi unique geri (çift ad varsa başarısız olabilir)
ALTER TABLE fb_cost.ingredient_nutrition
  DROP CONSTRAINT IF EXISTS ingredient_nutrition_urun_adi_unique;

ALTER TABLE fb_cost.ingredient_nutrition
  ADD CONSTRAINT ingredient_nutrition_urun_adi_unique UNIQUE (urun_adi);
