"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import type { ChatEntityType } from "@/lib/chat";

type PickerResult = {
  entityId: string;
  title: string;
  subtitle: string | null;
};

const TABS: ChatEntityType[] = [
  "vehicle",
  "machine",
  "inventory_item",
  "document",
];

/**
 * "Pripojiť z Esblu" — výber objektu na pripojenie k rozpísanej správe.
 * Vyhľadávanie beží cez normálny supabase.from(...).select() (bežné RLS,
 * rovnaké company-wide SELECT ako zvyšok appky) — toto NIE JE server-side
 * overenie referencie, to robí až esblu_attach_chat_message_reference() po
 * odoslaní správy (pozri lib/chat.ts). Tento modal iba pomáha vybrať
 * entity_id.
 */
export default function EntityPickerModal({
  onClose,
  onSelect,
}: {
  onClose: () => void;
  onSelect: (entityType: ChatEntityType, entityId: string, label: string) => void;
}) {
  const { t } = useLocale();
  const [tab, setTab] = useState<ChatEntityType>("vehicle");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PickerResult[]>([]);
  const [loading, setLoading] = useState(false);

  const tabLabels: Record<ChatEntityType, string> = {
    vehicle: t("chat.entityPicker.typeVehicle"),
    machine: t("chat.entityPicker.typeMachine"),
    inventory_item: t("chat.entityPicker.typeInventoryItem"),
    document: t("chat.entityPicker.typeDocument"),
    vehicle_service: t("chat.entityPicker.typeVehicleService"),
    machine_service: t("chat.entityPicker.typeMachineService"),
  };

  useEffect(() => {
    let cancelled = false;

    async function search() {
      setLoading(true);

      try {
        const rows = await searchEntities(tab, query);
        if (!cancelled) setResults(rows);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    search();

    return () => {
      cancelled = true;
    };
  }, [tab, query]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center">
      <div className="surface-card flex max-h-[80vh] w-full max-w-lg flex-col p-4 sm:rounded-doc">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[15px] font-semibold text-primary">
            {t("chat.entityPicker.title")}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.buttons.close")}
            className="flex h-8 w-8 items-center justify-center rounded-doc-sm border border-doc-border text-sm text-secondary transition hover:bg-surface-hover hover:text-primary"
          >
            ✕
          </button>
        </div>

        <div className="mb-2.5 flex gap-1 overflow-x-auto pb-1">
          {TABS.map((entityType) => (
            <button
              key={entityType}
              type="button"
              onClick={() => setTab(entityType)}
              className={`inline-flex min-h-8 shrink-0 items-center rounded-doc-sm border px-2.5 text-xs font-medium transition ${
                tab === entityType
                  ? "border-transparent bg-accent-esblu text-on-accent"
                  : "border-doc-border bg-surface-2 text-secondary hover:text-primary"
              }`}
            >
              {tabLabels[entityType]}
            </button>
          ))}
        </div>

        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("chat.entityPicker.searchPlaceholder")}
          className="mb-2.5 w-full min-h-[var(--control-h)] rounded-doc-sm border border-doc-border bg-surface-2 px-3 py-1.5 text-sm text-primary outline-none transition placeholder:text-muted-esblu focus:border-brand-400 focus:ring-2 focus:ring-brand-400/25"
        />

        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
          {loading ? (
            <p className="px-1 text-xs text-muted-esblu">
              {t("common.buttons.loading")}
            </p>
          ) : results.length === 0 ? (
            <p className="px-1 text-xs text-muted-esblu">
              {t("chat.entityPicker.noResults")}
            </p>
          ) : (
            results.map((row) => (
              <button
                key={row.entityId}
                type="button"
                onClick={() => onSelect(tab, row.entityId, row.title)}
                className="surface-card-hover flex w-full flex-col items-start gap-0.5 rounded-doc-sm border border-subtle bg-surface-1/60 px-3 py-2 text-left transition"
              >
                <span className="truncate text-sm font-semibold text-primary">
                  {row.title}
                </span>
                {row.subtitle && (
                  <span className="truncate text-xs text-muted-esblu">
                    {row.subtitle}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

async function searchEntities(
  entityType: ChatEntityType,
  query: string
): Promise<PickerResult[]> {
  const q = query.trim();

  if (entityType === "vehicle") {
    let builder = supabase
      .from("vehicles")
      .select("id, znacka, model, spz")
      .limit(20);

    if (q) {
      builder = builder.or(
        `znacka.ilike.%${q}%,model.ilike.%${q}%,spz.ilike.%${q}%`
      );
    }

    const { data } = await builder;

    return (data || []).map((v) => ({
      entityId: v.id,
      title: `${v.znacka || ""} ${v.model || ""}`.trim() || v.spz || "",
      subtitle: v.spz || null,
    }));
  }

  if (entityType === "machine") {
    let builder = supabase
      .from("machines")
      .select("id, name, category")
      .limit(20);

    if (q) builder = builder.ilike("name", `%${q}%`);

    const { data } = await builder;

    return (data || []).map((m) => ({
      entityId: m.id,
      title: m.name || "",
      subtitle: m.category || null,
    }));
  }

  if (entityType === "inventory_item") {
    let builder = supabase
      .from("inventory_items")
      .select("id, name, quantity, unit")
      .limit(20);

    if (q) builder = builder.ilike("name", `%${q}%`);

    const { data } = await builder;

    return (data || []).map((i) => ({
      entityId: i.id,
      title: i.name || "",
      subtitle: i.quantity != null ? `${i.quantity} ${i.unit || ""}`.trim() : null,
    }));
  }

  if (entityType === "document") {
    let builder = supabase
      .from("documents")
      .select("id, original_filename, document_type")
      .is("deleted_at", null)
      .limit(20);

    if (q) builder = builder.ilike("original_filename", `%${q}%`);

    const { data } = await builder;

    return (data || []).map((d) => ({
      entityId: d.id,
      title: d.original_filename || d.document_type || "",
      subtitle: d.document_type || null,
    }));
  }

  return [];
}
