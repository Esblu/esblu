#!/usr/bin/env python3
# =============================================================================
# P1-5 D-B — NEZÁVISLÉ overenie šifrovanej zálohy (iná implementácia než runner: Python hashlib + cryptography).
# Iba čítanie, všetko v pamäti, nič nezapisuje. Heslo z premennej ESBLU_P15_BACKUP_PASSPHRASE.
#   python -I verify-backup-independent.py <priečinok zálohy> [reference.json]
# reference.json (voliteľné, iba pre syntetický test) = [{bucket, name, sha256}] pôvodných bajtov.
# =============================================================================
import hashlib, hmac, json, os, sys, unicodedata
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

FORMAT = "esblu-p15-storage-backup-v2"

def main() -> int:
    d = sys.argv[1]
    pw = unicodedata.normalize("NFC", os.environ.get("ESBLU_P15_BACKUP_PASSPHRASE", ""))
    if len(pw) < 20:
        print("STOP: heslo"); return 2
    h = json.load(open(os.path.join(d, "header.json"), encoding="utf-8"))
    assert h["format"] == FORMAT and h["cipher"] == "aes-256-gcm" and h["kdf"]["alg"] == "scrypt"
    k = hashlib.scrypt(pw.encode(), salt=__import__("base64").b64decode(h["kdf"]["salt_b64"]),
                       n=h["kdf"]["N"], r=h["kdf"]["r"], p=h["kdf"]["p"], maxmem=300 * 1024 * 1024, dklen=64)
    enc, mac = k[:32], k[32:]
    rest = {key: v for key, v in h.items() if key != "header_mac"}
    # JSON.stringify bez medzier, poradie kľúčov ako v súbore
    canon = json.dumps(rest, separators=(",", ":"), ensure_ascii=False)
    want = hmac.new(mac, f"{FORMAT}|header|{canon}".encode(), "sha256").hexdigest()
    if not hmac.compare_digest(want, h.get("header_mac", "")):
        print("STOP: HMAC hlavičky"); return 1
    def opn(blob: str) -> bytes:
        raw = open(os.path.join(d, blob), "rb").read()
        return raw, AESGCM(enc).decrypt(raw[:12], raw[28:] + raw[12:28], f"{FORMAT}|{blob}".encode())
    mraw, mplain = opn(h["manifest"]["blob"])
    assert hashlib.sha256(mraw).hexdigest() == h["manifest"]["sha256_cipher"]
    manifest = json.loads(mplain)
    assert len(manifest) == h["objects"] == len(h["blobs"])
    ok = 0
    content = {}
    for i, e in enumerate(manifest):
        raw, plain = opn(e["blob"])
        assert h["blobs"][i]["blob"] == e["blob"] and hashlib.sha256(raw).hexdigest() == h["blobs"][i]["sha256_cipher"]
        assert len(plain) == e["size"] and hashlib.sha256(plain).hexdigest() == e["sha256"] and hashlib.md5(plain).hexdigest() == e["md5"]
        content[(e["bucket"], e["name"])] = hashlib.sha256(plain).hexdigest()
        ok += 1
    ref_ok = "-"
    if len(sys.argv) > 2:
        ref = json.load(open(sys.argv[2], encoding="utf-8"))
        assert len(ref) == len(content) and all(content[(r["bucket"], r["name"])] == r["sha256"] for r in ref)
        ref_ok = f"{len(ref)}/{len(ref)}"
    print(f"INDEPENDENT_VERIFY_OK: {ok} objektov dešifrovaných (AES-256-GCM, tag), SHA-256/MD5/veľkosť = manifest, HMAC hlavičky OK, referencia {ref_ok}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
