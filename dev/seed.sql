-- LOCAL DEVELOPMENT DATA ONLY. Apply after dev/schema.sql to a local database.
-- These are demonstration products, not the shop's actual catalogue.
-- Reapplying the seed preserves existing demo rows and their stock/settings.
-- Prices follow the current application's integer-hryvnia convention.

INSERT INTO products (
  id, name, description, category, price, sale_price, stock, track_stock, active
)
VALUES
  (
    'demo-manga',
    'Демо: манґа для перевірки магазину',
    'Демонстраційний товар локального середовища. Акційна ціна та облік залишку; фотографії не потрібні.',
    'Манґа',
    320, 280, 5, 1, 1
  ),
  (
    'demo-figure',
    'Демо: фігурка без залишку',
    'Демонстраційний товар локального середовища для перевірки стану «Немає в наявності».',
    'Фігурки',
    890, NULL, 0, 1, 1
  ),
  (
    'demo-pin',
    'Демо: значок без обліку залишку',
    'Демонстраційний товар локального середовища для перевірки покупки без складського обліку.',
    'Аксесуари',
    120, NULL, 0, 0, 1
  )
ON CONFLICT(id) DO NOTHING;
