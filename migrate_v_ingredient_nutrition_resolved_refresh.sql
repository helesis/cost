-- v_ingredient_nutrition_resolved: stok_no / tip / birim / arama meta kolonları
-- Önkoşul: ingredient_nutrition tablosunda stok_no, tip, birim, son_arama_tarihi, arama_denemesi
--           (migrate_ingredient_nutrition_stok_sync_up.sql ile eklenmiş olmalı)
-- Uygulama: psql … -f migrate_v_ingredient_nutrition_resolved_refresh.sql

DROP FUNCTION IF EXISTS fb_cost.get_ingredient_nutrition(BIGINT);

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
  'Manuel katman doluysa onu (COALESCE ile) yoksa otomatik sütunları döndürür; stok_no/tip/birim/arama meta dahil';

CREATE OR REPLACE FUNCTION fb_cost.get_ingredient_nutrition(p_urun_id BIGINT)
RETURNS SETOF fb_cost.v_ingredient_nutrition_resolved
LANGUAGE SQL
STABLE
AS $$
  SELECT v.*
  FROM fb_cost.v_ingredient_nutrition_resolved v
  WHERE v.urun_id = p_urun_id;
$$;

COMMENT ON FUNCTION fb_cost.get_ingredient_nutrition(BIGINT) IS
  'Tek hammadde id (ingredient_nutrition.id) için çözümlenmiş besin satırı';
