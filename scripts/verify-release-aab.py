#!/usr/bin/env python3
"""Static validation of an Esblu release AAB (no secrets needed).

  python3 scripts/verify-release-aab.py <app.aab> [--expected-sha256 AA:BB:...]

Checks: base/manifest (aapt2 protobuf) -> package, versionCode/Name, min/target SDK;
signer certificate (keytool -printcert -jarfile) is not the Android debug key and
matches the expected upload-key SHA-256; native libs only 64-bit-compatible ABIs;
bundled web assets pass scripts/android-prebuild-check.mjs --target production
(production Supabase/API only, no staging trace, no server secrets, no local paths).
Exit 1 on any failure.
"""
import os, re, subprocess, sys, tempfile, zipfile

def varint(b, i):
    r = s = 0
    while True:
        c = b[i]; i += 1
        r |= (c & 0x7F) << s; s += 7
        if c < 0x80: return r, i

def fields(b):
    i, out = 0, []
    while i < len(b):
        key, i = varint(b, i); f, w = key >> 3, key & 7
        if w == 0: v, i = varint(b, i)
        elif w == 2:
            n, i = varint(b, i); v = b[i:i + n]; i += n
        elif w == 5: v = b[i:i + 4]; i += 4
        elif w == 1: v = b[i:i + 8]; i += 8
        else: raise ValueError("wire type")
        out.append((f, w, v))
    return out

def walk(b, attrs, depth=0):
    """Collect aapt2 XmlAttribute {name=2, value=3, compiled_item=6} anywhere."""
    if depth > 40: return
    try: fs = fields(b)
    except Exception: return
    name = next((v for f, w, v in fs if f == 2 and w == 2), None)
    if name is not None:
        try: n = name.decode()
        except Exception: n = None
        if n and re.fullmatch(r"[A-Za-z]+", n):
            val = next((v for f, w, v in fs if f == 3 and w == 2), b"")
            ints = []
            for f, w, v in fs:
                if f == 6 and w == 2: collect_ints(v, ints)
            attrs.setdefault(n, []).append((val.decode(errors="replace"), ints))
    for f, w, v in fs:
        if w == 2 and len(v) > 1: walk(v, attrs, depth + 1)

def collect_ints(b, out, depth=0):
    if depth > 6: return
    try: fs = fields(b)
    except Exception: return
    for f, w, v in fs:
        if w == 0: out.append(v)
        elif w == 2: collect_ints(v, out, depth + 1)

def first(attrs, key):
    for val, ints in attrs.get(key, []):
        if val: return val
        if ints: return str(ints[-1])
    return None

def main():
    if len(sys.argv) < 2: print(__doc__); sys.exit(2)
    aab = sys.argv[1]
    expected = sys.argv[sys.argv.index("--expected-sha256") + 1].upper() if "--expected-sha256" in sys.argv else None
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ok = True
    def check(label, cond, detail=""):
        nonlocal ok
        ok &= bool(cond)
        print(("OK    " if cond else "FAIL  ") + label + (f"  ({detail})" if detail else ""))

    z = zipfile.ZipFile(aab)
    names = z.namelist()
    attrs = {}
    walk(z.read("base/manifest/AndroidManifest.xml"), attrs)
    pkg, vc, vn = first(attrs, "package"), first(attrs, "versionCode"), first(attrs, "versionName")
    mn, tg = first(attrs, "minSdkVersion"), first(attrs, "targetSdkVersion")
    check("package com.esblu.app", pkg == "com.esblu.app", pkg)
    check("versionCode", vc is not None, vc)
    check("versionName", vn is not None, vn)
    check("minSdk 24", mn == "24", mn)
    check("targetSdk 36", tg == "36", tg)
    perms = sorted(v for v, _ in attrs.get("name", []) if v.startswith(("android.permission.", "com.google.android.")))
    print("INFO  permissions/components:", ", ".join(p for p in perms if "permission" in p))
    check("no AD_ID / location / camera / media permissions", not any(re.search(r"AD_ID|LOCATION|\.CAMERA$|READ_MEDIA|READ_EXTERNAL", p) for p in perms))

    abis = sorted({n.split("/")[2] for n in names if re.match(r"base/lib/[^/]+/.+\.so$", n)})
    check("native ABIs 64-bit capable", not abis or any(a in ("arm64-v8a", "x86_64") for a in abis), ", ".join(abis) or "no native libs")
    check("google-services processed (google_app_id resource)", any("values" in n for n in names) and b"google_app_id" in z.read("base/resources.pb"))

    cert = subprocess.run(["keytool", "-printcert", "-jarfile", aab], capture_output=True, text=True).stdout
    sha256 = (re.search(r"SHA256:\s*([0-9A-F:]+)", cert) or [None, None])[1]
    sha1 = (re.search(r"SHA1:\s*([0-9A-F:]+)", cert) or [None, None])[1]
    check("AAB is signed", bool(sha256))
    check("not signed with Android debug key", "CN=Android Debug" not in cert)
    if expected: check("signer SHA-256 matches expected upload key", sha256 == expected, sha256)
    print("INFO  upload key SHA-256:", sha256)
    print("INFO  upload key SHA-1:  ", sha1)

    with tempfile.TemporaryDirectory() as d:
        pub = [n for n in names if n.startswith("base/assets/public/")]
        for n in pub: z.extract(n, d)
        assets = os.path.join(d, "base", "assets", "public")
        check("web assets bundled", len(pub) > 0, f"{len(pub)} files")
        r = subprocess.run(["node", os.path.join(root, "scripts", "android-prebuild-check.mjs"), "--target", "production", "--assets", assets],
                           capture_output=True, text=True, cwd=root, env={**os.environ, "NODE_USE_ENV_PROXY": "1"})
        fails = [l for l in r.stdout.splitlines() if l.startswith("FAIL")]
        for l in r.stdout.splitlines():
            if l.startswith(("FAIL", "INFO")) or "TARGET production" in l or "APK assets bez" in l: print("      " + l)
        check("bundled assets pass production prebuild check", not fails)
    sys.exit(0 if ok else 1)

if __name__ == "__main__":
    main()
