# 03 — App access / reviewer balík (finálny, 2026-10-11)

**Stav:** pripravené. **Účet NEVYTVORENÝ:** vyžaduje zápis do produkcie a čaká na výslovný súhlas vlastníka.

Bez súhlasu sa nevytvára žiadny produkčný účet, firma, allowlist ani grant.

## 1. Model účtu

| Položka | Hodnota |
|---|---|
| Prihlásenie | `play-review@esblu.com` + heslo (e-mail/heslo, **nie** Google login) |
| 2FA | žiadne (Esblu 2FA nemá; e-mailový OTP sa pri prihlásení nevyžaduje) |
| Rola | **owner** vo vlastnej demo firme: vidí všetky moduly, financie aj nastavenia firmy/tímu, ktoré reviewer musí otvoriť. Zrušenie účtu je v Nastaveniach pre každého používateľa; pri ownerovi preflight navyše chráni firmu (potvrdzovací text) |
| Demo firma | **Esblu Demo s.r.o.** (fiktívna) |
| Druhý člen | `play-review+employee@esblu.com`, rola **employee**. Slúži iba na chatové správy, reviewer sa ním neprihlasuje |
| Heslo | silné, trvalé, uložené iba v Play Console (App access) a v správcovi hesiel vlastníka. **Nikdy v repozitári ani v dokumentoch** |
| Mailbox | `play-review@esblu.com` musí byť doručiteľný (potvrdenie registrácie). Prístup má iba vlastník |

**Bez závislostí:** eFaktúra, billing/predplatné, Stripe/Apple/Google Play Billing, bankové napojenie ani externé 2FA. Nič z toho reviewer nepotrebuje a nič z toho nie je v builde aktívne.

## 2. Nároky firmy (dôležité — inak reviewer narazí na zámky)

Nová firma dostane **14-dňový trial** (`entitlement_catalog`):

| Nárok | Trial |
|---|---|
| vehicles | max 2 |
| machines | max 2 |
| inventory | max 5 |
| team_members | **1** |
| voice | **nie je v triali** |
| ai_documents | 5 |

Review môže trvať dlhšie než 14 dní a ďalšie verzie prechádzajú review znova. Preto demo firma potrebuje **ručné granty** (`company_entitlements`, `source='manual'`, bez `valid_until`):

| Grant | limit_value | Prečo |
|---|---|---|
| `invoicing` | NULL | faktúry, partneri |
| `vehicles` | NULL | 2+ vozidlá bez zámku |
| `machines` | NULL | |
| `inventory` | NULL | 4+ položky |
| `team_members` | 3 | druhý člen pre chat |
| `ai_documents` | 50 / `month` | Inbox demo |
| `voice` | NULL | iba ak má reviewer vidieť hlas. Na produkcii vyžaduje funkčný OpenAI kľúč. Odporúčanie: **zapnúť**, keď sú P1–P10 v `10-voice-qa.md` PASS |

**Návrh SQL** (spúšťa iba operátor po súhlase; `<DEMO_COMPANY_ID>` až po onboardingu):

```sql
-- NESPÚŠŤAŤ bez súhlasu vlastníka. Produkcia fkpgvgvsmbpieduoatrt.
insert into public.beta_allowlist (email, note)
values ('play-review@esblu.com', 'Google Play review — demo firma'),
       ('play-review+employee@esblu.com', 'Google Play review — demo chat člen')
on conflict (email) do nothing;

insert into public.company_entitlements (company_id, entitlement_key, source, limit_value, limit_period, note)
values
  ('<DEMO_COMPANY_ID>', 'invoicing',    'manual', null, null,    'play-review demo'),
  ('<DEMO_COMPANY_ID>', 'vehicles',     'manual', null, null,    'play-review demo'),
  ('<DEMO_COMPANY_ID>', 'machines',     'manual', null, null,    'play-review demo'),
  ('<DEMO_COMPANY_ID>', 'inventory',    'manual', null, null,    'play-review demo'),
  ('<DEMO_COMPANY_ID>', 'team_members', 'manual', 3,    null,    'play-review demo'),
  ('<DEMO_COMPANY_ID>', 'ai_documents', 'manual', 50,   'month', 'play-review demo');
-- voliteľne: ('<DEMO_COMPANY_ID>', 'voice', 'manual', null, null, 'play-review demo')
```

**Rollback:** `update public.company_entitlements set status='revoked' where note='play-review demo';` a `update public.beta_allowlist set revoked_at=now() where email like 'play-review%';`. Nič sa nemaže.

## 3. Setup procedúra (po súhlase, cca 30 min)

1. Vlastník vytvorí mailbox (alebo alias) `play-review@esblu.com` a `play-review+employee@esblu.com`.
2. Operátor spustí časť **allowlist** z SQL vyššie.
3. Z **Play-nainštalovanej** appky (alebo z https://www.esblu.com/login):
   - registrácia `play-review@esblu.com`;
   - potvrdenie e-mailu;
   - onboarding firmy podľa sekcie 4.
4. Prijať právne dokumenty (LegalAcceptanceGate) a DPA (CompanyDpaGate), aby reviewer nenarazil na blokujúci dialóg.
5. Operátor spustí časť **granty** s ID demo firmy.
6. Naplniť demo dáta podľa sekcie 4 (ručne cez UI, žiadny import produkčných dát).
7. Pozvať `play-review+employee@esblu.com` (Nastavenia → Tím), prijať pozvánku v druhom prehliadači a napísať chatové správy (sekcia 4.6).
8. Odhlásiť sa a znova prihlásiť ako reviewer na **čistom zariadení**. Overiť všetky obrazovky zo sekcie 5. Nesmie sa objaviť onboarding ani gate.
9. Notifikácie nechať vypnuté (reviewer si ich môže zapnúť).
10. Heslo vložiť do Play Console → App content → **App access**.

## 4. Demo dáta (všetko fiktívne)

### 4.1 Firma
| Pole | Hodnota |
|---|---|
| Názov | Esblu Demo s.r.o. |
| IČO | 99 999 991 (fiktívne; ak onboarding vyžaduje kontrolný súčet, použiť iné fiktívne číslo, ktoré validáciou prejde, nie číslo reálnej firmy) |
| Adresa | Ukážková 1, 010 01 Žilina |
| IBAN (v profile fakturácie) | `SK31 1200 0000 1987 4263 7541` — **iba ilustračný** formátovo platný vzor, nie reálny účet |

Ak lookup v registri (RPO/RÚZ) nájde reálnu firmu, údaje **neprebrať**. Vyplniť ručne.

### 4.2 Obchodní partneri (3)
| Názov | IČO | Mesto | Poznámka |
|---|---|---|---|
| Lesy Horehronie s.r.o. | 51 234 567 | Brezno | odberateľ |
| Stavby Kysuce s.r.o. | 52 345 678 | Čadca | odberateľ |
| Doprava Liptov a.s. | 53 456 789 | Liptovský Mikuláš | dodávateľ |

IČO sú fiktívne. Pred použitím overiť, že sa v registri nezhodujú s reálnou firmou; ak áno, zmeniť poslednú číslicu.

### 4.3 Faktúry (3)
| Stav | Odberateľ | Položky | DPH |
|---|---|---|---|
| koncept | Lesy Horehronie s.r.o. | Výkopové práce 24 h × 45 € | 23 % |
| finalizovaná, neuhradená | Stavby Kysuce s.r.o. | Odvoz materiálu 1 200 €, Doprava 150 € | 23 % |
| finalizovaná, uhradená | Lesy Horehronie s.r.o. | Prenájom minibagra 3 dni × 180 € | 23 % |

### 4.4 Vozidlá (2), stroje (2), sklad (4)
| Modul | Záznam | Detail |
|---|---|---|
| Vozidlo | Škoda Octavia Combi | EČV fiktívna `ZA000DM`, STK o 3 týždne (upozornenie), EK o 5 mesiacov, 1 servis |
| Vozidlo | Ford Transit | EČV `ZA001DM`, PZP o 2 mesiace |
| Stroj | Minibager Kubota KX019 | 1 servisný záznam (výmena oleja) |
| Stroj | Vibračná doska Wacker DPU | bez záznamu |
| Sklad | Štrk 8/16 | 12 t, minimum 5 t |
| Sklad | Geotextília 300 g | 2 rolky, minimum 3 (**pod minimom**) |
| Sklad | Rúra KG 110 | 40 ks |
| Sklad | Sprej značkovací | 6 ks |

**Fotky:** iba generické, bez EČV, ľudí a lokalít. Ak také nie sú, nechať bez fotky.

### 4.5 Inbox (AI evidencia)
Nahrať 1 fiktívny doklad (napr. vlastnoručne vytvorený PDF „Bloček – Doprava Liptov a.s., 45,90 €"). Doklad nechať v stave na kontrolu, aby reviewer videl kontrolu pred uložením.

### 4.6 Chat (ukážkový tok)
1. *Zamestnanec:* „Dobrý deň, Octavia má o 3 týždne STK. Mám ju objednať?"
2. *Owner:* „Áno, prosím objednaj na budúci týždeň."
3. *Zamestnanec:* „Hotovo, utorok 8:00."
4. *Owner:* „Vďaka. Geotextília je pod minimom, doobjednám."

## 5. Obrazovky, ktoré reviewer otvorí
| Obrazovka | Čo uvidí |
|---|---|
| Prehľad | valec modulov |
| Inbox | doklad na kontrolu |
| Vozidlá + detail | |
| Stroje | |
| Sklad | |
| Obchodní partneri | |
| Faktúry | PDF finalizovanej faktúry |
| Chat | |
| Nastavenia | Notifikácie, Ochrana údajov, **Zrušiť účet** — iba zobraziť |

## 6. App access text pre Play Console (EN, vložiť do „Instructions")
```
All functionality requires sign-in.
On the login screen, sign in with the e-mail and password below (do not use "Continue with Google").
E-mail: play-review@esblu.com
Password: <entered only in this Play Console field>

The account is the owner of a demo company ("Esblu Demo s.r.o.") with fictional sample data. Main areas (bottom navigation and "More"): Overview, Inbox (upload a document; AI-read values are always reviewed and confirmed by the user before saving), Vehicles, Machines, Inventory, Business partners, Invoices (open the finalized invoice to see its PDF), Company chat, Settings.
Voice commands (microphone in the search field), if enabled: say e.g. "Otvor faktúry" (open invoices). Any change requested by voice is only proposed and must be confirmed; deletions by voice always require a tap.
Push notifications are optional (Settings > Notifications).
Account deletion is in Settings > Delete account — please do not confirm it, otherwise this review account is permanently removed.
No payments, subscriptions, bank connections or 2-factor authentication are involved.
```

Ak hlas nie je pre demo firmu zapnutý, vetu „Voice commands…" vynechať.
