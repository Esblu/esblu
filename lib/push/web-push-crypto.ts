import { createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign } from "node:crypto";

// =============================================================================
// Web Push bez závislosti — štandardné šifrovanie a podpis podľa RFC.
//
//   RFC 8291  Message Encryption for Web Push (aes128gcm)
//   RFC 8188  Encrypted Content-Encoding for HTTP
//   RFC 8292  VAPID (Voluntary Application Server Identification)
//
// Iba Node `crypto` (P-256 ECDH, HKDF cez HMAC-SHA256, AES-128-GCM, ES256).
// Nič z obsahu správy sa nikam neposiela nezašifrované; push služba
// prehliadača (Google/Apple/Mozilla) vidí iba šifrovaný blob.
// =============================================================================

export type PushSubscriptionKeys = { endpoint: string; p256dh: string; auth: string };
export type VapidKeys = { publicKey: string; privateKey: string; subject: string };

export function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/** HKDF (RFC 5869) pre dĺžku ≤ 32 bajtov — jeden blok expand. */
function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = hmac(salt, ikm);
  return hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, length);
}

const RECORD_SIZE = 4096;

/**
 * Zašifruje payload pre jedno zariadenie (aes128gcm, jeden záznam).
 * `asKeyPair` a `salt` sú parametre iba kvôli testom; inak náhodné.
 */
export function encryptPushPayload(
  payload: Buffer,
  subscription: Pick<PushSubscriptionKeys, "p256dh" | "auth">,
  testOverrides?: { asPrivateKey?: Buffer; salt?: Buffer }
): Buffer {
  const uaPublic = base64UrlDecode(subscription.p256dh);
  const authSecret = base64UrlDecode(subscription.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error("PUSH_INVALID_P256DH");
  if (authSecret.length < 16) throw new Error("PUSH_INVALID_AUTH");
  if (payload.length > RECORD_SIZE - 17 - 86) throw new Error("PUSH_PAYLOAD_TOO_LARGE");

  const ecdh = createECDH("prime256v1");
  if (testOverrides?.asPrivateKey) ecdh.setPrivateKey(testOverrides.asPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);

  // RFC 8291 §3.3–3.4
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "utf8"), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const salt = testOverrides?.salt ?? randomBytes(16);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0", "utf8"), 12);

  // Jediný (posledný) záznam: payload || 0x02
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, ciphertext]);
}

/** VAPID hlavička `Authorization` pre daný endpoint (RFC 8292). */
export function vapidAuthorization(endpoint: string, vapid: VapidKeys, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const audience = new URL(endpoint).origin;
  const header = base64UrlEncode(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = base64UrlEncode(Buffer.from(JSON.stringify({ aud: audience, exp: nowSeconds + 12 * 3600, sub: vapid.subject })));
  const publicKey = base64UrlDecode(vapid.publicKey);
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) throw new Error("VAPID_INVALID_PUBLIC_KEY");
  const key = createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: vapid.privateKey,
      x: base64UrlEncode(publicKey.subarray(1, 33)),
      y: base64UrlEncode(publicKey.subarray(33, 65)),
    },
    format: "jwk",
  });
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${header}.${claims}.${base64UrlEncode(signature)}, k=${vapid.publicKey}`;
}

export type PushSendOutcome = "sent" | "gone" | "failed";

/** Odošle jednu notifikáciu. `gone` = zariadenie odhlásené (404/410) → zrušiť. */
export async function sendWebPush(
  subscription: PushSubscriptionKeys,
  payload: Record<string, unknown>,
  vapid: VapidKeys,
  fetchImpl: typeof fetch = fetch
): Promise<PushSendOutcome> {
  let body: Buffer;
  try {
    body = encryptPushPayload(Buffer.from(JSON.stringify(payload), "utf8"), subscription);
  } catch {
    return "failed";
  }
  try {
    const response = await fetchImpl(subscription.endpoint, {
      method: "POST",
      headers: {
        Authorization: vapidAuthorization(subscription.endpoint, vapid),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(24 * 3600),
        Urgency: "normal",
      },
      body: new Uint8Array(body),
    });
    if (response.status === 404 || response.status === 410) return "gone";
    return response.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}
