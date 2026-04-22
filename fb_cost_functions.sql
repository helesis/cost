-- fb_cost: tutar / pp formülleri (tek kaynak: tip, tuk_miktar, birim_fiyat, kur, cost_pax)
-- yiyecek: tuk_miktar = gram, birim_fiyat = TL/kg  →  tutar = (g/1000) * fiyat
-- icenek:  tuk_miktar = litre, birim_fiyat = TL/lt → tutar = lt * fiyat

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

-- icenek: tuk litre → santilitre / pax
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
