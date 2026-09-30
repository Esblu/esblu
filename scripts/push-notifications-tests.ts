// =============================================================================
// Push notifikácie — aplikačná logika (bez DB, bez siete):
//   deep-link allowlist (TS aj public/sw.js), jazyk príjemcu, poskytovatelia
//   (Web Push / FCM HTTP v1 / APNs) s podvrhnutým transportom, doručovanie
//   (deduplikácia, multi-device, neplatné tokeny, cross-company obrana),
//   príjemcovia podľa rolí, validácia vstupu a bezpečnostné invarianty kódu.
// DB matica (RLS, RPC, session, členstvo): scripts/push-devices-pglite-tests.ts.
//
// SPUSTENIE:  npm run test:push
// =============================================================================

import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

const deepLink = await import("@/lib/push/deep-link");
const routing = await import("@/lib/push/routing");
const { deliver } = await import("@/lib/push/dispatch");
const fcm = await import("@/lib/push/providers/fcm");
const apns = await import("@/lib/push/providers/apns");
const webpush = await import("@/lib/push/providers/webpush");
const { readNativeDevice, readUnregisterInput } = await import("@/lib/push/device-input");
const { resolveAppHref } = await import("@/lib/app-routes");
const { toDeliveryTarget, configuredProviders } = await import("@/lib/push/server");

type DeliveryTarget = import("@/lib/push/providers/types").DeliveryTarget;
type PushMessage = import("@/lib/push/routing").PushMessage;

let passed = 0;
let failed = 0;
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
  } catch (error) {
    failed++;
    console.error(`FAIL  ${label}\n      ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}
const read = (p: string) => readFileSync(p, "utf8");
const ID = "3f2a7c1e-8b4d-4e2f-9a1b-0c5d6e7f8a9b";

// =============================================================================
// 1. Deep link allowlist
// =============================================================================
await check("deep link: allowlist obrazoviek → pevné cesty; ID iba UUID", () => {
  assert.equal(deepLink.pushHrefFromData({ screen: "chat", id: ID }), `/chat/${ID}`);
  assert.equal(deepLink.pushHrefFromData({ screen: "vehicle", id: ID.toUpperCase() }), `/vozidla/${ID}`);
  assert.equal(deepLink.pushHrefFromData({ screen: "machine", id: ID }), `/stroje/${ID}`);
  assert.equal(deepLink.pushHrefFromData({ screen: "chat_index" }), "/chat");
  assert.equal(deepLink.pushHrefFromData({ screen: "deadlines" }), "/");
  assert.equal(deepLink.pushHrefFromData({ screen: "settings" }), "/nastavenia");
});
await check("deep link: žiadne arbitrary URL — url/link/href, neznáma obrazovka, zlé ID → domov", () => {
  for (const evil of [
    { url: "https://evil.example" },
    { screen: "chat", id: "../../etc" },
    { screen: "chat", id: `${ID}/../../x` },
    { screen: "vehicle" },
    { screen: "https://evil.example" },
    { screen: "chat", id: ID, url: "//evil.example" }, // url sa ignoruje, ID platí
    { screen: "__proto__" },
    null,
    "chat",
    { screen: "invoice", id: ID },
  ]) {
    const href = deepLink.pushHrefFromData(evil);
    assert.ok(href === "/" || href === `/chat/${ID}`, JSON.stringify(evil));
    assert.ok(!href.includes("evil") && !href.includes(".."), JSON.stringify(evil));
  }
  assert.deepEqual(deepLink.pushTargetData({ screen: "chat", id: "x" } as never), { screen: "home" });
});
await check("deep link: každý cieľ existuje v mobilnom builde (resolveAppHref) aj na webe", () => {
  const targets = [
    { screen: "chat", id: ID },
    { screen: "vehicle", id: ID },
    { screen: "machine", id: ID },
    { screen: "chat_index" },
    { screen: "deadlines" },
    { screen: "settings" },
    { screen: "home" },
  ] as const;
  for (const target of targets) {
    const href = deepLink.pushTargetHref(target);
    assert.equal(resolveAppHref(href, false), href, `web ${href}`);
    assert.ok(resolveAppHref(href, true), `mobile ${href}`);
  }
  assert.equal(resolveAppHref(deepLink.pushTargetHref({ screen: "chat", id: ID }), true), `/chat?id=${ID}`);
  assert.equal(resolveAppHref(deepLink.pushTargetHref({ screen: "vehicle", id: ID }), true), `/vozidla/detail?id=${ID}`);
});
await check("service worker: rovnaká tabuľka ako lib/push/deep-link.ts, žiadne použitie data.url", () => {
  const source = read("public/sw.js");
  assert.ok(!/data\.url|\.url\)/.test(source.replace(/client\.url/g, "")), "sw nečíta url z payloadu");
  const listeners: Record<string, (event: unknown) => void> = {};
  const sandbox = { self: { addEventListener: (name: string, fn: (event: unknown) => void) => (listeners[name] = fn) } } as Record<string, unknown>;
  vm.runInNewContext(`${source}\n;globalThis.__path = pushTargetPath;`, sandbox);
  const swPath = sandbox.__path as (data: unknown) => string;
  const samples: unknown[] = [
    { screen: "chat", id: ID },
    { screen: "vehicle", id: ID },
    { screen: "machine", id: ID },
    { screen: "chat_index" },
    { screen: "deadlines" },
    { screen: "settings" },
    { screen: "home" },
    { screen: "chat", id: "../x" },
    { url: "https://evil.example" },
    { screen: "vehicle" },
    null,
    { screen: "invoice", id: ID },
  ];
  for (const sample of samples) assert.equal(swPath(sample), deepLink.pushHrefFromData(sample), JSON.stringify(sample));
  assert.ok(listeners.push && listeners.notificationclick);
});

// =============================================================================
// 2. Obsah — jazyk príjemcu, súkromie
// =============================================================================
await check("obsah: jazyk zariadenia príjemcu (sk/de/en), neznámy → sk", () => {
  assert.equal(routing.buildChatPayload({ locale: "de", conversationId: ID, showPreview: false }).title, "Neue Nachricht in Esblu");
  assert.equal(routing.buildChatPayload({ locale: "en", conversationId: ID, showPreview: false }).title, "New message in Esblu");
  assert.equal(routing.buildChatPayload({ locale: "xx", conversationId: ID, showPreview: false }).title, "Nová správa v Esblu");
  assert.equal(routing.buildDeadlinePayload({ locale: "sk", count: 3 }).body, "Blížia sa 3 termíny (STK, EK, známka alebo servis).");
  assert.equal(routing.buildDeadlinePayload({ locale: "sk", count: 5 }).body, "Blíži sa 5 termínov (STK, EK, známka alebo servis).");
  assert.match(routing.buildDeadlinePayload({ locale: "de", count: 2 }).body, /Fristen/);
});
await check("obsah: bez náhľadu všeobecný text; náhľad skrátený; termíny bez ŠPZ; cieľ z allowlistu", () => {
  const chat = routing.buildChatPayload({ locale: "sk", conversationId: ID, messageBody: "Faktúra 1 832 € pre Tester1", showPreview: false });
  assert.equal(chat.body, "Máte novú správu. Otvorte Esblu a prečítajte si ju.");
  assert.ok(!JSON.stringify(chat).includes("1 832"));
  assert.deepEqual(chat.target, { screen: "chat", id: ID });
  const long = routing.buildChatPayload({ locale: "sk", conversationId: ID, messageBody: "a".repeat(500), showPreview: true });
  assert.equal(long.body.length, 120);
  const single = routing.buildDeadlinePayload({ locale: "sk", count: 1, single: { entityType: "vehicle", entityId: ID } });
  assert.deepEqual(single.target, { screen: "vehicle", id: ID });
  const many = routing.buildDeadlinePayload({ locale: "sk", count: 4, single: { entityType: "vehicle", entityId: ID } });
  assert.deepEqual(many.target, { screen: "deadlines" });
  assert.ok(!/[A-Z]{2}\d{3}/.test(many.body));
});

// =============================================================================
// 3. Príjemcovia podľa rolí (owner/admin/employee/accountant/cross-company)
// =============================================================================
const members = [
  { userId: "owner", role: "owner" },
  { userId: "admin", role: "admin" },
  { userId: "acc", role: "accountant" },
  { userId: "emp", role: "employee" },
  { userId: "gone", role: "employee", status: "disabled" },
];
await check("chat príjemcovia: firemný kanál = všetky roly okrem autora (zamestnanec aj účtovník), neaktívny nie", () => {
  assert.deepEqual(routing.chatRecipients({ type: "company", memberUserIds: [] }, members, "owner").sort(), ["acc", "admin", "emp"]);
  assert.deepEqual(routing.chatRecipients({ type: "company", memberUserIds: [] }, members, "emp").sort(), ["acc", "admin", "owner"], "zamestnanec posiela aj prijíma");
});
await check("chat príjemcovia: direct = iba dvojica s riadkom členstva; read-pointer / cudzí používateľ nie", () => {
  const direct = { type: "direct" as const, directUserIds: ["owner", "emp"], memberUserIds: ["owner", "emp", "admin", "foreign"] };
  assert.deepEqual(routing.chatRecipients(direct, members, "owner"), ["emp"]);
  assert.deepEqual(routing.chatRecipients(direct, members, "emp"), ["owner"]);
  assert.deepEqual(routing.chatRecipients({ type: "direct", directUserIds: ["owner", "foreign"], memberUserIds: ["owner", "foreign"] }, members, "owner"), [], "cudzí tenant");
  assert.deepEqual(routing.chatRecipients({ type: "direct", directUserIds: ["owner", "emp"], memberUserIds: ["owner"] }, members, "owner"), [], "bez riadku členstva");
});
await check("termíny: iba owner a admin (prevádzkové oprávnenie); employee, accountant, neaktívny nie", () => {
  assert.deepEqual(routing.deadlineRecipients(members).sort(), ["admin", "owner"]);
  assert.deepEqual(routing.deadlineRecipients([{ userId: "x", role: "superadmin" }]), []);
});
await check("termíny: iba v zvolených oknách a po termíne raz; kľúč na deduplikáciu; entityType zachovaný", () => {
  const items = [
    { deadlineType: "vehicle_stk", entityId: "v1", dueDate: "2026-10-25", daysRemaining: 30, entityType: "vehicle" },
    { deadlineType: "vehicle_ek", entityId: "v1", dueDate: "2026-10-10", daysRemaining: 15, entityType: "vehicle" },
    { deadlineType: "machine_service", entityId: "m1", dueDate: "2026-09-20", daysRemaining: -5, entityType: "machine" },
  ];
  const due = routing.deadlinesToNotify(items, [30, 7, 1, 0]);
  assert.deepEqual(due.map((d) => d.dedupeKey), ["deadline:vehicle_stk:v1:2026-10-25:30", "deadline:machine_service:m1:2026-09-20:overdue"]);
  assert.equal(due[1].item.entityType, "machine");
});

// =============================================================================
// 4. Doručovanie (provider-independent)
// =============================================================================
function memoryStore(targets: DeliveryTarget[]) {
  const claims = new Set<string>();
  const recorded: { id: string; outcome: string }[] = [];
  const asked: { companyId: string; userIds: string[] }[] = [];
  return {
    claims,
    recorded,
    asked,
    store: {
      async targets(companyId: string, userIds: string[]) {
        asked.push({ companyId, userIds });
        return targets;
      },
      async claim(input: { userId: string; dedupeKey: string }) {
        const key = `${input.userId}|${input.dedupeKey}`;
        if (claims.has(key)) return false;
        claims.add(key);
        return true;
      },
      async record(target: DeliveryTarget, outcome: "sent" | "invalid") {
        recorded.push({ id: target.id, outcome });
      },
    },
  };
}
function fakeProvider(kind: "webpush" | "fcm" | "apns", outcomes: Record<string, "sent" | "invalid" | "retry" | "error"> = {}) {
  const sent: { target: DeliveryTarget; message: PushMessage }[] = [];
  return {
    sent,
    provider: {
      kind,
      async send(target: DeliveryTarget, message: PushMessage) {
        sent.push({ target, message });
        return outcomes[target.id] ?? "sent";
      },
    },
  };
}
const T = {
  ownerAndroid: { kind: "fcm", id: "t1", userId: "owner", locale: "de", platform: "android", token: "f".repeat(40) } as DeliveryTarget,
  ownerIphone: { kind: "apns", id: "t2", userId: "owner", locale: "en", platform: "ios", token: "a".repeat(64) } as DeliveryTarget,
  ownerWeb: { kind: "webpush", id: "t3", userId: "owner", locale: "sk", endpoint: "https://push.example/x", p256dh: "p", auth: "a" } as DeliveryTarget,
  empAndroid: { kind: "fcm", id: "t4", userId: "emp", locale: "sk", platform: "android", token: "e".repeat(40) } as DeliveryTarget,
  foreign: { kind: "fcm", id: "t5", userId: "foreign", locale: "sk", platform: "android", token: "z".repeat(40) } as DeliveryTarget,
};
const chatMessage = (userId: string, locale: string) => routing.buildChatPayload({ locale, conversationId: ID, showPreview: userId === "never" });

await check("doručenie: multi-device (Android + iPhone + web) v jazyku KAŽDÉHO zariadenia", async () => {
  const mem = memoryStore([T.ownerAndroid, T.ownerIphone, T.ownerWeb]);
  const f = fakeProvider("fcm");
  const a = fakeProvider("apns");
  const w = fakeProvider("webpush");
  const result = await deliver(mem.store, { fcm: f.provider, apns: a.provider, webpush: w.provider }, { companyId: "A", userIds: ["owner"], kind: "chat", dedupeKey: "chat:m1", messageFor: chatMessage });
  assert.equal(result.sent, 3);
  assert.equal(f.sent[0].message.title, "Neue Nachricht in Esblu");
  assert.equal(a.sent[0].message.title, "New message in Esblu");
  assert.equal(w.sent[0].message.title, "Nová správa v Esblu");
  assert.deepEqual(mem.asked, [{ companyId: "A", userIds: ["owner"] }]);
});
await check("doručenie: idempotencia — tá istá udalosť druhýkrát nič nepošle", async () => {
  const mem = memoryStore([T.ownerAndroid]);
  const f = fakeProvider("fcm");
  const input = { companyId: "A", userIds: ["owner", "owner"], kind: "chat" as const, dedupeKey: "chat:m2", messageFor: chatMessage };
  assert.equal((await deliver(mem.store, { fcm: f.provider }, input)).sent, 1);
  assert.equal((await deliver(mem.store, { fcm: f.provider }, input)).sent, 0);
  assert.equal(f.sent.length, 1);
});
await check("doručenie: neplatný token → record invalid (deaktivácia); retry/error nič nemení", async () => {
  const mem = memoryStore([T.ownerAndroid, T.ownerIphone, T.empAndroid]);
  const f = fakeProvider("fcm", { t1: "invalid", t4: "retry" });
  const a = fakeProvider("apns", { t2: "error" });
  const result = await deliver(mem.store, { fcm: f.provider, apns: a.provider }, { companyId: "A", userIds: ["owner", "emp"], kind: "chat", dedupeKey: "chat:m3", messageFor: chatMessage });
  assert.deepEqual(mem.recorded, [{ id: "t1", outcome: "invalid" }]);
  assert.equal(result.invalid, 1);
  assert.equal(result.failed, 2);
});
await check("doručenie: obrana do hĺbky — cieľ nevyžiadaného (cudzieho) používateľa sa nepošle", async () => {
  const mem = memoryStore([T.ownerAndroid, T.foreign]);
  const f = fakeProvider("fcm");
  await deliver(mem.store, { fcm: f.provider }, { companyId: "A", userIds: ["owner"], kind: "chat", dedupeKey: "chat:m4", messageFor: chatMessage });
  assert.deepEqual(f.sent.map((s) => s.target.id), ["t1"]);
});
await check("doručenie: bez nakonfigurovaného poskytovateľa / bez zariadenia → nič, deduplikácia sa nespotrebuje", async () => {
  const mem = memoryStore([T.ownerIphone]);
  const f = fakeProvider("fcm");
  const result = await deliver(mem.store, { fcm: f.provider }, { companyId: "A", userIds: ["owner", "emp"], kind: "chat", dedupeKey: "chat:m5", messageFor: chatMessage });
  assert.equal(result.sent, 0);
  assert.equal(mem.claims.size, 0, "APNs nie je nakonfigurované → claim sa nezapíše");
});
await check("doručenie: správa s cieľom mimo allowlistu sa nepošle", async () => {
  const mem = memoryStore([T.ownerAndroid]);
  const f = fakeProvider("fcm");
  const result = await deliver(mem.store, { fcm: f.provider }, {
    companyId: "A",
    userIds: ["owner"],
    kind: "chat",
    dedupeKey: null,
    messageFor: () => ({ title: "x", body: "y", tag: "t", target: { screen: "https://evil.example" } as never }),
  });
  assert.equal(result.sent, 0);
  assert.equal(f.sent.length, 0);
});
await check("RPC riadok → DeliveryTarget: neúplný alebo neznámy druh sa zahodí", () => {
  assert.equal(toDeliveryTarget({ target_kind: "fcm", target_id: "1", user_id: "u", platform: "android", locale: "sk", endpoint: null, p256dh: null, auth_secret: null, token: null }), null);
  assert.equal(toDeliveryTarget({ target_kind: "sms", target_id: "1", user_id: "u", platform: "android", locale: "sk", endpoint: null, p256dh: null, auth_secret: null, token: "x" }), null);
  assert.equal(toDeliveryTarget({ target_kind: "apns", target_id: "1", user_id: "u", platform: "ios", locale: "en", endpoint: null, p256dh: null, auth_secret: null, token: "a".repeat(64) })?.kind, "apns");
});

// =============================================================================
// 5. Poskytovatelia — podvrhnutý transport, skutočné podpisy
// =============================================================================
const message = routing.buildChatPayload({ locale: "sk", conversationId: ID, showPreview: false });

await check("konfigurácia: bez env premenných žiadny poskytovateľ; tajomstvá nie sú NEXT_PUBLIC_", () => {
  assert.deepEqual(configuredProviders({}), {});
  assert.equal(fcm.readFcmConfig({ FCM_PROJECT_ID: "esblu", FCM_CLIENT_EMAIL: "x@y" }), null, "bez kľúča");
  assert.equal(apns.readApnsConfig({ APNS_KEY_ID: "ABCDEFGHIJ", APNS_TEAM_ID: "ABCDEFGHIJ" }), null, "bez kľúča");
  for (const file of ["lib/push/providers/fcm.ts", "lib/push/providers/apns.ts", "lib/push/server.ts"]) {
    assert.ok(!/NEXT_PUBLIC_(FCM|APNS)/.test(read(file)), file);
  }
  const clientSide = ["lib/push/client.ts", "lib/push/native.ts", "mobile/app/PushBridge.tsx", "app/components/push/PushRegistrationSync.tsx"];
  for (const file of clientSide) assert.ok(!/FCM_PRIVATE_KEY|APNS_PRIVATE_KEY|VAPID_PRIVATE_KEY|getSupabaseAdmin|supabase-admin/.test(read(file)), file);
});

await check("FCM HTTP v1: OAuth JWT RS256 podpísaný kľúčom, správa s tokenom, data iba screen/id/tag, kanál", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString().replace(/\n/g, "\\n");
  const config = fcm.readFcmConfig({ FCM_PROJECT_ID: "esblu-test", FCM_CLIENT_EMAIL: "svc@esblu-test.iam.gserviceaccount.com", FCM_PRIVATE_KEY: pem });
  assert.ok(config);
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("oauth2")) return new Response(JSON.stringify({ access_token: "ya29.test", expires_in: 3600 }), { status: 200 });
    return new Response(JSON.stringify({ name: "projects/esblu-test/messages/1" }), { status: 200 });
  }) as unknown as typeof fetch;
  const provider = fcm.createFcmProvider(config!, fakeFetch);
  assert.equal(await provider.send(T.ownerAndroid, message), "sent");
  assert.equal(await provider.send(T.empAndroid, message), "sent");
  assert.equal(calls.filter((c) => c.url.includes("oauth2")).length, 1, "prístupový token sa cachuje");
  const assertion = new URLSearchParams(String(calls[0].init.body)).get("assertion")!;
  const [h, p, s] = assertion.split(".");
  assert.ok(verify("RSA-SHA256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, "base64url")));
  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  assert.equal(claims.scope, "https://www.googleapis.com/auth/firebase.messaging");
  const send = calls[1];
  assert.equal(send.url, "https://fcm.googleapis.com/v1/projects/esblu-test/messages:send");
  const body = JSON.parse(String(send.init.body));
  assert.equal(body.message.token, T.ownerAndroid.kind === "fcm" ? T.ownerAndroid.token : "");
  assert.deepEqual(Object.keys(body.message.data).sort(), ["id", "screen", "tag"]);
  assert.equal(body.message.android.notification.channel_id, "esblu_default");
  assert.ok(!JSON.stringify(body).includes("http://") && !JSON.stringify(body).includes("url"));
});
await check("FCM: mapovanie chýb (UNREGISTERED/404/SENDER_ID_MISMATCH/neplatný token → invalid; 429/5xx → retry)", () => {
  assert.equal(fcm.classifyFcmError(404, { error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } }), "invalid");
  assert.equal(fcm.classifyFcmError(403, { error: { status: "PERMISSION_DENIED", details: [{ errorCode: "SENDER_ID_MISMATCH" }] } }), "invalid");
  assert.equal(fcm.classifyFcmError(400, { error: { status: "INVALID_ARGUMENT", message: "The registration token is not a valid FCM registration token" } }), "invalid");
  assert.equal(fcm.classifyFcmError(400, { error: { status: "INVALID_ARGUMENT", message: "Invalid JSON payload" } }), "error");
  assert.equal(fcm.classifyFcmError(429, null), "retry");
  assert.equal(fcm.classifyFcmError(503, null), "retry");
  assert.equal(fcm.classifyFcmError(401, null), "error");
});
await check("APNs: ES256 provider token (kid, iss), HTTP/2 hlavičky, alert + screen/id, 410 → invalid", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const config = apns.readApnsConfig({ APNS_KEY_ID: "ABC123DEFG", APNS_TEAM_ID: "TEAM123456", APNS_PRIVATE_KEY: pem, APNS_ENVIRONMENT: "development" });
  assert.ok(config);
  assert.equal(config!.host, "api.sandbox.push.apple.com");
  assert.equal(apns.readApnsConfig({ APNS_KEY_ID: "ABC123DEFG", APNS_TEAM_ID: "TEAM123456", APNS_PRIVATE_KEY: pem })!.host, "api.push.apple.com");
  const requests: import("@/lib/push/providers/apns").ApnsRequest[] = [];
  let status = 200;
  const provider = apns.createApnsProvider(config!, async (request) => {
    requests.push(request);
    return { status, body: status === 200 ? "" : JSON.stringify({ reason: status === 410 ? "Unregistered" : "TooManyRequests" }) };
  });
  assert.equal(await provider.send(T.ownerIphone, message), "sent");
  const request = requests[0];
  assert.equal(request.path, `/3/device/${"a".repeat(64)}`);
  assert.equal(request.headers["apns-topic"], "com.esblu.app");
  assert.equal(request.headers["apns-push-type"], "alert");
  const jwt = request.headers.authorization.replace(/^bearer /, "");
  const [h, p, s] = jwt.split(".");
  assert.ok(verify("sha256", Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")));
  assert.equal(JSON.parse(Buffer.from(h, "base64url").toString()).kid, "ABC123DEFG");
  assert.equal(JSON.parse(Buffer.from(p, "base64url").toString()).iss, "TEAM123456");
  const payload = JSON.parse(request.body);
  assert.equal(payload.aps.alert.title, "Nová správa v Esblu");
  assert.equal(payload.screen, "chat");
  status = 410;
  assert.equal(await provider.send(T.ownerIphone, message), "invalid");
  status = 429;
  assert.equal(await provider.send(T.ownerIphone, message), "retry");
  assert.equal(apns.classifyApnsError(400, JSON.stringify({ reason: "BadDeviceToken" })), "invalid");
  assert.equal(apns.classifyApnsError(403, JSON.stringify({ reason: "InvalidProviderToken" })), "error");
  assert.equal(await provider.send({ ...T.ownerIphone, token: "not-hex" } as DeliveryTarget, message), "invalid", "zlý tvar tokenu");
});
await check("Web Push: telo obsahuje iba title/body/tag/screen/id (žiadna url)", () => {
  const body = webpush.webPushBody(message);
  assert.deepEqual(Object.keys(body).sort(), ["body", "id", "screen", "tag", "title"]);
});

// =============================================================================
// 6. Vstup /api/push/devices
// =============================================================================
await check("device input: iba fcm/android|ios a apns/ios; token, installationId UUID, jazyk normalizovaný", () => {
  const ok = readNativeDevice({ provider: "fcm", platform: "android", token: "f".repeat(40), installationId: ID.toUpperCase(), locale: "de", appVersion: "1.2.3" });
  assert.deepEqual(ok, { provider: "fcm", platform: "android", token: "f".repeat(40), installationId: ID, locale: "de", appVersion: "1.2.3" });
  assert.equal(readNativeDevice({ provider: "apns", platform: "android", token: "a".repeat(64), installationId: ID }), null);
  assert.equal(readNativeDevice({ provider: "webpush", platform: "web", token: "a".repeat(64), installationId: ID }), null);
  assert.equal(readNativeDevice({ provider: "fcm", platform: "android", token: "short", installationId: ID }), null);
  assert.equal(readNativeDevice({ provider: "fcm", platform: "android", token: "f".repeat(40), installationId: "abc" }), null);
  assert.equal(readNativeDevice({ provider: "fcm", platform: "android", token: `${"f".repeat(40)} <script>`, installationId: ID }), null);
  assert.equal(readNativeDevice({ provider: "fcm", platform: "android", token: "f".repeat(40), installationId: ID, locale: "ru" })?.locale, "sk");
  assert.equal(readNativeDevice({ provider: "fcm", platform: "android", token: "f".repeat(40), installationId: ID, appVersion: "1; drop" })?.appVersion, null);
  assert.equal(readUnregisterInput({}), null);
  assert.deepEqual(readUnregisterInput({ installationId: ID }), { installationId: ID, token: null });
});

// =============================================================================
// 7. Bezpečnostné invarianty kódu
// =============================================================================
await check("routes: user/firma/session nikdy z tela; registrácia cez user-scoped RPC; server RPC cez service role", () => {
  const request = read("lib/push/request.ts");
  assert.ok(request.includes("verifyRequestUser") && request.includes("getUserScopedSupabaseClient"));
  for (const file of ["app/api/push/subscribe/route.ts", "app/api/push/devices/route.ts", "app/api/push/preferences/route.ts"]) {
    const code = read(file);
    assert.ok(code.includes("authorizePushCaller"), file);
    assert.ok(!/getSupabaseAdmin|supabase-admin/.test(code), `${file}: žiadny service role pri registrácii`);
    assert.ok(!/body\??\.(userId|user_id|companyId|company_id|sessionId|session_id)/.test(code), `${file}: nič z tela`);
    assert.ok(!/p_user_id|p_company_id|p_session/.test(code), file);
  }
  const chat = read("app/api/push/chat-message/route.ts");
  assert.ok(chat.includes("row.author_id !== who.userId") && chat.includes("chat:${row.id}") && chat.includes("esblu_push_chat_recipients"));
  assert.ok(!/aiAssistantAccess|assistantLauncherAllowed|intents\//.test(chat), "Human Chat push sa nemieša s AI oprávneniami");
  const cron = read("app/api/cron/deadline-notifications/route.ts");
  assert.ok(cron.includes("timingSafeEqual") && cron.includes("CRON_SECRET") && cron.includes("esblu_push_revoke_ended") && cron.includes("deadlineRecipients"));
  assert.ok(!cron.includes('locale: "sk", count'), "termíny už nie natvrdo v slovenčine");
});
await check("web bundle: @capacitor/push-notifications iba v lib/push/native.ts; ten sa na webe načíta iba dynamicky", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(name)) {
        const code = read(full);
        if (code.includes("@capacitor/push-notifications") && full !== path.join("lib", "push", "native.ts")) offenders.push(full);
        if (/^import[^;]*["']@\/lib\/push\/native["']/m.test(code) && !full.startsWith("mobile")) offenders.push(`${full} (statický import native)`);
      }
    }
  };
  for (const dir of ["app", "lib", "hooks", "mobile/app"]) walk(dir);
  assert.deepEqual(offenders, []);
  const client = read("lib/push/client.ts");
  assert.ok(client.includes('await import("@/lib/push/native")'));
});
await check("natívny push: povolenie iba z kliknutia; kliknutie na notifikáciu cez allowlist, nie URL", () => {
  const native = read("lib/push/native.ts");
  const refresh = native.slice(native.indexOf("export async function refreshNativePush"), native.indexOf("export async function startNativePushBridge"));
  assert.ok(!refresh.includes("requestPermissions"), "obnova nežiada povolenie");
  assert.ok(native.includes("pushHrefFromData(action?.notification?.data)"));
  assert.ok(!/notification\??\.(link|click_action|url)/.test(native));
  const bridge = read("mobile/app/PushBridge.tsx");
  assert.ok(bridge.includes("resolveAppHref(href, true)"));
  assert.ok(read("mobile/app/layout.tsx").includes("<PushBridge />"));
  assert.ok(!read("app/layout.tsx").includes("requestPermission"));
  assert.ok(read("mobile/android/app/src/main/AndroidManifest.xml").includes("android.permission.POST_NOTIFICATIONS"));
  assert.ok(read("mobile/android/capacitor.settings.gradle").includes(":capacitor-push-notifications"));
});
await check("odhlásenie: disablePushOnThisDevice odregistruje aj natívne zariadenie (sign-out cesta)", () => {
  const client = read("lib/push/client.ts");
  const disable = client.slice(client.indexOf("export async function disablePushOnThisDevice"), client.indexOf("export async function refreshPushRegistration"));
  assert.ok(disable.includes("disableNativePush"));
  assert.ok(read("lib/sign-out.ts").includes("disablePushOnThisDevice"));
  const native = read("lib/push/native.ts");
  assert.ok(native.includes('method: "DELETE"') && native.includes("PushNotifications.unregister()"));
  assert.ok(native.includes("enabledForCurrentUser"), "zapnutie nezdedí iný používateľ na tom istom zariadení");
});
await check("migrácia: NEAPLIKOVANÁ hlavička, RLS bez politík, service RPC nie pre authenticated", () => {
  const sql = read("supabase/migrations/20261001130000_push_devices_session_binding.sql");
  assert.ok(sql.includes("NEAPLIKOVANÉ") && sql.includes("ROLLBACK"));
  assert.ok(sql.includes("alter table public.push_devices enable row level security;"));
  assert.ok(sql.includes("revoke all on public.push_devices from public, anon, authenticated;"));
  const code = sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
  assert.ok(!/create policy/i.test(code));
  assert.ok(!/grant[^;]*on\s+(table\s+)?public\.push_devices[^;]*to\s+(authenticated|anon)/i.test(code));
  for (const fn of ["esblu_push_delivery_targets", "esblu_push_chat_recipients", "esblu_push_record_outcome", "esblu_push_revoke_ended", "esblu_push_companies_with_targets"]) {
    const grants = code.match(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to ([a-z_]+);`));
    assert.equal(grants?.[1], "service_role", fn);
  }
  assert.ok(!/drop table|truncate|delete from/i.test(code), "žiadne deštruktívne operácie");
});

console.log(`\n${passed} prešlo, ${failed} zlyhalo`);
if (failed > 0) process.exit(1);
