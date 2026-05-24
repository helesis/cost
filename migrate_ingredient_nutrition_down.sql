-- USDA besin eşlemesi yapılarını geri alır — migrate_ingredient_nutrition_up.sql tersine
-- psql … -f migrate_ingredient_nutrition_down.sql

DROP TRIGGER IF EXISTS trg_ingredient_nutrition_updated ON fb_cost.ingredient_nutrition;

DROP FUNCTION IF EXISTS fb_cost.get_ingredient_nutrition(BIGINT);

DROP VIEW IF EXISTS fb_cost.v_ingredient_nutrition_resolved;

DROP TABLE IF EXISTS fb_cost.ingredient_nutrition_manual;
DROP TABLE IF EXISTS fb_cost.ingredient_nutrition;

DROP FUNCTION IF EXISTS fb_cost.ingredient_nutrition_touch_updated_at();
