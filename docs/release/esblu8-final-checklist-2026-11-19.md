# Esblu 8 — staging.esblu.com, sandbox kľúče, alternatívny GO/NO-GO A1 a posledný kontrolný zoznam (2026-11-19)

## 1. Stav po pushi vetvy
- GitHub `release/esblu8` = `1c3e6a7` (= lokálne SHA). Vercel Git Preview `dpl_5RW6Goq9gX7gG6jZWZrCVvShx6rn` **READY**, target preview, alias `esblu-git-release-esblu8-esblu.vercel.app`. Produkcia ostáva `12da726`.
- Preview prostredie: Supabase = staging `esblu-test` (generické Preview premenné; vetva ich neprepisuje).
- Doplnené premenné **iba Preview + Git branch `release/esblu8`** (Claude, cez Vercel API): `ESBLU_BILLING_MODE=stripe_test`, `ESBLU_BILLING_RETURN_ORIGIN=https://staging.esblu.com`, `NEXT_PUBLIC_ESBLU_BILLING_UI=1`, `ESBLU_EINVOICE_PROVIDER=efaktura_sk`, `ESBLU_EINVOICE_ENVIRONMENT=sandbox`, `CRON_SECRET` (nový, Sensitive; lokálna kópia iba v `C:\Users\roiaj\esblu-backups\_keys\`, mimo Gitu a OneDrive). Žiadna live premenná.

## 2. staging.esblu.com
- Doména pridaná do Vercel projektu s priradením **iba na Git branch `release/esblu8`** (Preview → staging DB). Produkčné domény (`esblu.com`, `www.esblu.com`) bez zmeny. Rovnaký vzor už existuje pre `mobile-staging.esblu.com` → vetva `mobile-platform`.
- DNS pre `esblu.com` je u registrátora (Namecheap, `dns1/2.registrar-servers.com`), nie vo Verceli → **záznam pridáva prevádzkovateľ** (krok 3.1). Kým záznam neexistuje, doména nič nerobí.
- **Bezpečnosť (rozhodnutie):** projekt má ochranu `all_except_custom_domains` → vlastná doména Preview **nie je** chránená Vercel prihlásením (ako `mobile-staging.esblu.com` dnes). Možnosti:
  - **A (odporúčané, časovo obmedzené):** staging.esblu.com verejná počas testov — iba syntetické dáta v `esblu-test`, `noindex`, test kľúče; Stripe/eFaktura webhooky nepotrebujú bypass; Claude môže na tejto Vami určenej testovacej doméne používať syntetické QA účty a testovacie karty Stripe. Po testoch doménu odpojiť (Vercel) a DNS záznam zmazať.
  - **B:** prepnúť ochranu na „Standard Protection“ (chráni aj vlastné domény Preview vrátane `mobile-staging.esblu.com`); webhooky cez bypass, browserové testy by vyžadovali prihlásenie prevádzkovateľa do Vercelu v prehliadači aplikácie.

## 3. Nevyhnutné kroky prevádzkovateľa (všetko ostatné robí Claude)
1. **DNS (Namecheap → esblu.com → Advanced DNS):** `CNAME` host `staging` → `34f4f061b4b374be.vercel-dns-017.com.` (TTL Automatic). Nič iné nemeniť.
2. **Stripe sandbox „Esblu s.r.o.“ (test mode):**
   - Developers → API keys → *Create restricted key* (práva: `staging-sandbox-access-setup.md` § 2).
   - Developers → Webhooks → *Add endpoint* `https://staging.esblu.com/api/billing/webhooks/stripe`, udalosti: `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `customer.subscription.created/updated/deleted/paused/resumed/trial_will_end`, `invoice.finalized`, `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`, `invoice.voided`, `invoice.marked_uncollectible`, `charge.refunded`, `charge.dispute.created/closed`, `credit_note.created/updated/voided`. API verzia endpointu: `2025-03-31.basil`.
3. **eFaktura.sk sandbox portál:** API kľúč (`efk_pk_test_…`) a webhook `https://staging.esblu.com/api/einvoice/webhook` (signing secret).
4. **Vercel → esblu → Settings → Environment Variables → Add** (Environment **Preview** iba, Git Branch **release/esblu8**, **Sensitive**): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `ESBLU_EFAKTURA_API_KEY`, `ESBLU_EFAKTURA_WEBHOOK_SECRET`. Kľúče nikam inam (nie do chatu, nie do Gitu).
5. Napísať „hotovo“ — Claude overí existenciu premenných (bez hodnôt), spustí redeploy Preview a celý plán.

## 4. Testovací plán po kroku 3 (Claude)
Stripe (sandbox, staging DB): `Stripe-Version` 2025-03-31.basil (catch-up cron, account/events), checkout testovacou kartou 4242 na staging.esblu.com, webhook + idempotencia, zamietnutá karta 4000…0002, obnova a zlyhaná obnova (test clock cez Stripe API z Preview iba ak dostupné; inak skript prevádzkovateľa), oprava platby, čiastočná/plná refundácia → dobropis, faktúra → účtovná kópia + PDF archív, ukončenie firmy → kópia ostáva, mesačný export. eFaktura: `staging-smoke-test-esblu8.md` § 3 (mandát, enroll, odoslanie/blokovanie, odvolanie, deregistrácia, replay webhooku, duplicita, RLS, 402 alert). Výsledky iba stavy/kódy/počty/prefixy hashov. Potom: zrušenie bypass secretu, overenie 302 bez neho, voliteľne odpojenie staging.esblu.com.

## 5. Alternatívny GO/NO-GO — A1 s vypnutým billingom
| Predpoklad | Dôkaz | Stav |
|---|---|---|
| LIVE platby vypnuté | produkcia: `billing_runtime_config` environment=test, web_provider=none, einvoice_sellable=false; produkčné env bez `STRIPE_*`, `ESBLU_BILLING_MODE`, `ESBLU_BILLING_LIVE_APPROVED`, `ESBLU_EFAKTURA_*`, `ESBLU_EINVOICE_*` → režim off; live vyžaduje `ESBLU_BILLING_LIVE_APPROVED` + live kľúče (billing-live-mode-db 14 PASS) | ✅ |
| eFaktúra LIVE vypnutá | A1 neobsahuje eFaktura migrácie; v produkcii 0 organizácií; mandát DRAFT blokuje live grant | ✅ |
| Bezpečnosť cronov | 4 nové crony (`billing-stripe-events` */15, `billing-reconcile` 6 h, `billing-ops-monitor` 15 min, `billing-documents` 1 h): všetky vyžadujú `CRON_SECRET` (401) a pri režime off vrátia `configured:false` bez volania Stripe a bez zápisu | ✅ (kód + preview 401) |
| Kompatibilita aplikácie | starý kód `12da726` nad schémou A1: 0 zaniknutých funkcií, 0 zmien návratových typov, 0 nových NOT NULL bez defaultu v existujúcich tabuľkách; produkcia bez driftu (11/11) | ✅ |
| Rollback | Vercel Instant Rollback + oddelený DB rollback 12 → 1 (audit → archív) | ✅ pripravený |
| Čerstvá záloha | PHYSICAL < 24 h + šifrovaný export tesne pred nasadením | ⏳ v deň nasadenia |
| Stripe sandbox s pripnutou verziou | — | ⛔ **blokuje zapnutie LIVE platieb**, nie A1 s vypnutým billingom |
**Verdikt (billing vypnutý): GO s podmienkami** — čerstvá záloha v deň nasadenia + schválenie prevádzkovateľa. Zapnutie Stripe LIVE ostáva NO-GO do úspešného sandbox testu, odpovedí účtovníčky a samostatného schválenia.

## 6. Posledný kontrolný zoznam na schválenie A1 (vykoná Claude po „schvaľujem A1“)
1. [ ] Read-only preflight produkcie: posledná migrácia `20261117213219`, users 3 (+ prípadne nový `esblu.office@gmail.com`), companies 2(+1), objects 9, billing_runtime_config test/none.
2. [ ] Denná PHYSICAL záloha < 24 h (Dashboard) + šifrovaný export DB a Storage do `C:\Users\roiaj\esblu-backups\` overený rozšifrovaním.
3. [ ] `apply_migration` 1 → 12 (názvy = súbory `20261118120000` … `20261123120000`), po každej `schema_migrations` + `get_advisors` (0 nových ERROR).
4. [ ] Merge `release/esblu8` → `main` — **vyžaduje push z PC prevádzkovateľa** (Cowork nemôže pushovať) — alebo fast-forward cez GitHub UI (PR `release/esblu8` → `main`, bez squash).
5. [ ] Vercel production READY pre presné SHA; smoke test (`/`, `/login`, 3 chránené účty, crony `configured:false`, runtime errors 30 min = 0).
6. [ ] Záznam do `docs/ops/` (SHA, deployment uid, verzie migrácií).
7. [ ] Pri chybe: Vercel Instant Rollback na `dpl_7rkNSeF2…`; DB rollback iba pri chybe migrácie (12 → 1).
Nie je súčasťou: A2 (eFaktúra), vlna B (archív), Stripe LIVE, interný grant (po registrácii prevádzkovateľa).
