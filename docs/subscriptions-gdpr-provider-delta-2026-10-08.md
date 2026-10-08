# Unified subscriptions — interný GDPR / provider delta (pre neskoršie CLIA posúdenie)

> **INTERNÉ. CLIA NEODOSLANÉ.** Podklad pripravený 8. 10. 2026 na posúdenie pred produkciou.
> Ide výlučne o vzťah **zákazník → platí Esblu za SaaS predplatné**.
> **Nejde** o platby faktúr, ktoré vystavujú zákazníci Esblu, ani o bankové párovanie.
> Údaje predplatného sú oddelené od fakturačného modulu (`invoices`, eFaktúra), ktorý sa nemení.

## 1. Provideri

| Provider | Úloha | Stav | Rola podľa GDPR (návrh na posúdenie) |
|---|---|---|---|
| **Stripe** (Stripe Payments Europe, Ltd., Írsko) | webový checkout, opakované platby, Customer Portal, faktúry za predplatné | iba test mode / sandbox; live **neaktivovaný** | pri platbách samostatný prevádzkovateľ; pri Billing / Portal sprostredkovateľ — overiť v [Stripe DPA](https://stripe.com/legal/dpa) |
| **Apple** (App Store) | iba ak sa neskôr zavedie IAP | iba architektúra | samostatný prevádzkovateľ (obchod a platba) |
| **Google** (Play) | iba ak sa neskôr zavedie Play Billing | iba architektúra | samostatný prevádzkovateľ (obchod a platba) |
| **Fake provider** | staging test double, bez tretej strany | iba staging | — |

## 2. Kategórie údajov

**V Esblu (Supabase, EÚ región podľa existujúceho DPA):**

- `subscription_accounts`: plán, interval, kanonický stav, obdobie, príznak zrušenia, provider, identifikátory providera (customer / subscription ID).
- `billing_provider_links`: identifikátory providera; Apple/Google account token = náhodné UUID, **nereverzibilné, nie je odvodené z osobných údajov**.
- `billing_checkout_sessions`: kto (user_id) začal checkout, plán, interval, ID session.
- `billing_events`: event ID, typ, časy, stav spracovania, chybový kód, **sha256 tela** a minimalizovaný súhrn (stav, ID predplatného, price ID, koniec obdobia).
  - **Žiadne** kartové údaje (PAN/CVC), mená, e-maily, adresy ani DIČ.
  - Celý payload sa neukladá.

**U Stripe (zadáva zákazník priamo v Stripe Checkout / Portal, Esblu ich nevidí ani neukladá):**

- meno alebo obchodné meno, fakturačná adresa, e-mail, DIČ / VAT ID;
- platobná metóda (karta, Apple Pay, Google Pay);
- IP adresa a zariadenie (antifraud, Radar);
- faktúry za predplatné.

**Cez webhooky prichádza** celý objekt eventu. Spracuje sa v pamäti servera a uložia sa iba polia z bodu „V Esblu“. Stripe Checkout `customer_details` sa nečítajú ani neukladajú.

## 3. Účel a právny základ (návrh)

| Účel | Právny základ (návrh) |
|---|---|
| Plnenie zmluvy o predplatnom: platba, aktivácia nárokov, obnovy, zrušenie | čl. 6 ods. 1 písm. b) |
| Účtovné a daňové povinnosti k faktúram za predplatné | čl. 6 ods. 1 písm. c) |
| Prevencia podvodov a zneužitia trialu | čl. 6 ods. 1 písm. f) — oprávnený záujem; posúdiť |

## 4. Retencia (návrh, na posúdenie)

- `subscription_accounts`, `billing_provider_links`: počas trvania zmluvy + premlčacia lehota.
- `billing_events`, `billing_checkout_sessions`: audit 24 mesiacov, potom anonymizácia (company_id → NULL).
- Faktúry za predplatné (u Stripe): 10 rokov podľa zákona o účtovníctve — overiť, či ich archivuje Esblu alebo Stripe.
- Pri zmazaní firmy: billing tabuľky majú `on delete cascade` / `set null`. Údaje u Stripe vyžadujú samostatný postup (Stripe redaction / API).

## 5. Medzinárodné prenosy

- **Stripe:** subjekt v EÚ (Írsko), ale skupina zahŕňa Stripe, Inc. (US). Overiť DPF certifikáciu, SCC v Stripe DPA a [zoznam subprocesorov](https://stripe.com/legal/service-providers).
- **Apple / Google:** iba ak sa zavedie IAP alebo Play Billing — vlastné podmienky obchodov.

## 6. Dokumenty na doplnenie pred produkciou

- Zoznam subprocesorov Esblu (`app/subprocessors`) — doplniť Stripe **až pri live** aktivácii.
- Zásady ochrany osobných údajov — sekcia „Platby za predplatné“.
- Obchodné podmienky — predplatné, obnovy, zrušenie ku koncu obdobia, refundácie, zmena plánu (proration), grace period 7 dní, čo sa stane s dátami po skončení (nemažú sa; zmenia sa iba nároky).
- DPA so zákazníkom — či sa mení zoznam subprocesorov (notifikačná politika: `docs/clia-change-notification-policy.md`).
- Spotrebiteľ vs. firma — predaj je B2B. Ak by kupoval spotrebiteľ, platí právo na odstúpenie — posúdiť.

## 7. Webhooky — bezpečnosť údajov

- Overenie podpisu pred akýmkoľvek spracovaním; telo sa neloguje.
- Odpovede webhookov neobsahujú osobné údaje.
- Signing secret je iba v env premennej servera (Vercel), nikdy v repozitári ani v klientovi.
