import type { PushMessage } from "@/lib/push/routing";
import { readPushTarget } from "@/lib/push/deep-link";
import type { DeliveryTarget, PushProviders, SendOutcome } from "@/lib/push/providers/types";

// =============================================================================
// Doručenie jednej udalosti (chat správa / termíny) — bez DB a bez
// konkrétneho poskytovateľa (oboje sa vkladá), testované v Node.
//
//   1. ciele = zariadenia používateľov JEDNEJ firmy (store.targets — v DB
//      iba nezrušené, so živou session a aktívnym členstvom v tej firme),
//   2. používateľ bez zariadenia s nakonfigurovaným poskytovateľom → nič,
//   3. deduplikácia na používateľa (store.claim; unique user_id+dedupe_key)
//      — opakované volanie tej istej udalosti nič nepošle,
//   4. obsah v jazyku ZARIADENIA (messageFor(userId, locale)); cieľ musí
//      prejsť allowlistom, inak sa nepošle nič,
//   5. výsledok poskytovateľa: sent → úspech, invalid → zariadenie zrušiť,
//      retry/error → nemeniť.
// =============================================================================

export type DeliveryStore = {
  targets(companyId: string, userIds: string[]): Promise<DeliveryTarget[]>;
  claim(input: { companyId: string; userId: string; kind: "chat" | "deadline"; dedupeKey: string }): Promise<boolean>;
  record(target: DeliveryTarget, outcome: "sent" | "invalid"): Promise<void>;
};

export type DeliveryInput = {
  companyId: string;
  userIds: string[];
  kind: "chat" | "deadline";
  /** null = bez deduplikácie (volajúci ju spravil sám, napr. po termínoch). */
  dedupeKey: string | null;
  messageFor: (userId: string, locale: string) => PushMessage;
};

export type DeliveryResult = { sent: number; invalid: number; failed: number; users: number };

export async function deliver(store: DeliveryStore, providers: PushProviders, input: DeliveryInput): Promise<DeliveryResult> {
  const result: DeliveryResult = { sent: 0, invalid: 0, failed: 0, users: 0 };
  const userIds = Array.from(new Set(input.userIds));
  if (userIds.length === 0) return result;

  const all = await store.targets(input.companyId, userIds);
  const byUser = new Map<string, DeliveryTarget[]>();
  for (const target of all) {
    // Obrana do hĺbky: iba vyžiadaní používatelia a iba s poskytovateľom.
    if (!userIds.includes(target.userId) || !providers[target.kind]) continue;
    const list = byUser.get(target.userId) ?? [];
    list.push(target);
    byUser.set(target.userId, list);
  }

  for (const userId of userIds) {
    const targets = byUser.get(userId);
    if (!targets || targets.length === 0) continue;
    if (input.dedupeKey) {
      const fresh = await store.claim({ companyId: input.companyId, userId, kind: input.kind, dedupeKey: input.dedupeKey });
      if (!fresh) continue;
    }
    result.users++;
    for (const target of targets.slice(0, 20)) {
      const message = input.messageFor(userId, target.locale);
      if (!readPushTarget(message.target)) {
        result.failed++;
        continue;
      }
      let outcome: SendOutcome;
      try {
        outcome = await providers[target.kind]!.send(target, message);
      } catch {
        outcome = "retry";
      }
      if (outcome === "sent") {
        result.sent++;
        await store.record(target, "sent");
      } else if (outcome === "invalid") {
        result.invalid++;
        await store.record(target, "invalid");
      } else {
        result.failed++;
      }
    }
  }
  return result;
}
