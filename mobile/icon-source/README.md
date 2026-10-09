# Esblu app ikona — FINÁLNA MASTER (2026-10-09)

| Položka | Hodnota |
|---|---|
| Súbor | `esblu-master-icon.png` (1254 × 1254, RGB): modrá dlaždica, biely symbol, text „Esblu“ |
| Stav | schválená vlastníkom ako finálna |
| Pravidlo | **nemeniť**; všetky natívne assety sa generujú iba z neho |

```bash
python3 scripts/generate-mobile-assets.py icon   --source mobile/icon-source/esblu-master-icon.png
python3 scripts/generate-mobile-assets.py splash --source mobile/icon-source/esblu-master-icon.png
```

## Výstup (zapojené)

- **iOS AppIcon:** `AppIcon-512@2x.png` (1024, bez alfa).
- **iOS splash:** `Splash.imageset`.
- **Android legacy:** `mipmap-*/ic_launcher.png` a `ic_launcher_round.png`.
- **Android adaptive:**
  - `mipmap-*/ic_launcher_foreground.png` = master zmenšený na 0.74 do 66dp safe kruhu (biely symbol a text siahajú do polomeru 0.41);
  - pozadie biele (`values/ic_launcher_background.xml`), rovnaké ako okraj mastra.
- **Android splash:** `drawable*/splash.png`.
- **Android notifikačná ikona:**
  - `drawable-*/ic_stat_esblu.png` = iba biely symbol bez textu, monochrómna silueta;
  - v manifeste ako `default_notification_icon` s akcentom `#0181FD` z mastra.

## Kontrola

`proposals/legibility-preview.png` ukazuje launcher veľkosti, kruhovú a squircle masku a notifikačnú ikonu.

- Text „Esblu“ je čitateľný od 72 px a pri 48 px rozpoznateľný.
- Pri 29 px (iOS Settings) je čitateľný iba symbol.
