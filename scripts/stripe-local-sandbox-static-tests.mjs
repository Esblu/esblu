// Staticke regresne testy pre scripts/stripe-local-sandbox.ps1 (S17 harness).
// POZOR: nespustaju PowerShell. Overuju invarianty textu skriptu pre chyby, ktore uz realne nastali
// (2026-11-18..20), a konstrukcie nekompatibilne s Windows PowerShell 5.1. Nie su integracnym testom.
// Spustenie: node scripts/stripe-local-sandbox-static-tests.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const path = join(here, "stripe-local-sandbox.ps1");
const raw = readFileSync(path);
const src = raw.toString("utf8");
const lines = src.split(/\r?\n/);

let failed = 0;
let passed = 0;
function check(name, ok, detail = "") {
  if (ok) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail ? " :: " + detail : ""}`); }
}

// Kod bez komentarov (# ... a <# ... #>), retazce ponechane.
function stripComments(text) {
  let out = text.replace(/<#[\s\S]*?#>/g, (m) => m.replace(/[^\n]/g, " "));
  out = out.split("\n").map((l) => {
    let inS = false, inD = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (c === "`") { i++; continue; }
      if (c === "'" && !inD) inS = !inS;
      else if (c === '"' && !inS) inD = !inD;
      else if (c === "#" && !inS && !inD) return l.slice(0, i);
    }
    return l;
  }).join("\n");
  return out;
}
const code = stripComments(src);
const codeLines = code.split("\n");
const lineOf = (re) => codeLines.findIndex((l) => re.test(l));

// --- 0) kodovanie: PS 5.1 cita subor bez BOM ako ANSI -> iba ASCII alebo UTF-8 s BOM
const hasBom = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
check("kodovanie: ASCII alebo UTF-8 s BOM (PS 5.1)", hasBom || /^[\x00-\x7f]*$/.test(src));

// --- 1) PS 5.1 kompatibilita (PS7-only syntax / parametre)
const ps7 = [
  [/\?\?=?/, "null-coalescing ??"],
  [/\?\.[A-Za-z]/, "null-conditional ?."],
  [/\)\s*&&\s*|\s&&\s/, "pipeline chain &&"],
  [/\s\|\|\s/, "pipeline chain ||"],
  [/-AsHashtable\b/, "ConvertFrom-Json -AsHashtable"],
  [/-AsByteStream\b/, "-AsByteStream"],
  [/ForEach-Object\s+-Parallel/, "ForEach-Object -Parallel"],
  [/-SkipCertificateCheck|-SkipHttpErrorCheck|-StatusCodeVariable/, "Invoke-RestMethod PS7 parameter"],
  [/Join-Path\s+(?:\$\w+|""|'')\s+(?:\$\w+|""|'')\s+(?:\$\w+|""|'')/, "Join-Path s 3 argumentmi"],
];
for (const [re, name] of ps7) {
  const hits = codeLines.map((l, i) => [l, i]).filter(([l]) => {
    const noStr = l.replace(/"(?:[^"`]|`.)*"|'[^']*'/g, '""');
    return re.test(noStr);
  });
  check(`PS 5.1: bez ${name}`, hits.length === 0, hits.slice(0, 3).map(([, i]) => `L${i + 1}`).join(","));
}
// ternarny operator ( podmienka ? a : b ) mimo retazcov
{
  const hits = codeLines.map((l, i) => [l.replace(/"(?:[^"`]|`.)*"|'[^']*'/g, '""'), i])
    .filter(([l]) => /\)\s+\?\s+[^:]+\s+:\s+/.test(l));
  check("PS 5.1: bez ternarneho operatora", hits.length === 0, hits.slice(0, 3).map(([, i]) => `L${i + 1}`).join(","));
}

// --- 2) "$var:" v retazci s dvojitymi uvodzovkami = drive-qualified premenna (chyba parsovania / prazdna hodnota)
{
  const hits = [];
  codeLines.forEach((l, i) => {
    for (const m of l.matchAll(/"(?:[^"`]|`.)*"/g)) {
      const s = m[0];
      const bad = s.match(/(?<!`)\$(?!env:|script:|global:|using:|PSScriptRoot|null|true|false)[A-Za-z_][A-Za-z0-9_]*:(?!:)/);
      if (bad) hits.push(`L${i + 1}:${bad[0]}`);
    }
  });
  check('retazce: bez "$premenna:" (PS drive scope)', hits.length === 0, hits.slice(0, 5).join(", "));
}

// --- 3) kazda volana vlastna funkcia je definovana
{
  const defined = new Set([...code.matchAll(/^\s*function\s+([A-Za-z][\w-]*)/gm)].map((m) => m[1].toLowerCase()));
  const builtins = new Set(`Add-Content Add-Member ConvertFrom-Json ConvertTo-Json Copy-Item Export-Csv ForEach-Object Format-Table Get-ChildItem Get-CimInstance Get-Command Get-Content Get-Date Get-FileHash Get-Item Get-Process Get-Random Get-WmiObject Import-Csv Invoke-Expression Invoke-RestMethod Invoke-WebRequest Join-Path Measure-Object New-Item New-Object Out-File Out-Null Out-String Pop-Location Push-Location Read-Host Remove-Item Resolve-Path Select-Object Select-String Set-Content Set-Location Sort-Object Split-Path Start-Process Start-Sleep Stop-Process Test-Path Where-Object Write-Error Write-Host Write-Output Write-Warning Group-Object Rename-Item Move-Item Get-Location Get-Member Get-Variable Set-Variable Remove-Variable Wait-Process ConvertTo-SecureString Tee-Object Compare-Object Get-Unique Out-Host Clear-Host Set-Clipboard`.split(/\s+/).map((s) => s.toLowerCase()));
  const unknown = new Set();
  codeLines.forEach((l) => {
    const noStr = l.replace(/'[^']*'/g, "''").replace(/"(?:[^"`]|`.)*"/g, '""');
    for (const m of noStr.matchAll(/(?<![\w$.-])([A-Z][a-z]+-[A-Z][A-Za-z0-9]+)\b/g)) {
      const n = m[1].toLowerCase();
      if (!defined.has(n) && !builtins.has(n)) unknown.add(m[1]);
    }
  });
  check("funkcie: kazda volana je definovana alebo vstavana", unknown.size === 0, [...unknown].join(", "));
}

// --- 4) premenne skriptu pouzite na top-level az po priradeni (chyba $KnownAccounts 2026-11-20)
{
  const topVars = ["WhsecOnlyCompromised", "KnownAccounts", "NoListenOnly", "CompromisedProjects", "CompromisedKeyProjects", "SandboxAccount", "RepoRoot", "StateDir"];
  const bad = [];
  for (const v of topVars) {
    const def = lineOf(new RegExp(`^\\$${v}\\s*=`));
    // prve pouzitie mimo funkcii: hladame riadok bez odsadenia, ktory nie je definicia
    let depth = 0, firstUse = -1;
    for (let i = 0; i < codeLines.length; i++) {
      const l = codeLines[i];
      if (/^\s*function\s/.test(l)) depth++;
      if (depth === 0 && new RegExp(`\\$${v}\\b`).test(l) && !new RegExp(`^\\$${v}\\s*=`).test(l)) { firstUse = i; break; }
      if (depth > 0) {
        // koniec funkcie = zatvorka na zaciatku riadku
        if (/^}\s*$/.test(l)) depth = 0;
      }
    }
    if (def < 0) bad.push(`${v}: nedefinovana`);
    else if (firstUse >= 0 && firstUse < def) bad.push(`${v}: pouzita L${firstUse + 1} pred definiciou L${def + 1}`);
  }
  check("premenne skriptu: definicia pred pouzitim na top-level", bad.length === 0, bad.join("; "));
}

// --- 5) Stripe CLI: profil default vzdy vyslovne (chyba 1086e53: CLI bez --project-name = aktualny project-name)
{
  const def = code.match(/\$StripeDefaultCli\s*=\s*(.+)/);
  check("CLI: $StripeDefaultCli ma --project-name default", !!def && /"--project-name",\s*"default"/.test(def[1]));
  const bare = codeLines.map((l, i) => [l, i]).filter(([l]) => /(Invoke-StripeRaw|Get-ListenSecret|Get-ProfileAccountId)\s+\$StripeCliBase\b(?!\s*\))/.test(l) && !/"version"/.test(l));
  check("CLI: ziadne volanie profilu cez holy $StripeCliBase (bez --project-name)", bare.length === 0, bare.map(([, i]) => `L${i + 1}`).join(","));
}

// --- 6) pristupova brana: ziadne nove sandboxy, qa3 blokovany, qa2 iba bez stripe listen
{
  const gateStart = lineOf(/^\$WhsecOnlyCompromised\s*=/);
  check("brana: esblu-qa2 je iba whsec-kompromitovany profil", /^\$WhsecOnlyCompromised\s*=\s*@\("esblu-qa2"\)/m.test(code));
  check("brana: esblu-qa3 ma kompromitovany API kluc", /^\$CompromisedKeyProjects\s*=\s*@\("esblu-qa3"\)/m.test(code));
  check("brana: new-sandbox je vypnuty pred akymkolvek zapisom", /if \(\$Step -eq "new-sandbox"\) \{\s*\n\s*Write-Host "CHYBA: zakladanie dalsich Stripe sandboxov je vypnute/.test(code) && gateStart > 0);
  const allow = code.match(/\$okQa2 = \$NoListenOnly -and \(\(@\(([^)]*)\) -contains \$Step\) -or \(\$Step -eq "start" -and \$NoListen\)\)/);
  const allowed = allow ? allow[1].split(",").map((s) => s.trim().replace(/"/g, "")).sort().join(",") : "";
  check("brana: qa2 povolene presne s17-preflight/s17-auto/s17/s17-cleanup/status/mark-exposed + start -NoListen", allowed === "mark-exposed,s17,s17-auto,s17-cleanup,s17-preflight,status", allowed);
  check("s17-auto: qa2 spusta okno 1 s -NoListen", /if \(\$NoListen -or \$NoListenOnly\) \{ \$w1Args \+= "-NoListen"/.test(code));
  check("s17-auto: bez automatickeho noveho sandboxu", /if \(-not \$PriceId\) \{\s*\n\s*Fail "Profil '\$Project' nema cenu/.test(code));
  check("start -NoListen: whsec_ uctu sa necita (nahodne lokalne tajomstvo)", /if \(\$NoListen\) \{[\s\S]{0,600}\$WhSec = "whsec_" \+/.test(code));
}

// --- 7) git: funkcny checkout a presny commit vetvy (chyba "fatal: not a git repository" + stara verzia skriptu)
{
  check("git: Assert-HarnessCheckout existuje", /function Assert-HarnessCheckout/.test(code));
  const call = code.match(/if \(@\(([^)]*)\) -contains \$Step\) \{\s*\n\s*\$HarnessHead = Assert-HarnessCheckout/);
  const steps = call ? call[1].replace(/"/g, "").split(",").map((s) => s.trim()).sort().join(",") : "";
  check("git: kontrola pre start/s17-preflight/s17-auto/s17/s17-cleanup", steps === "s17,s17-auto,s17-cleanup,s17-preflight,start", steps);
  const callLine = lineOf(/\$HarnessHead = Assert-HarnessCheckout/);
  const firstDispatch = lineOf(/^if \(\$Step -eq "(mark-exposed|s17-auto|map-price)"/);
  check("git: kontrola pred prvym dispatchom krokov", callLine > 0 && callLine < firstDispatch, `L${callLine + 1} vs L${firstDispatch + 1}`);
  check("git: rev-parse HEAD zlyhanie = STOP (nie text chyby ako SHA)", /if \(\$hr\.code -ne 0 -or \$hr\.out -notmatch "\^\[0-9a-f\]\{40\}\$"\)/.test(code));
  check("git: stderr sa necita ako vystup", /2> \$errFile/.test(code));
}

// --- 8) Stripe kluc: rkcs_ (neprevzaty sandbox) sa pre zapisy odmietne + sonda zapisu (chyba S17-3 403)
{
  check("kluc: rkcs_test_ sa nahradi vyzvou na sk_test_/rk_test_", /if \(\$key -match "\^rkcs_test_" -and \$Step -ne "mark-exposed"\)/.test(code));
  check("sonda: POST test_clocks bez parametra (403 = STOP, 400 = OK)", /test_helpers\/test_clocks" -Headers \$h -Method Post/.test(code) && /if \(\$wc -eq 403\)/.test(code) && /if \(\$wc -ne 400\)/.test(code));
  const s1 = code.indexOf('Invoke-S17Step "1"');
  const probe = code.indexOf("Test-StripeKeyAccess $env:STRIPE_API_KEY", s1);
  const enable = code.indexOf("Enable-S17Billing $S17Ctx.state", s1);
  check("S17-1: sonda klucov pred prvym zapisom do stagingu", s1 > 0 && probe > s1 && probe < enable);
}

// --- 9) kurzor udalosti (chyba ACCOUNT_MISMATCH): reset s zalohou pred zmazanim, obnova v S17-11/cleanup
{
  const fnReset = src.slice(src.indexOf("function Reset-S17EventCursor"), src.indexOf("function Restore-S17EventCursor"));
  const save = fnReset.indexOf("Save-S17State $st   # zaloha PRED zmazanim");
  const del = fnReset.indexOf('Invoke-Staging "DELETE"');
  check("kurzor: zaloha riadku pred DELETE", save > 0 && del > save);
  check("kurzor: aktivny lease = STOP", /lease_until -and \[DateTimeOffset\]::Parse/.test(fnReset));
  const en = code.slice(code.indexOf("function Enable-S17Billing"), code.indexOf("function Reset-S17EventCursor"));
  check("kurzor: reset v S17-1 pred zmenou cien", en.indexOf("Reset-S17EventCursor $st") > 0 && en.indexOf("Reset-S17EventCursor $st") < en.indexOf('"PATCH" "billing_provider_prices'));
  const rs = code.slice(code.indexOf("function Restore-S17Staging"), code.indexOf("function Invoke-S17 "));
  check("obnova: Restore-S17EventCursor v Restore-S17Staging", /Restore-S17EventCursor \$st/.test(rs));
  check("obnova: zamer checkoutu QA-D z behu -> expired", /status=in\.\(created,open\)&created_at=gte/.test(rs));
  check("obnova: 404 predplatneho (zmazane s Test Clock) nie je trvala chyba", /HTTP 404"\) \{ \$s = \[pscustomobject\]@\{ status = "canceled"/.test(rs));
  check("obnova: ceny najprv vypnut, potom zapnut (nikdy 2 aktivne)", rs.indexOf("@{ active = $false }") > 0 && rs.indexOf("@{ active = $false }") < rs.indexOf("@{ active = $true }"));
  check("cleanup: pri chybe obnovy sa Test Clocks nemazu", /\$clocksToDelete = \$\(if \(\$d\.Contains\("errors"\)\) \{ @\(\) \}/.test(code));
  check("opakovany beh: neobnoveny kurzor / neupratane predplatne = STOP", /\$old\.cursor_reset -and -not \$old\.cursor_restored/.test(code) && /if \(\$old\.subscription\) \{ Fail/.test(code));
}

// --- 10) PS 5.1 Invoke-RestMethod: JSON pole sa rozbaluje pred .Count
{
  const bad = [];
  codeLines.forEach((l, i) => {
    const m = l.match(/\$(\w+)\s*=\s*@\(Invoke-Staging\s+"(GET|DELETE|PATCH|POST)"[^|\n]*\)\s*$/);
    if (m && new RegExp(`\\$${m[1]}\\.Count`).test(codeLines.slice(i, i + 12).join(" "))) bad.push(i);
  });
  check("PS 5.1: @(Invoke-Staging ...) s .Count je rozbalene (| ForEach-Object)", bad.length === 0, bad.map((i) => `L${i + 1}`).join(","));
}

// --- 11) tajomstva: vystup iba cez maskovanie; whsec/kluc/service_role sa nevypisuju
{
  const direct = codeLines.map((l, i) => [l, i]).filter(([l]) => /Write-Host[^|]*\$(WhSec|StripeKey|ServiceRole|key|k|newKey)\b/.test(l));
  check("tajomstva: Write-Host bez premennej s klucom", direct.length === 0, direct.map(([, i]) => `L${i + 1}`).join(","));
  check("tajomstva: Hide-Secrets maskuje whsec_, sk/rk/rkcs, JWT, sb_secret_", /whsec_\*\*\*/.test(code) && /\(\?:sk\|rk\|rkcs\|pk\)/.test(code) && /eyJ\*\*\*/.test(code) && /sb_\(secret\|publishable\)_/.test(code));
  check("tajomstva: dokazy S17 cez Hide-S17", /Set-Content -Path \$S17Ctx\.evidenceFile -Value \(Hide-S17 \$json\)/.test(code));
  check("tajomstva: whsec_ sa necommituje (release-backups git-excluded kontrola)", /check-ignore", "-q", "release-backups\/s17\/s17-evidence\.json"/.test(code));
}

// --- 12) ValidateSet vs. dispatch
{
  const vs = code.match(/\[ValidateSet\(([\s\S]*?)\)\]\s*\n\s*\[string\]\$Step/);
  const set = new Set(vs ? [...vs[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : []);
  const dispatched = new Set([...code.matchAll(/\$Step -eq "([a-z0-9-]+)"/g), ...code.matchAll(/^\s*"([a-z0-9-]+)"\s*\{/gm)].map((m) => m[1]));
  const missing = [...dispatched].filter((s) => !set.has(s));
  check("ValidateSet obsahuje kazdy spracovany krok", missing.length === 0, missing.join(","));
  check("ValidateSet obsahuje s17-preflight", set.has("s17-preflight"));
}

// --- 13) s17-auto: prepinace sa prenasaju do podprocesov, obsadeny port = STOP
{
  check("s17-auto: -Force/-Month do okna 1, s17 aj cleanup", /\$w1Args = @\([^\n]*\) \+ \$fwd/.test(code) && /-Step s17 -Project \$Project -Port \$Port @fwd/.test(code) && /-Step s17-cleanup -Project \$Project -Port \$Port @fwd/.test(code));
  check("s17-auto: obsadeny port pred startom = STOP", /Port \$Port uz pouziva iny server/.test(code));
  check("s17-preflight: iba citanie (exit pred oknom 1)", (() => {
    const a = code.indexOf('if ($Step -eq "s17-preflight") {');
    const b = code.indexOf("Start-Process -FilePath $ps", a);
    const seg = code.slice(a, b);
    return a > 0 && /exit 0/.test(seg) && !/Invoke-Staging "(PATCH|POST|DELETE)"/.test(seg) && !/Invoke-StripeApi "(POST|DELETE)"/.test(seg);
  })());
}

console.log(`\n${passed} PASS, ${failed} FAIL`);
process.exit(failed ? 1 : 0);
