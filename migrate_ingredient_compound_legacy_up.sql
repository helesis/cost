-- Eski Compound / tb_inglist + tb_nutvalue verileri için staging tablosu.
-- içe aktarma: python -m nutrition_service.import_compound_legacy --sql-file=/path/to/1779714761656_compounds.sql
CREATE TABLE IF NOT EXISTS fb_cost.ingredient_compound_legacy (
  ing_no BIGINT PRIMARY KEY,
  ing_name TEXT NOT NULL,
  bes_name TEXT,
  nut_no BIGINT,
  protein NUMERIC(12, 4),
  carboh NUMERIC(12, 4),
  energy_legacy INTEGER,
  water_legacy NUMERIC(12, 4)
);

CREATE INDEX IF NOT EXISTS idx_ingredient_compound_legacy_ing_name_lower
  ON fb_cost.ingredient_compound_legacy (lower(btrim(ing_name)));

COMMENT ON TABLE fb_cost.ingredient_compound_legacy IS
  'Eski bileşik SQL dump (tb_inglist.bes_name = SR/USDA tanımı) — USDA otomatik eşleşme fallback kaynağı';
