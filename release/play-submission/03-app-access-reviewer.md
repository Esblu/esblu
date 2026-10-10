# 03 — App access / reviewer balík

**Stav: pripravené, účet NEVYTVORENÝ** (vyžaduje zápis do produkcie — čaká na súhlas vlastníka).

## Model
- Samostatný účet **`play-review@esblu.com`** (mailbox, ku ktorému má prístup vlastník; potrebný pre potvrdzovací e-mail pri registrácii).
- Rola **owner** vo **vlastnej demo firme „Esblu Demo s.r.o."** — nie reálna produkčná firma, žiadne reálne dáta.
- E-mail + heslo, **bez 2FA** (Esblu 2FA nemá), heslo trvalé, nemeniť počas review.
- Google login reviewer nepoužíva.

## Setup checklist (po súhlase vlastníka)
1. Pridať `play-review@esblu.com` do `beta_allowlist` (produkčná DB — **vyžaduje súhlas**; alternatíva: vlastník pošle pozvánku do demo firmy cez UI, ak bude demo firma založená pod jeho dohľadom).
2. Registrácia na `https://www.esblu.com/login` → potvrdenie e-mailu → onboarding firmy: názov „Esblu Demo s.r.o.", fiktívne IČO/adresa.
3. Akceptovať právne dokumenty v appke (LegalAcceptanceGate) a DPA (CompanyDpaGate) — aby reviewer nenarazil na blokujúci dialóg.
4. Naplniť fiktívne dáta (ručne cez UI):
   - 2 vozidlá (napr. „Škoda Octavia Combi", „Ford Transit") s termínmi STK/EK a 1 fotkou (generická fotka bez EČV).
   - 1–2 stroje (napr. „Minibager Kubota KX019") so servisným záznamom.
   - 3–4 skladové položky (jedna pod minimálnou zásobou).
   - 1 obchodný partner (fiktívna firma, fiktívny formátovo platný IBAN napr. `SK31 1200 0000 1987 4263 7541` — **len ilustračný**, nie reálny účet).
   - 1 koncept faktúry + 1 finalizovaná faktúra (aby sa dalo ukázať PDF a ochrana finalizovaných dokladov).
   - 1–2 dokumenty v Inboxe (vzorový fiktívny doklad).
   - 2. používateľ v demo firme (rola **employee**, `play-review+employee@esblu.com`) — kvôli ukážke firemného chatu; reviewer sa prihlasuje iba ako owner.
   - 3–4 chatové správy medzi owner a employee.
5. Overiť z Play-nainštalovanej appky, že login prejde a všetky obrazovky nižšie sa otvoria.
6. Notifikácie nechať vypnuté (reviewer si ich môže zapnúť).

## Obrazovky, ktoré musí reviewer vedieť otvoriť
Prehľad · Inbox (nahratie dokladu → kontrola → potvrdenie) · Vozidlá + detail · Stroje · Sklad · Obchodní partneri · Faktúry (+ PDF) · Firemný chat · Nastavenia (Notifikácie, Ochrana údajov, **Zrušiť účet** — iba zobraziť, nepotvrdzovať).

Nevyžaduje sa: eFaktúra, billing/predplatné, Apple, Stripe, externé 2FA, bankové napojenie (nič z toho nie je v builde aktívne).

**Dôležité:** reviewer **nesmie** reálne zrušiť demo účet (zničil by review prístup) — v inštrukciách to výslovne uviesť.

## App access text pre Play Console (EN)
```
All functionality requires sign-in.
Sign in on the login screen with the e-mail and password below (do not use "Continue with Google").
E-mail: play-review@esblu.com
Password: <provided in this field>

The account is the owner of a demo company ("Esblu Demo s.r.o.") with fictional sample data. Main areas (bottom navigation and "More"): Overview, Inbox (upload a document; AI-read values are always reviewed and confirmed by the user before saving), Vehicles, Machines, Inventory, Business partners, Invoices (PDF of a finalized invoice), Company chat, Settings.
Push notifications are optional (Settings > Notifications).
Account deletion is available in Settings > Delete account — please do not confirm it, otherwise this review account is permanently removed.
No payments, subscriptions or 2-factor authentication are involved.
```
