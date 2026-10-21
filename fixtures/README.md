# Fixtures

Sample sheets and photos for the first demo import, local runs and the scale test. The three sheets are slices of one real supplier export (11,576 rows) and `photos.zip` is that supplier's photo folder, so **any sheet can be uploaded with the same zip** and photos attach by SKU.

| File | Rows | What it is |
|---|---|---|
| `small-20.csv` | 20 | 7 products: complete rows of photo-matched base SKUs, multi-variant families first. All 7 products get a photo. First demo import. |
| `messy-500.xlsx` | 500 | Real rows chosen for mess, German headers on **line 4** under two title rows. 365 products, 107 of them with a photo. |
| `bulk-10000.csv` | 10,000 | Every row whose base SKU has a photo, then the rest of the export in sheet order. 3,447 products; 1,409 photos attach. Scale / restart demo. |
| `photos.zip` | 1,437 photos | 1,412 product photos named by base SKU, plus deliberate edge cases: 15 `OLD-*` and 5 `MISC-*` orphans, `BROKEN-001.jpg` (a text file), `SPEC-001.jpg` (a PDF) and three 4,200×3,000 `BIG-*` photos. |

## What is messy in the export (all real, nothing injected)

- Missing fields: 618 rows have no price, 202 no name, 423 no size, 912 no weight.
- Prices mix `23,49 €`, `$14.47`, `EUR 43,99`, `£23.96`, `GBP 23.79`, `1.299,00 €` and bare `35.86`.
- Units mix g / kg / lbs and cm / inch.
- 1,524 duplicate SKUs; rows for one product are split across variants and out of order.
- 3,507 descriptions contain HTML; one is 93,660 characters (kept in `bulk-10000.csv`, because XLSX cells stop at 32,767).
- Colour typos: `terracota`, `antracite`, `blak`.
- Some product names are German (`Modern Aufbewahrungskorb`), and the messy sample exports with German headers.

## How the slices were cut

- `small-20.csv`: complete rows (name, size, price, material) of photo-matched base SKUs that have 2–3 variants, families with supplier notes first.
- `messy-500.xlsx`: the first 500 rows scoring ≥3 on missing price/name/size/material, non-EUR currency, thousands-separator prices, lbs/oz weights, inch sizes, HTML descriptions, >2,000-char descriptions, colour typos, duplicate SKUs.
- `bulk-10000.csv`: all rows whose base SKU has a photo, then the remaining rows in sheet order up to 10,000.

The full 11,576-row export is not tracked (supplier data); these slices are what ships. Anything over **10,000 rows** is rejected by design with `TOO_MANY_ROWS`.

## Photo matching notes

- Photos are named by base SKU — `CHR-1071.jpg` matches every variant `CHR-1071-*`; a trailing `-2` is a second photo of the same product. Photos can also match through the sheet's `Image File` column.
- The folder is real but repetitive: 1,437 filenames map to **93 unique images** (the supplier reused stock photos across SKUs). Every filename is still an asset and matches its own row; storage keeps one copy per image.
- `small-20` and `messy-500` do not contain every product the photo folder covers, so their imports list the remaining photos as **orphan photos** with a reason. `bulk-10000` includes every photo-matched product: 1,409 of 1,437 photos attach, and only the 25 junk files plus 3 strays are orphaned.
- Ambiguous or unmatched photos are never attached by guesswork; they are reported in the import.
