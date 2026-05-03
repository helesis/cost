-- Mevcut kurulum: tuketim tablosuna grup sütunu (grup başlığı / liste grubu)
ALTER TABLE fb_cost.tuketim ADD COLUMN IF NOT EXISTS grup TEXT;
