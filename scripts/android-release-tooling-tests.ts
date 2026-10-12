// =============================================================================
// Statické regresné kontroly release toolingu (release/*.ps1) — beží v Node aj
// bez PowerShellu. Behaviorálne testy výberu JDK: release/tests/jdk21-selection.tests.ps1
// (Windows PowerShell). Incident 2026-10-11: skript natvrdo prepisoval JAVA_HOME
// na Android Studio JBR (JDK 25) → "Unsupported class file major version 69".
//   npm run test:android-release-tooling
// =============================================================================
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
let passed = 0;
let failed = 0;
function check(label: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${label}\n       ${(error as Error).message}`);
  }
}

const jdk = read("release/jdk21.ps1");
const build = read("release/build-release-aab.ps1");
const create = read("release/create-upload-keystore.ps1");
const psTests = read("release/tests/jdk21-selection.tests.ps1");
const gitignore = read(".gitignore");

check("jdk21.ps1: vyžaduje presne major 21 (žiadne 2[1-9] / 25)", () => {
  assert.match(jdk, /\$script:EsbluRequiredJdkMajor = 21/);
  assert.match(jdk, /\(Get-JdkMajor \$CurrentJavaHome\) -eq \$required/);
  assert.match(jdk, /\(Get-JdkMajor \$c\) -eq \$required/);
  for (const src of [jdk, build, create]) assert.doesNotMatch(src, /2\[1-9\]/, "akceptácia 21+ (vrátane 25) je zakázaná");
});
check("jdk21.ps1: existujúci platný JAVA_HOME sa neprepisuje", () => {
  assert.match(jdk, /return \[pscustomobject\]@\{ Home = \$CurrentJavaHome; Source = "JAVA_HOME \(existing, kept\)" \}/);
  assert.match(jdk, /if \(\$env:JAVA_HOME -ne \$sel\.Home\) \{ \$env:JAVA_HOME = \$sel\.Home \}/);
});
check("jdk21.ps1: discovery Adoptium / Java / ďalší vendori jdk-21*, JBR až na konci", () => {
  for (const p of ["Eclipse Adoptium\\\\jdk-21*", "Java\\\\jdk-21*"]) assert.ok(jdk.includes(p.replace(/\\\\/g, "\\")), p);
  assert.ok(jdk.indexOf("Android\\Android Studio\\jbr") > jdk.indexOf("BellSoft"), "JBR je posledný kandidát");
});
check("jdk21.ps1: žiadna natvrdo patch verzia (21.0.x)", () => {
  assert.ok(!/21\.0\.\d/.test(jdk.replace(/^\s*#.*$/gm, "")), "patch verzia v kóde");
});
check("jdk21.ps1: jasný FAIL bez JDK 21 + výpis zvoleného JAVA_HOME a verzie", () => {
  assert.match(jdk, /FAIL: JDK 21 is required/);
  assert.match(jdk, /Selected JAVA_HOME: \$env:JAVA_HOME/);
  assert.match(jdk, /Java version: \$ver/);
});
check("build/create skripty: žiadny natvrdo JBR override, používajú Use-Jdk21OrFail", () => {
  for (const src of [build, create]) {
    assert.doesNotMatch(src, /\$env:JAVA_HOME\s*=\s*\$jbr/);
    assert.doesNotMatch(src, /Android Studio\\jbr/);
    assert.match(src, /\. \(Join-Path \$PSScriptRoot "jdk21\.ps1"\)/);
    assert.match(src, /Use-Jdk21OrFail/);
  }
  assert.match(build, /gradlew\.bat bundleRelease "-Dorg\.gradle\.java\.home=\$env:JAVA_HOME"/, "aj Gradle daemon na JDK 21");
});
check("build skript: verzia/podpis/package nezmenené", () => {
  assert.match(build, /\$VersionCode = 2\b/, "vc2 = Internal Testing build z mobile-platform (vc1 už existuje)");
  assert.match(build, /if \(Test-Path \$OutAab\) \{ Fail /, "existujúci AAB sa neprepíše");
  assert.match(build, /\$VersionName = "1\.0\.0"/);
  assert.match(build, /esblu-upload-key-2026\.jks/);
  assert.match(build, /\$Alias = "esblu"/);
  assert.match(build, /-notcontains "com\.esblu\.app"/);
});
check("jdk21.ps1: java -version bez NativeCommandError (Process capture), overený exit code + major 21", () => {
  assert.doesNotMatch(jdk, /&\s*\$java\s+-version\s+2>&1/, "žiadne & java -version 2>&1 (PS 5.1 + EAP Stop = NativeCommandError)");
  assert.doesNotMatch(jdk, /bin\\java\.exe"\)\s+-version\s+2>&1/);
  assert.match(jdk, /System\.Diagnostics\.ProcessStartInfo/);
  assert.match(jdk, /RedirectStandardError = \$true/);
  assert.match(jdk, /\$r\.ExitCode -ne 0/);
  assert.match(jdk, /\(Get-JavaVersionMajor \$r\.Text\) -ne \$script:EsbluRequiredJdkMajor/);
  assert.match(psTests, /java -version on STDERR under ErrorActionPreference=Stop/);
  assert.match(psTests, /non-zero exit code is reported/);
});
check("PowerShell regresné testy pokrývajú požadované scenáre", () => {
  for (const s of ["JAVA_HOME = JDK 21 -> PASS and kept", "JAVA_HOME = JDK 25 -> not used blindly", "Android Studio JBR 25 + Adoptium 21", "no JDK 21 anywhere", "JBR accepted only when it really is JDK 21"]) {
    assert.ok(psTests.includes(s), s);
  }
});
check("výstupy release buildu sú mimo Gitu (AAB, signing.txt, fingerprint súbory, keystore)", () => {
  for (const p of ["release/*.aab", "release/*.signing.txt", "release/upload-key.sha*"]) assert.ok(gitignore.includes(p), p);
  for (const src of [build, create, jdk]) assert.doesNotMatch(src, /storePassword\s*=|-----BEGIN/);
});

console.log(`\nandroid-release-tooling: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
