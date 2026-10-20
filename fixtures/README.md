# Fixtures

Generated deterministically by `bun run fixtures` (`scripts/gen-fixtures.ts`). Same seed → same files.

| File | Rows | What's messy |
|---|---|---|
| `small-20.csv` | 20 | Light mess. Use it for the first demo import. |
| `messy-500.xlsx` | 500 | German headers (`Artikelnummer`, `Preis`, `Größe`…) on **line 4** under two title rows. Every kind of mess below, at high rates. |
| `bulk-10000.csv` | 10,000 | English headers, moderate mess. ~4,000 products. Use it for the scale/restart demo. |
| `photos.zip` | 36 photos + junk | Named by SKU (`TC-PL-20.jpg`, `gc-pt-15-blu_1.jpg`). Includes 4 orphans (`unknown-item-*.jpg`), 1 corrupt file and a `__MACOSX/` resource-fork entry. |
| `ground-truth.json` | 21 templates | Expected category, material, allowed and forbidden claims per base product |

Kinds of mess generated:
- Prices: `1.299,00 €`, `24,99 €`, `€24.99`, `EUR 24`, `24,-`, `12.5`, `£21`, or missing. Some conflicting duplicates (same SKU, two prices).
- Units: `20 cm`, `20cm`, `7.9"`, `200 mm`, `Ø 20 cm`; `1800 g`, `1,8 kg`, `4 lbs`.
- Colours: typos (`terracota`, `antracite`, `natrual`), German names (`blau`, `grün`), random capitalisation.
- Rows:
  - exact duplicates
  - split rows (a second row with only SKU + notes)
  - shuffled so a product's rows are far apart
- Text:
  - German supplier notes (`frostbeständig (nicht frostfest…)`)
  - mojibake (`Â°C`)
  - `<script>` and `onerror=` in descriptions
  - one 9,000-character description
- Claims bait: "frost-resistant (not frost-proof…)", "Water-resistant, not waterproof", "Copper plated (not solid copper)", "Not dishwasher-safe". The AI must not upgrade these to the stronger claim.
