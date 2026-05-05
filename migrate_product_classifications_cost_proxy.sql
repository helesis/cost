-- Menu engineering: LLM maliyet proxy (HIGH|MEDIUM|LOW), product_classifications üzerinde
-- Çalıştırın: psql -U postgres -d voyagestars -f migrate_product_classifications_cost_proxy.sql

ALTER TABLE fb_cost.product_classifications
  ADD COLUMN IF NOT EXISTS cost_proxy TEXT;

COMMENT ON COLUMN fb_cost.product_classifications.cost_proxy IS 'Menu engineering maliyet proxy: HIGH, MEDIUM, LOW (LLM); boşsa keyword fallback';
