import { supabase } from "@/lib/supabase";
import {
  vehicleDetailHref,
  machineDetailHref,
  inventoryItemDetailHref,
} from "@/lib/entity-links";

// =============================================================================
// Esblu — Interný firemný chat: zdieľané typy + klientske helpery
// =============================================================================
// Zrkadlí presne DB schému zavedenú v
// supabase/migrations/20260827100000_add_chat_core.sql a
// 20260827110000_add_chat_storage.sql. Rovnaký vzor ako lib/company.ts /
// lib/vehicle-vignettes.ts — RPC volania cez supabase.rpc(), autorizácia sa
// vždy vynucuje na strane DB (RLS + SECURITY DEFINER funkcie), toto je iba
// typovaná UI vrstva.
// =============================================================================

export type ChatConversationType = "company" | "direct";

export type ChatConversation = {
  id: string;
  company_id: string;
  type: ChatConversationType;
  direct_user_low: string | null;
  direct_user_high: string | null;
  created_at: string;
  created_by: string | null;
};

export type ChatMessage = {
  id: string;
  conversation_id: string;
  company_id: string;
  author_id: string | null;
  body: string;
  created_at: string;
  updated_at: string | null;
  edited_at: string | null;
  deleted_at: string | null;
};

export type ChatAttachment = {
  id: string;
  message_id: string;
  company_id: string;
  storage_bucket: string;
  storage_path: string;
  original_filename: string | null;
  mime_type: string;
  file_size: number;
  created_at: string;
};

export type ChatEntityType =
  | "vehicle"
  | "machine"
  | "inventory_item"
  | "document"
  | "vehicle_service"
  | "machine_service";

export type ChatMessageReference = {
  id: string;
  message_id: string;
  company_id: string;
  entity_type: ChatEntityType;
  entity_id: string;
  created_at: string;
};

export type CompanyMemberForChat = {
  user_id: string;
  email: string;
  role: "owner" | "admin" | "accountant" | "employee";
};

export type UnreadCountRow = {
  conversation_id: string;
  conversation_type: ChatConversationType;
  unread_count: number;
};

// -----------------------------------------------------------------------------
// Prílohy — limity a povolené typy (zrkadlí bucket chat-attachments,
// 20260827110000, a chat_attachments_file_size_check, 20260827100000).
// -----------------------------------------------------------------------------

export const CHAT_ATTACHMENT_MAX_BYTES = 15 * 1024 * 1024; // 15 MB

export const CHAT_ATTACHMENT_ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
] as const;

const MIME_TO_EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

export function isAllowedChatAttachmentMime(mimeType: string): boolean {
  return (CHAT_ATTACHMENT_ALLOWED_MIME_TYPES as readonly string[]).includes(
    mimeType
  );
}

/**
 * Bezpečná, generovaná Storage cesta pre prílohu — NIKDY pôvodný názov
 * súboru (ten ostáva iba v chat_attachments.original_filename). Rovnaký
 * princíp ako ai-inbox-documents (20260812160000).
 */
export function buildChatAttachmentStoragePath(
  companyId: string,
  conversationId: string,
  messageId: string,
  mimeType: string
): string {
  const extension = MIME_TO_EXTENSION[mimeType] || "bin";
  const randomName =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return `${companyId}/${conversationId}/${messageId}/${randomName}.${extension}`;
}

// -----------------------------------------------------------------------------
// RPC wrappery
// -----------------------------------------------------------------------------

export async function ensureCompanyChatChannel(): Promise<string> {
  const { data, error } = await supabase.rpc(
    "esblu_ensure_company_chat_channel"
  );

  if (error) throw error;
  if (!data) throw new Error("ESBLU_CHAT_CHANNEL_NOT_CREATED");

  return data as string;
}

export async function getOrCreateDirectConversation(
  otherUserId: string
): Promise<string> {
  const { data, error } = await supabase.rpc(
    "esblu_get_or_create_direct_conversation",
    { p_other_user_id: otherUserId }
  );

  if (error) throw error;
  if (!data) throw new Error("ESBLU_CHAT_CONVERSATION_NOT_CREATED");

  return data as string;
}

export async function listCompanyMembersForChat(): Promise<
  CompanyMemberForChat[]
> {
  const { data, error } = await supabase.rpc(
    "esblu_list_company_members_for_chat"
  );

  if (error) throw error;

  return (data as CompanyMemberForChat[]) || [];
}

export async function markConversationRead(
  conversationId: string
): Promise<void> {
  const { error } = await supabase.rpc("esblu_mark_conversation_read", {
    p_conversation_id: conversationId,
  });

  if (error) throw error;
}

export async function getMyUnreadCounts(): Promise<UnreadCountRow[]> {
  const { data, error } = await supabase.rpc("esblu_get_my_unread_counts");

  if (error) throw error;

  return (data as UnreadCountRow[]) || [];
}

export async function attachChatMessageReference(
  messageId: string,
  entityType: ChatEntityType,
  entityId: string
): Promise<ChatMessageReference> {
  const { data, error } = await supabase.rpc(
    "esblu_attach_chat_message_reference",
    {
      p_message_id: messageId,
      p_entity_type: entityType,
      p_entity_id: entityId,
    }
  );

  if (error) throw error;

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error("ESBLU_CHAT_REFERENCE_NOT_CREATED");

  return row as ChatMessageReference;
}

// -----------------------------------------------------------------------------
// Chybové kódy → i18n kľúče (rovnaký vzor ako lib/company.ts)
// -----------------------------------------------------------------------------

const CHAT_ERROR_CODES = [
  "ESBLU_NO_ACTIVE_COMPANY",
  "ESBLU_CANNOT_MESSAGE_SELF",
  "ESBLU_NOT_SAME_COMPANY",
  "ESBLU_CONVERSATION_NOT_FOUND_OR_FORBIDDEN",
  "ESBLU_MESSAGE_NOT_FOUND",
  "ESBLU_MESSAGE_DELETED",
  "ESBLU_FORBIDDEN_NOT_MESSAGE_AUTHOR",
  "ESBLU_INVALID_ENTITY_TYPE",
  "ESBLU_ENTITY_NOT_FOUND_OR_FORBIDDEN",
  "ESBLU_COMPANY_DPA_NOT_ACCEPTED",
  "ESBLU_NO_CURRENT_DPA",
] as const;

export function getChatErrorMessage(
  error: unknown,
  t: (key: string) => string
): string {
  const text =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";

  for (const code of CHAT_ERROR_CODES) {
    if (text.includes(code)) {
      return t(`chat.errors.${code}`);
    }
  }

  if (text.includes("NOT_AUTHENTICATED")) {
    return t("auth.notAuthenticated");
  }

  return t("chat.errors.genericFailed");
}

// -----------------------------------------------------------------------------
// Live entity-card resolvovanie ("Pripojiť z Esblu") — VŽDY čerstvý SELECT
// cez bežné RLS prihláseného používateľa, žiadny snapshot. Vracia null, ak
// objekt neexistuje / bol zmazaný / naň volajúci nemá (už) prístup — UI má
// v tom prípade zobraziť "Objekt už nie je dostupný", nie chybu.
// -----------------------------------------------------------------------------

export type ResolvedEntityCard = {
  entityType: ChatEntityType;
  entityId: string;
  title: string;
  subtitle: string | null;
  /** Route na detail, alebo null (napr. dokument — otvára sa signed URL). */
  href: string | null;
};

export async function resolveChatEntityCard(
  entityType: ChatEntityType,
  entityId: string
): Promise<ResolvedEntityCard | null> {
  switch (entityType) {
    case "vehicle": {
      const { data } = await supabase
        .from("vehicles")
        .select("id, znacka, model, spz")
        .eq("id", entityId)
        .maybeSingle();

      if (!data) return null;

      return {
        entityType,
        entityId,
        title: `${data.znacka || ""} ${data.model || ""}`.trim() || data.spz || "",
        subtitle: data.spz || null,
        href: vehicleDetailHref(data.id),
      };
    }
    case "machine": {
      const { data } = await supabase
        .from("machines")
        .select("id, name, category")
        .eq("id", entityId)
        .maybeSingle();

      if (!data) return null;

      return {
        entityType,
        entityId,
        title: data.name || "",
        subtitle: data.category || null,
        href: machineDetailHref(data.id),
      };
    }
    case "inventory_item": {
      const { data } = await supabase
        .from("inventory_items")
        .select("id, name, quantity, unit")
        .eq("id", entityId)
        .maybeSingle();

      if (!data) return null;

      return {
        entityType,
        entityId,
        title: data.name || "",
        subtitle:
          data.quantity != null ? `${data.quantity} ${data.unit || ""}`.trim() : null,
        href: inventoryItemDetailHref(data.id),
      };
    }
    case "document": {
      const { data } = await supabase
        .from("documents")
        .select("id, original_filename, document_type, storage_bucket, storage_path")
        .eq("id", entityId)
        .is("deleted_at", null)
        .maybeSingle();

      if (!data) return null;

      return {
        entityType,
        entityId,
        title: data.original_filename || data.document_type || "",
        subtitle: data.document_type || null,
        // Žiadna detail route (Esblu ju pre dokumenty nemá) — UI má na
        // kliknutie vygenerovať createSignedUrl(storage_bucket, storage_path)
        // a otvoriť originál, rovnaký vzor ako /ai-evidencia a
        // /vozidla/[id] náhľady príloh.
        href: null,
      };
    }
    case "vehicle_service": {
      const { data } = await supabase
        .from("vehicle_services")
        .select("id, vehicle_id, title, service_date")
        .eq("id", entityId)
        .maybeSingle();

      if (!data) return null;

      return {
        entityType,
        entityId,
        title: data.title || "",
        subtitle: data.service_date || null,
        // Servisný záznam nemá vlastnú detail routu — smeruje na detail
        // rodičovského vozidla (rovnaký princíp ako VehicleDetailView).
        href: vehicleDetailHref(data.vehicle_id),
      };
    }
    case "machine_service": {
      const { data } = await supabase
        .from("machine_services")
        .select("id, machine_id, title, service_date")
        .eq("id", entityId)
        .maybeSingle();

      if (!data) return null;

      return {
        entityType,
        entityId,
        title: data.title || "",
        subtitle: data.service_date || null,
        // Rovnaký princíp ako vehicle_service — smeruje na detail
        // rodičovského stroja.
        href: machineDetailHref(data.machine_id),
      };
    }
    default:
      return null;
  }
}
