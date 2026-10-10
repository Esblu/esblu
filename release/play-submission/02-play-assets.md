# 02 — Play Store grafika

Všetko odvodené zo **schválenej** master ikony `mobile/icon-source/esblu-master-icon.png` (1254 px, modrá dlaždica + biely symbol + „Esblu"). Žiadny nový brand smer.

| Asset | Požiadavka Play | Súbor | Stav |
|---|---|---|---|
| App icon | 512×512, 32-bit PNG (alfa), ≤ 1 MB | `release/play-assets/play-icon-512.png` (RGBA, 264 KB) | **hotové** — Play aplikuje vlastnú masku zaoblenia; tenký biely okraj mastra ostane viditeľný v rohoch (vlastník môže schváliť alebo dodať verziu bez okraja) |
| Feature graphic SK | 1024×500, JPG / 24-bit PNG **bez alfa** | `release/play-assets/feature-graphic-1024x500-sk.png` (RGB) | **hotové (draft na schválenie)** — master ikona + text „Firemná evidencia a fakturácia na jednom mieste." (Geist) |
| Feature graphic EN | dtto | `release/play-assets/feature-graphic-1024x500-en.png` | **hotové (draft)** — „Company records and invoicing in one place." |
| Phone screenshots | min. 2 (odporúčané 4–8), JPG/24-bit PNG, strany 320–3840 px, pomer ≤ 2:1; pre odporúčania 1080×1920+ (9:16) | `release/play-assets/screenshots/phone/` | **chýbajú** — vyžadujú reálny capture z appky na demo účte (nevyrábame falošné) |
| Tablet screenshots | voliteľné | — | neodporúčam pre 1.0 |

Generovanie: `python3` + Pillow, zdroj iba master + font Geist (rovnaký ako v appke). Regenerácia: pozri históriu commitu (jednorazový skript nie je súčasť buildu).

## Screenshot shot list (demo účet „Esblu Demo s.r.o.", fiktívne dáta, telefón 1080×2400 alebo 1080×1920)

Naming: `release/play-assets/screenshots/phone/{sk|en}/NN-nazov.png` (24-bit PNG, bez alfa, bez notifikácií/osobných údajov v status bare).

| # | Súbor | Obrazovka | Čo musí byť vidieť |
|---|---|---|---|
| 01 | `01-prehlad.png` | Prehľad (dashboard) | názov demo firmy, moduly, upozornenia na termíny; chat FAB v rohu |
| 02 | `02-inbox-kontrola.png` | Inbox → nahratý doklad → kontrola údajov | AI načítané polia (dodávateľ, suma, dátum) pred potvrdením — tlačidlo „Potvrdiť" viditeľné |
| 03 | `03-vozidlo-detail.png` | Vozidlá → detail | technické údaje, termíny (STK/EK/poistenie), fotka vozidla |
| 04 | `04-stroje.png` | Stroje → zoznam alebo detail | 2–3 fiktívne stroje so servisným záznamom |
| 05 | `05-sklad.png` | Sklad | položky s množstvom a minimálnou zásobou |
| 06 | `06-faktura.png` | Faktúry → detail konceptu/finalizovanej faktúry | fiktívny odberateľ, položky, súčty (žiadny reálny IBAN — použiť fiktívny formátovo platný) |
| 07 | `07-chat.png` | Firemný chat | 3–4 fiktívne správy medzi „Owner" a „Zamestnanec", odkaz na vozidlo |
| 08 | `08-notifikacie.png` (voliteľné) | Nastavenia → Notifikácie | prepínač push zapnutý |

Capture postup: Play-nainštalovaná (internal testing) appka na telefóne → `adb exec-out screencap -p > NN.png` alebo systémový screenshot; skontrolovať, že nie sú viditeľné reálne dáta.
