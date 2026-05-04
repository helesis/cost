-- Ürün sınıflandırma (Ollama / LLM) — fb_cost şeması
-- Çalıştırın: psql -U postgres -d voyagestars -f migrate_product_classifications.sql

CREATE TABLE IF NOT EXISTS fb_cost.product_classifications (
  id              BIGSERIAL PRIMARY KEY,
  stok_mali       TEXT NOT NULL,
  kategori        TEXT,
  kategori_norm   TEXT GENERATED ALWAYS AS (COALESCE(kategori, '')) STORED,
  protein_bucket  TEXT NOT NULL,
  food_group      TEXT NOT NULL,
  confidence      TEXT NOT NULL,
  gerekce         TEXT,
  notes           TEXT,
  model_name      TEXT,
  prompt_version  TEXT,
  raw_response    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT product_classifications_unique UNIQUE (stok_mali, kategori_norm)
);

CREATE INDEX IF NOT EXISTS idx_product_classifications_stok ON fb_cost.product_classifications (stok_mali);

COMMENT ON TABLE fb_cost.product_classifications IS 'LLM ile stok_mali+kategori için protein_bucket ve food_group';

-- Manuel / CSV ile eklenen, tüketimde henüz olmayan çiftler
CREATE TABLE IF NOT EXISTS fb_cost.product_classify_queue (
  id              BIGSERIAL PRIMARY KEY,
  stok_mali       TEXT NOT NULL,
  kategori        TEXT,
  kategori_norm   TEXT GENERATED ALWAYS AS (COALESCE(kategori, '')) STORED,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT product_classify_queue_unique UNIQUE (stok_mali, kategori_norm)
);
