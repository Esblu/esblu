# Esblu — konsolidovaný stav pripravenosti (2026-11-20)

Rozsah: Stripe S17, read-only kontrola produkcie a stagingu, npm audit, eFaktúra, GDPR/CLIA, mobil, prevádzka.
Bez produkčných zmien, bez LIVE, bez nových sandboxov. Právne závery nie sú potvrdené bez podkladu (CLIA / účtovníčka).

## 1. Hotové a overené
| Oblasť | Dôkaz |
|---|---|
| Produkcia A1 (12 migrácií, kód `1e2ab73`) | deploy SUCCESS 19. 11.; posledná migrácia `20261123120000_billing_ops_alerts`; billing `none/test` |
| Vyčistenie produkcie 19. 11. | 8/8 cleanup jobov `done/done` (overené 20. 11.); 4 používatelia, 3 firmy, 0 predplatných, 0 otvorených ops alertov |
| Interný tarif Esblu s. r. o. | 1 grant |
| Stripe S12/S13/S16 (sandbox `esblu-qa2`) | PASS (Test Clocks, obnovy, zlyhania, refundy, webhooky, doťahovanie, `cancel_at`) — neopakuje sa |
| 48 h ochranná lehota | schválená 19. 11., migrácia + testy PASS, v produkcii (A1) |
| S17-1, S17-2, S17-11, reset/obnova kurzora | PASS na skutočnom stagingu 20. 11. 12:24 UTC |
| Supabase advisors (prod, security) | 0 ERROR; INFO 53 service-only tabuliek (zámer), WARN SECURITY DEFINER RPC (známe, interné kontroly) |
| eFaktúra sandbox A/B, webhook HMAC, izolácia, role | PASS (audit 19. 11., G6–G9) |

## 2. Pripravené, neoverené
| Položka | Čo chýba |
|---|---|
| Harness S17 (`ops/s17-sandbox` @ `ac7b11a`) | beh na PC prevádzkovateľa; overené iba staticky (50 regresných kontrol + nezávislá revízia), PowerShell v prostredí agenta nie je |
| P4 Stripe (doklady, PDF archív, dobropis, export, zmeškaná udalosť) | S17-3…S17-10 na `esblu-qa2` |
| Bezpečnostné aktualizácie závislostí (`fix/dependency-security-2026-11-20` @ `f3435d1`) | merge + deploy + Android build (Capacitor 8.6.2) — tsc 0, lint = baseline 36/31, build 61 stránok, 7 testových sád PASS |
| eFaktúra P3 (mandát D-M1, deregistrácia D-G2, alerty D-O1) | produkčné migrácie `20261122100000/110000/120000` neaplikované |
| Retenčný archív (vlna B) | rozhodnutie prevádzkovateľa + CLIA |

## 3. npm audit (21 = 2 critical, 5 high, 14 moderate)
| Balík | Závažnosť | Prod? | Zneužiteľnosť v Esblu | Riešenie |
|---|---|---|---|---|
| next 16.3.8 | 2× critical RCE, high DoS, 6× moderate | áno (web) | RCE „use cache“: kód `use cache` nepoužíva; RCE obrázky/SVG: `next/image` 1×, bez `dangerouslyAllowSVG`, na Verceli optimalizuje platforma — nízka, ale nie nulová; DoS Server Actions: `use server` sa nenašlo | **next 16.4.6** |
| @capacitor/android 8.5.0 | critical (obsah na origin appky cez interný proxy) | **áno v APK** (npm ho hlási ako dev) | CapacitorHttp nie je zapnutý (nízka), Android vc4 je ale postavený s 8.5.0 | **Capacitor 8.6.2** + nový AAB |
| zod, source-map-js, brace-expansion | high DoS | čiastočne | server validuje vstupy zodom → aktualizovať | `npm audit fix` (bez --force) |
| browserslist, js-yaml, glob, minimatch, typescript-eslint | high/moderate | iba dev/build | nie pri behu | `npm audit fix` |
| exceljs → uuid | moderate | áno | chyba je iba vo v3/v5/v6 s parametrom `buf`; použitie v exceljs neoverené do detailu → pravdepodobne nízka | ponechať (oprava = downgrade exceljs 3.4.0) |
Po oprave: 0 critical, 0 high, 2 moderate (exceljs/uuid).

## 4. Čo skutočne blokuje komerčné spustenie
1. **Právne:** VOP s podmienkami predplatného, Zásady (Resend, Stripe, Google v appke), DPA príloha, `/subprocessors` — stanovisko CLIA (L1–L7). Bez toho nie billing UI ani verejný Android.
2. **Účtovné/daňové:** režim dokladov (§ 7a), Stripe faktúra vs. vlastný doklad, jediný zdroj dokladu (riziko dvojitej fakturácie) — účtovníčka (S2).
3. **Stripe LIVE:** aktivácia účtu Esblu s. r. o. (zároveň dôvod, prečo nejde prevziať ďalší sandbox), produkt/cena, restricted kľúč, webhook, env — prevádzkovateľ.
4. **Bezpečnosť:** critical zraniteľnosti v produkcii (next) a v Android buildoch (Capacitor) — oprava pripravená, čaká na schválenie merge/deploy.
5. **eFaktúra** (iba pre funkciu eFaktúra, nie pre spustenie predplatného): zmluva + DPA, oznámenie sprostredkovateľa, WAF, stanovisko účtovníčky (G1–G4, G10–G12).

## 5. Dá sa dokončiť hneď (bez LIVE a bez partnerov)
1. S17 na `esblu-qa2`: najprv `-Step s17-preflight` (iba čítanie), potom `s17-auto`.
2. Merge + deploy `fix/dependency-security-2026-11-20` (⛔ súhlas), Android vc5 s Capacitor 8.6.2 do interného testu.
3. Produkčné migrácie eFaktúra P3 (bez dopadu, eFaktúra vypnutá; ⛔ súhlas).
4. Vercel WAF pravidlo pre `/api/einvoice/webhook` (⛔ súhlas, produkčná konfigurácia).
5. Staging: deaktivovať mapovanie ceny `esblu-qa4` po S17 (⛔ súhlas pre zápis do stagingu).
6. iOS I2: odvolanie Apple tokenu pri zrušení účtu (kód, bez Apple účtu netestovateľné end-to-end).
7. Prevádzka: externý uptime monitoring; plánovaná šifrovaná záloha Storage (nie je v DB zálohách Supabase).
8. Doručiť CLIA opravu: dokumenty CLIA popisujú stav pred 12. 11. (ukončenie firmy dnes doklady maže).

## 6. Poradie
1. S17 preflight → S17 (Stripe test uzavretý) → deaktivácia ceny qa4 na stagingu.
2. Schválenie merge/deploy bezpečnostných aktualizácií → Vercel READY pre SHA → smoke → Android vc5 interný test.
3. Odoslať CLIA podklady (L1–L3) a otázky účtovníčke (S2) — paralelne s 1–2.
4. Migrácie eFaktúra P3 + WAF (technická príprava, eFaktúra ostáva vypnutá).
5. Po stanovisku CLIA: nové verzie VOP/Zásad/DPA → verejné Android vydanie.
6. Po stanovisku účtovníčky: nastavenie dokladov → Stripe LIVE (checklist `stripe-live-audit` § 6) → interný nákup + refund → billing UI.
7. eFaktúra po podpise zmluvy (G1–G12); iOS po D-U-N-S/Apple Developer.

## 7. Incident 20. 11. (agent)
`git worktree prune` spustený agentom v Linux sandboxe zmazal metadáta 7 Windows worktree → `fatal: not a git repository` a beh starej verzie harnessu. Metadáta obnovené, worktree zamknuté, harness teraz pred každým S17 krokom overuje git checkout a presný commit (§ 8.14i v `stripe-test-and-reconciliation-2026-11-18.md`).
