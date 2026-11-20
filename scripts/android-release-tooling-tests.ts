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
  // JAVA_HOME sa iba normalizuje (bez koncovej \), priečinok ostáva ten istý (incident vc3 / vc5).
  assert.match(jdk, /\$home21 = ConvertTo-EsbluJavaHome \$sel\.Home/);
  assert.match(jdk, /if \(\$env:JAVA_HOME -ne \$home21\) \{ \$env:JAVA_HOME = \$home21 \}/);
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
  // Gradle launcher aj daemon na JDK 21: -Dorg.gradle.java.home ako SAMOSTATNÝ argument z Get-EsbluGradleArgs
  // (predchádzajúca podoba "...=$env:JAVA_HOME" v jednom reťazci zlyhala pri JAVA_HOME s koncovou \ — vc3, vc5).
  assert.match(build, /& \.\\gradlew\.bat @gradleArgs/, "aj Gradle daemon na JDK 21");
  assert.match(jdk, /"-Dorg\.gradle\.java\.home=\$h"/);
});
check("build skript: verzia/podpis/package nezmenené", () => {
  // 2026-11-17: versionCode/Name sú parametre (predtým natvrdo vc2); default = najbližší voľný kód po vc3.
  assert.match(build, /\[int\]\$VersionCode = 5\b/, "default vc5 (vc1–vc4 už použité)");
  assert.match(build, /\[string\]\$VersionName = "1\.0\.2"/);
  assert.match(build, /if \(\$VersionCode -lt 5\)/, "použité kódy vc1–vc4 sú odmietnuté");
  assert.match(build, /if \(Test-Path \$OutAab\) \{ Fail /, "existujúci AAB sa neprepíše");
  assert.match(build, /esblu-upload-key-2026\.jks/);
  assert.match(build, /\$Alias = "esblu"/);
  assert.match(build, /-notcontains "com\.esblu\.app"/);
});
check("build skript: čerstvé mobilné podklady (-PrepareWeb) a kontrola synchronizovaných assetov", () => {
  assert.match(build, /\[switch\]\$PrepareWeb/);
  assert.match(build, /npm run build --workspace mobile/);
  assert.match(build, /npx cap sync android/);
  assert.match(build, /android-prebuild-check\.mjs --target production/);
  assert.match(build, /verify-mobile-bundle\.mjs \$Assets/);
  assert.match(build, /"testerov", "approved testers", "freigegebene Tester"/, "uzavretá beta v bundli = FAIL");
  assert.ok(!/[^\x00-\x7F]/.test(build), "skript je čisté ASCII (PowerShell 5.1)");
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
// -----------------------------------------------------------------------------
// Incident vc3 (2026-11-14) a znova vc5 (2026-11-20, oprava nebola v main): JAVA_HOME z inštalátora
// Adoptium končí "\". Windows PowerShell 5.1 obalí argument s medzerou do "..." BEZ escapovania
// koncovej spätnej lomky -> "...hotspot\" a parser príkazového riadku (CRT/Java) číta \" ako znak
// úvodzovky -> -PesbluVersionCode/-PesbluVersionName sa prilepia k org.gradle.java.home.
// Simulácia: PS 5.1 (legacy) skladanie príkazového riadku + CommandLineToArgvW pravidlá.
// -----------------------------------------------------------------------------
function ps51CommandLine(args: string[]): string {
  return args.map((a) => (/[\s]/.test(a) && !/^".*"$/.test(a) ? `"${a}"` : a)).join(" ");
}
function parseArgv(cmd: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < cmd.length) {
    while (cmd[i] === " " || cmd[i] === "\t") i++;
    if (i >= cmd.length) break;
    let cur = "";
    let inQ = false;
    for (; i < cmd.length; i++) {
      const c = cmd[i];
      if (c === "\\") {
        let n = 0;
        while (cmd[i] === "\\") { n++; i++; }
        if (cmd[i] === '"') {
          cur += "\\".repeat(Math.floor(n / 2));
          if (n % 2 === 1) { cur += '"'; continue; }
          i--; continue;
        }
        cur += "\\".repeat(n); i--; continue;
      }
      if (c === '"') { inQ = !inQ; continue; }
      if (!inQ && (c === " " || c === "\t")) break;
      cur += c;
    }
    out.push(cur);
  }
  return out;
}
function esbluJavaHome(h: string): string {
  // zrkadlo ConvertTo-EsbluJavaHome (jdk21.ps1): Trim, Trim('"'), TrimEnd('\\','/'), C: -> C:\\
  let x = h.trim().replace(/^"+|"+$/g, "").replace(/[\\/]+$/, "");
  if (/^[A-Za-z]:$/.test(x)) x += "\\";
  return x;
}
check("Gradle argumenty: koncová \\ v JAVA_HOME by prilepila -P argumenty (reprodukcia chyby vc5)", () => {
  const jh = "C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.12.101-hotspot\\";
  const broken = parseArgv(ps51CommandLine(["bundleRelease", `-Dorg.gradle.java.home=${jh}`, "-PesbluVersionCode=5", "-PesbluVersionName=1.0.2"]));
  assert.equal(broken.length, 2, "chyba sa musí v simulácii prejaviť (2 argumenty namiesto 4)");
  assert.match(broken[1], /hotspot" -PesbluVersionCode=5 -PesbluVersionName=1\.0\.2$/);
  const fixed = parseArgv(ps51CommandLine(["bundleRelease", `-Dorg.gradle.java.home=${esbluJavaHome(jh)}`, "-PesbluVersionCode=5", "-PesbluVersionName=1.0.2"]));
  assert.deepEqual(fixed, ["bundleRelease", "-Dorg.gradle.java.home=C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.12.101-hotspot", "-PesbluVersionCode=5", "-PesbluVersionName=1.0.2"]);
  for (const v of ["C:\\jdk21", "C:\\jdk21\\", "C:\\Program Files\\Java\\jdk-21\\\\", '"C:\\Program Files\\Java\\jdk-21\\"', "D:\\Java Tools\\jdk-21/"]) {
    const a = parseArgv(ps51CommandLine(["bundleRelease", `-Dorg.gradle.java.home=${esbluJavaHome(v)}`, "-PesbluVersionCode=5", "-PesbluVersionName=1.0.2"]));
    assert.equal(a.length, 4, v);
    assert.equal(a[2], "-PesbluVersionCode=5", v);
    assert.doesNotMatch(a[1], /["\\]$/, v);
  }
});
check("build skript: Gradle argumenty ako samostatné prvky (Get-EsbluGradleArgs + splatting), bez inline JAVA_HOME", () => {
  assert.match(build, /\$gradleArgs = Get-EsbluGradleArgs -JavaHome \$env:JAVA_HOME -VersionCode \$VersionCode -VersionName \$VersionName/);
  assert.match(build, /& \.\\gradlew\.bat @gradleArgs/);
  assert.doesNotMatch(build, /gradlew\.bat bundleRelease "-Dorg\.gradle\.java\.home=\$env:JAVA_HOME"/);
  assert.match(jdk, /function ConvertTo-EsbluJavaHome/);
  assert.match(jdk, /TrimEnd\('\\', '\/'\)/);
  assert.match(jdk, /\$h\.Contains\('"'\) -or \$h\.EndsWith\('\\'\)\) \{ throw/);
  assert.match(jdk, /return @\(\$Task, "-Dorg\.gradle\.java\.home=\$h", "-PesbluVersionCode=\$VersionCode", "-PesbluVersionName=\$VersionName"\)/);
  assert.match(psTests, /JAVA_HOME with trailing backslash -> normalized; Gradle args are 4 separate elements/);
  assert.match(psTests, /Gradle args reject JAVA_HOME with embedded quote/);
});
check("build skript: android-prebuild-check --target production beží aj bez -PrepareWeb (znovupoužité assety)", () => {
  const i = build.indexOf("if ($PrepareWeb) {");
  const assetsGate = build.indexOf("No synced web assets in $Assets");
  const pre = build.indexOf("android-prebuild-check.mjs --target production");
  assert.ok(i > 0 && assetsGate > i && pre > assetsGate, "kontrola produkčného cieľa je za blokom -PrepareWeb (vždy)");
  assert.equal(build.split("android-prebuild-check.mjs --target production").length - 1, 1);
  assert.ok(build.indexOf("verify-mobile-bundle.mjs $Assets") > pre);
});
check("výstupy release buildu sú mimo Gitu (AAB, signing.txt, fingerprint súbory, keystore)", () => {
  for (const p of ["release/*.aab", "release/*.signing.txt", "release/upload-key.sha*"]) assert.ok(gitignore.includes(p), p);
  for (const src of [build, create, jdk]) assert.doesNotMatch(src, /storePassword\s*=|-----BEGIN/);
});

console.log(`\nandroid-release-tooling: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
