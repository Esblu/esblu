// =============================================================================
// Native billing (Android Java plugin) ↔ TS kontrakt — statické testy.
// Integračná vetva subscriptions-mobile-integration. Neprekladá Java (bez Android
// SDK v CI) — overuje kontrakt, opt-in Gradle a že default build je bez billingu.
//   npm run test:native-billing-contract
// =============================================================================
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeGooglePluginResult } from "@/lib/billing/native-bridge-contract";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const JAVA = read("mobile/android/app/src/billing/java/com/esblu/app/billing/EsbluBillingPlugin.java");
const BRIDGE = read("lib/billing/native-bridge.ts");
const GRADLE = read("mobile/android/app/build.gradle");
const MANIFEST = read("mobile/android/app/src/main/AndroidManifest.xml");
const MAIN = read("mobile/android/app/src/main/java/com/esblu/app/MainActivity.java");

let passed = 0;
let failed = 0;
function check(label: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${label}\n       ${error instanceof Error ? error.message : String(error)}`);
  }
}

check("plugin meno = registerPlugin('EsbluBilling') v TS", () => {
  assert.match(JAVA, /@CapacitorPlugin\(name = "EsbluBilling"\)/);
  assert.match(BRIDGE, /registerPlugin<EsbluBillingPlugin>\("EsbluBilling"\)/);
});
check("každá metóda TS pluginu má @PluginMethod v Jave", () => {
  const block = BRIDGE.slice(BRIDGE.indexOf("type EsbluBillingPlugin = {"), BRIDGE.indexOf("};", BRIDGE.indexOf("type EsbluBillingPlugin = {")));
  const methods = [...block.matchAll(/^\s{2}(\w+)\(/gm)].map((m) => m[1]);
  assert.ok(methods.length >= 8, methods.join(","));
  for (const m of methods) assert.match(JAVA, new RegExp(`@PluginMethod\\s+public void ${m}\\(PluginCall call\\)`), m);
});
check("každý 'kind' z Javy normalizuje TS kontrakt bez straty (žiadny neznámy stav)", () => {
  const kinds = [...new Set([...JAVA.matchAll(/put\("kind", "([a-z_]+)"\)/g)].map((m) => m[1]))];
  for (const k of ["canceled", "already_owned", "billing_unavailable", "error"]) assert.ok(kinds.includes(k), k);
  assert.match(JAVA, /"pending" : "play"/);
  for (const kind of [...kinds, "play", "pending"]) {
    const r = normalizeGooglePluginResult({ kind, purchaseToken: "tok_1234567890", code: "DEVELOPER_ERROR" });
    assert.equal(r.kind, kind, kind);
  }
  for (const code of [...JAVA.matchAll(/return "([A-Z_]+)";/g)].map((m) => m[1]).concat(["BILLING_CHOICE_NOT_WIRED", "PURCHASE_IN_PROGRESS"])) {
    assert.deepEqual(normalizeGooglePluginResult({ kind: "error", code }), { kind: "error", code }, code);
  }
});
check("plugin nikdy neacknowledguje ani neudeľuje nárok (server-side)", () => {
  assert.doesNotMatch(JAVA, /acknowledgePurchase\(/);
  assert.doesNotMatch(JAVA, /consumeAsync\(/);
  assert.match(JAVA, /setObfuscatedAccountId\(accountId\)/);
});
check("billing choice nie je zapojený → bezpečná chyba, žiadny launch", () => {
  assert.match(JAVA, /BILLING_CHOICE_NOT_WIRED/);
  assert.doesNotMatch(JAVA, /enableBillingProgram|enableDeveloperBillingOption/);
});
check("queryProducts bez Play produktu = jasný stav unconfigured/unavailable (nie pád)", () => {
  assert.match(JAVA, /"unconfigured"/);
  assert.match(JAVA, /"unavailable"/);
  assert.match(JAVA, /r\.put\("missing", missing\)/);
  assert.match(BRIDGE, /status\?: "ok" \| "unconfigured" \| "unavailable"/);
});
check("build-billing-matrix.ps1: iba debug + JDK 21 + opt-in billing, bez uploadu / release / secrets", () => {
  const ps = read("release/build-billing-matrix.ps1");
  assert.match(ps, /Use-Jdk21OrFail/);
  assert.match(ps, /:app:assembleDebug/);
  assert.match(ps, /-PesbluBilling=true/);
  assert.match(ps, /com\.android\.vending\.BILLING/);
  assert.match(ps, /com\.android\.billingclient:billing:9\.1\.0/);
  assert.doesNotMatch(ps, /bundleRelease|assembleRelease|publish|upload|storePassword|keystore\.properties/i);
});
check("restore posiela iba PURCHASED tokeny (pending nie)", () => {
  assert.match(JAVA, /queryPurchasesAsync\([\s\S]*PurchaseState\.PURCHASED/);
});
check("Gradle: Play Billing iba za -PesbluBilling=true; default build bez knižnice", () => {
  const idx = GRADLE.indexOf("com.android.billingclient:billing");
  assert.ok(idx > 0);
  assert.equal(GRADLE.split("com.android.billingclient:billing").length, 2, "iba jeden výskyt");
  const guard = GRADLE.lastIndexOf("if (project.findProperty('esbluBilling') == 'true') {", idx);
  assert.ok(guard > 0 && idx - guard < 400, "závislosť je vnútri opt-in bloku");
  assert.match(GRADLE, /srcDirs \+= 'src\/billing\/java'/);
});
check("Manifest nedeklaruje BILLING povolenie (pridá ho až knižnica pri opt-in)", () => {
  assert.doesNotMatch(MANIFEST, /com\.android\.vending\.BILLING/);
});
check("MainActivity registruje billing plugin voliteľne (reflection, bez pádu)", () => {
  assert.match(MAIN, /Class\.forName\("com\.esblu\.app\.billing\.EsbluBillingPlugin"\)/);
  assert.match(MAIN, /catch \(ClassNotFoundException/);
  assert.doesNotMatch(MAIN, /^import com\.esblu\.app\.billing/m);
});

check("RC: build matrix stráži produkčný baseline manifestu (zakázané povolenia, allowBackup=false) v oboch variantoch", () => {
  const ps = read("release/build-billing-matrix.ps1");
  assert.match(ps, /Check-Baseline "billing-off" \$f/);
  assert.match(ps, /Check-Baseline "billing-on" \$f/);
  for (const p of ["ACCESS_(FINE|COARSE|BACKGROUND)_LOCATION", "CAMERA", "READ_CONTACTS", "READ_MEDIA_", "SCHEDULE_EXACT_ALARM", "FOREGROUND_SERVICE", "AD_ID"]) assert.ok(ps.includes(p), p);
  assert.match(ps, /android:allowBackup=false/);
});

check("RC: fake natívny bridge iba vo výslovnom staging builde (default = produkcia → nikdy fake)", () => {
  const bridge = read("lib/billing/native-bridge.ts");
  assert.match(bridge, /NEXT_PUBLIC_ESBLU_BILLING_FAKE_NATIVE === "1" && process\.env\.NEXT_PUBLIC_ESBLU_ENV === "staging"\)/);
  assert.equal((bridge.match(/new FakeBillingBridge\(/g) ?? []).length, 1, "jediné miesto vytvorenia fake bridge");
});

console.log(`\nnative-billing-contract: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
