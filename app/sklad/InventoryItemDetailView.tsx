"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import BackLink from "@/app/components/BackLink";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { formatDate, formatNumber } from "@/lib/i18n/format";
import { stockStatus, type InventoryItemRow } from "@/lib/inventory";
import {
  PageShell,
  PageHeader,
  SectionPanel,
  MetricGrid,
  Metric,
  MetadataGrid,
  Notice,
  EmptyState,
  StatusBadge,
} from "@/app/components/ui/Primitives";
import { PackageIcon } from "@/app/components/icons/AppIcons";

type InventoryPhoto = {
  id: string;
  file_path: string;
};

// -----------------------------------------------------------------------------
// Detail skladovej položky.
//
// Pôvodne to bolo 75 riadkov štyroch `<b>štítok:</b> hodnota` odsekov v
// napevno dvojstĺpcovej mriežke (aj na 360 px telefóne) a nič viac —
// najtenší detail v celej appke. Fotky položky sa síce ukladali, ale
// nikde sa nezobrazovali.
//
// Čo tu ZÁMERNE NIE JE, pretože to model nemá (nahlásené ako gap, nie
// dopĺňané naslepo): SKU, jednotková cena a hodnota zásoby, história
// pohybov a "posledná zmena" (tabuľka má iba created_at).
// -----------------------------------------------------------------------------
export default function InventoryItemDetailView({ entityId }: { entityId: string }) {
  const { t, locale } = useLocale();
  const [item, setItem] = useState<InventoryItemRow | null>(null);
  const [photos, setPhotos] = useState<InventoryPhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId]);

  async function load() {
    setLoading(true);
    setLoadError("");

    const { data, error } = await supabase
      .from("inventory_items")
      .select("*")
      .eq("id", entityId)
      .maybeSingle();

    if (error) {
      setLoadError(t("inventory.errors.loadFailedPrefix", { message: error.message }));
      setLoading(false);
      return;
    }

    setItem((data as InventoryItemRow) ?? null);

    if (data) {
      const { data: photoRows } = await supabase
        .from("inventory_photos")
        .select("id, file_path")
        .eq("inventory_item_id", entityId)
        .order("created_at", { ascending: false });

      setPhotos((photoRows as InventoryPhoto[]) ?? []);
    }

    setLoading(false);
  }

  function photoUrl(path: string) {
    return supabase.storage.from("inventory-photos").getPublicUrl(path).data.publicUrl;
  }

  if (loading) {
    return (
      <PageShell moduleContext="inventory" uiContext={{ module: "inventory", entityType: "inventory_item", entityId }}>
        <p className="py-10 text-sm text-secondary">{t("common.buttons.loading")}</p>
      </PageShell>
    );
  }

  if (loadError || !item) {
    return (
      <PageShell moduleContext="inventory" uiContext={{ module: "inventory", entityType: "inventory_item", entityId }}>
        <BackLink href="/sklad" label={t("nav.inventory")} className="mb-6" />
        <Notice tone="critical">{loadError || t("inventory.errors.notFound")}</Notice>
      </PageShell>
    );
  }

  const status = stockStatus(item);
  const quantity =
    typeof item.quantity === "number" ? formatNumber(item.quantity, locale) : "—";

  const statusBadge =
    status === "out" ? (
      <StatusBadge kind="error" label={t("inventory.stock.out")} />
    ) : status === "low" ? (
      <StatusBadge kind="needs_review" label={t("inventory.stock.low")} />
    ) : status === "ok" ? (
      <StatusBadge kind="paid" label={t("inventory.stock.ok")} />
    ) : (
      <StatusBadge kind="draft" label={t("inventory.stock.untracked")} />
    );

  return (
    <PageShell moduleContext="inventory" uiContext={{ module: "inventory", entityType: "inventory_item", entityId }}>
      <BackLink href="/sklad" label={t("nav.inventory")} className="mb-6" />

      <PageHeader
        eyebrow={
          <span className="inline-flex items-center gap-2">
            <PackageIcon size={18} />
            {item.category || t("nav.inventory")}
          </span>
        }
        title={item.name || t("dashboard.noName")}
        badges={statusBadge}
        meta={item.location || undefined}
      />

      {status === "low" && (
        <div className="mt-4">
          <Notice tone="warning">{t("inventory.detail.lowStockBadge")}</Notice>
        </div>
      )}
      {status === "out" && (
        <div className="mt-4">
          <Notice tone="critical">{t("inventory.detail.outOfStockNotice")}</Notice>
        </div>
      )}

      {/* Množstvo je hlavná informácia skladu — dostáva najväčšie číslo
          na stránke, nie riadok "Množstvo: 24" niekde v zozname polí. */}
      <div className="mt-6">
        <MetricGrid>
          <Metric
            label={t("inventory.list.quantityLabel")}
            value={item.unit ? `${quantity} ${item.unit}` : quantity}
            tone={status === "out" ? "critical" : status === "low" ? "warning" : "neutral"}
          />
          <Metric
            label={t("inventory.detail.minQuantityLabel")}
            value={
              typeof item.min_quantity === "number"
                ? item.unit
                  ? `${formatNumber(item.min_quantity, locale)} ${item.unit}`
                  : formatNumber(item.min_quantity, locale)
                : "—"
            }
            hint={
              typeof item.min_quantity === "number"
                ? undefined
                : t("inventory.detail.noMinimumHint")
            }
          />
          <Metric label={t("inventory.list.categoryLabel")} value={item.category || "—"} />
          <Metric label={t("inventory.list.locationLabel")} value={item.location || "—"} />
        </MetricGrid>
      </div>

      <div className="mt-4 space-y-4">
        <SectionPanel title={t("inventory.detail.detailsTitle")}>
          <MetadataGrid
            items={[
              { label: t("inventory.list.unitPlaceholder"), value: item.unit },
              {
                label: t("inventory.detail.createdAtLabel"),
                value: formatDate(item.created_at, locale),
              },
            ]}
          />
        </SectionPanel>

        {item.notes && (
          <SectionPanel title={t("inventory.list.notesLabel")}>
            <p className="whitespace-pre-wrap text-sm text-secondary">{item.notes}</p>
          </SectionPanel>
        )}

        {/* Fotografie sa ukladali už doteraz, len ich detail nikdy
            nezobrazil — sú v inventory_photos a viditeľné cez RLS. */}
        <SectionPanel title={t("inventory.detail.photosTitle")}>
          {photos.length === 0 ? (
            <EmptyState title={t("inventory.detail.noPhotos")} />
          ) : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {photos.map((photo) => (
                <li key={photo.id}>
                  <a
                    href={photoUrl(photo.file_path)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block overflow-hidden rounded-doc border border-doc-border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={photoUrl(photo.file_path)}
                      alt={t("inventory.photoAlt")}
                      className="aspect-[4/3] w-full object-cover"
                    />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </SectionPanel>
      </div>
    </PageShell>
  );
}
