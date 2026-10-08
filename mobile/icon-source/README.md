# Esblu app ikona — schválená MASTER (2026-10-09)

| Položka | Hodnota |
|---|---|
| Súbor | `esblu-master-icon.png` (1254 × 1254, RGB) |
| Stav | schválená vlastníkom |
| Pravidlo | **nemeniť**; všetky natívne ikony sa generujú iba z neho |

```bash
python3 scripts/generate-mobile-assets.py icon --source mobile/icon-source/esblu-master-icon.png
```

## Výstup

- **iOS:** `AppIcon.appiconset/AppIcon-512@2x.png` (1024, bez alfa kanála).
- **Android legacy (API 24–25):** `mipmap-*/ic_launcher.png` a `ic_launcher_round.png` (kruhový výrez celého mastra).
- **Android adaptive (API 26+):** `mipmap-*/ic_launcher_foreground.png` = master zmenšený na 0.77 do safe zóny (obsah siaha do polomeru 0.389, kruhová maska dovolí 0.306). Pozadie je biele (`values/ic_launcher_background.xml`). Artwork sa nemení.

## Návrhy — nezapojené, iba so súhlasom (`proposals/`)

- `ic_stat_esblu-*.png`: monochrómna symbol-only notifikačná ikona. Android status bar ikona musí byť biela silueta; bez nej Android zobrazí sivý štvorec.
- `legibility-preview.png`: náhľad čitateľnosti pri veľkostiach 192 / 144 / 96 / 72 / 48 / 29 px a pod kruhovou adaptive maskou.
  - Text „Esblu“ je čitateľný od 72 px a pri 48 px ešte rozpoznateľný.
  - Pri 29 px (iOS Settings) je čitateľný iba symbol.
