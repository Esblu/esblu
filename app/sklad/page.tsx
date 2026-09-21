"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import PlanLimitNotice from "@/app/components/PlanLimitNotice";
import { usePlanUsage } from "@/hooks/use-plan-usage";
import {
  isPlanLimitReachedError,
} from "@/lib/plan-limits";
import BackLink from "@/app/components/BackLink";
import { getMyActiveMembership } from "@/lib/company";
import { useCompanyDpaLegalHold } from "@/app/components/CompanyDpaGate";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { inventoryItemDetailHref } from "@/lib/entity-links";
async function compressImage(
  file: File,
  t: (key: string) => string
): Promise<File> {
  const imageUrl = URL.createObjectURL(file);

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();

      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(t("vehicles.errors.photoLoadFailed")));
      img.src = imageUrl;
    });

    const maxDimension = 1600;
    const scale = Math.min(
      1,
      maxDimension / Math.max(image.width, image.height)
    );

    const width = Math.round(image.width * scale);
    const height = Math.round(image.height * scale);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d");

    if (!context) {
      throw new Error(t("vehicles.errors.photoCompressPrepFailed"));
    }

    context.drawImage(image, 0, 0, width, height);

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (result) => {
          if (result) {
            resolve(result);
          } else {
            reject(new Error(t("vehicles.errors.photoCompressFailed")));
          }
        },
        "image/webp",
        0.78
      );
    });

    const baseName = file.name.replace(/\.[^/.]+$/, "");

    return new File([blob], `${baseName}.webp`, {
      type: "image/webp",
      lastModified: Date.now(),
    });
  } finally {
    URL.revokeObjectURL(imageUrl);
  }
}
/** Jedna šablóna stĺpcov pre hlavičku aj riadky registra. */
const INVENTORY_COLUMNS =
  "sm:grid-cols-[minmax(0,2.4fr)_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.1fr)]";

import {
  inventoryCategories,
  matchesInventoryQuery,
  stockStatus,
  type InventoryItemRow,
  type StockStatus,
} from "@/lib/inventory";
import { formatNumber } from "@/lib/i18n/format";
import {
  PageShell,
  PageHeader,
  SectionPanel,
  RegisterToolbar,
  RegisterHeader,
  SearchField,
  FilterChips,
  DataRow,
  EmptyState,
  LoadingRows,
  Notice,
  StatusBadge,
  docButtonPrimary,
  docButtonSecondary,
  docButtonDanger,
  docField,
  docLabel,
} from "@/app/components/ui/Primitives";
import {
  CameraIcon,
  ImageIcon,
  PackageIcon,
  PlusIcon,
} from "@/app/components/icons/AppIcons";

type StockFilter = "all" | StockStatus;

export default function SkladPage() {
  const { t, locale } = useLocale();
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [userId, setUserId] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [items, setItems] = useState<InventoryItemRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [stockFilter, setStockFilter] = useState<StockFilter>("all");
  const [showForm, setShowForm] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const saveInProgressRef = useRef(false);
  const {
    usage: planUsage,
    limit: planLimit,
    isLimited: isPlanLimited,
    loading: planUsageLoading,
    refresh: refreshPlanUsage,
  } = usePlanUsage("inventory_items");
  const { legalHold } = useCompanyDpaLegalHold();
  const isItemCreationUnavailable =
    planUsageLoading || isPlanLimited || legalHold;

  const emptyItem = {
    name: "",
    category: "",
    quantity: "",
    unit: "",
    min_quantity: "",
    location: "",
    notes: "",
  };

  const [item, setItem] = useState(emptyItem);

  useEffect(() => {
    checkUser();
  }, []);
function inventoryPhotoUrl(path: string) {
  const { data } = supabase.storage
    .from("inventory-photos")
    .getPublicUrl(path);

  return data.publicUrl;
}
  async function checkUser() {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session) {
      window.location.href = "/login";
      return;
    }

    setUserId(session.user.id);

    const membership = await getMyActiveMembership();

    if (!membership) {
      setCompanyId("");
      setItems([]);
      return;
    }

    setCompanyId(membership.company_id);
    loadItems(membership.company_id);
  }

  async function loadItems(currentCompanyId: string = companyId) {
    if (!currentCompanyId) return;

    setLoading(true);
    setLoadError("");

    const { data, error } = await supabase
      .from("inventory_items")
      .select("*")
      .eq("company_id", currentCompanyId)
      .order("created_at", { ascending: false });

    if (error) {
      setLoadError(t("inventory.errors.loadFailedPrefix", { message: error.message }));
      setLoading(false);
      return;
    }

    const itemIds = (data || []).map((row) => row.id);

    let photosData: { inventory_item_id: string; file_path: string }[] = [];

    if (itemIds.length > 0) {
      const { data: photos } = await supabase
        .from("inventory_photos")
        .select("inventory_item_id, file_path, created_at")
        .in("inventory_item_id", itemIds)
        .eq("company_id", currentCompanyId)
        .order("created_at", { ascending: false });

      photosData = photos || [];
    }

    const itemsWithPhotos = (data || []).map((row) => {
      const firstPhoto = photosData.find(
        (photo) => photo.inventory_item_id === row.id
      );

      return {
        ...row,
        first_photo_url: firstPhoto ? inventoryPhotoUrl(firstPhoto.file_path) : null,
      };
    });

    setItems(itemsWithPhotos as InventoryItemRow[]);
    setLoading(false);
  }

  function updateItem(key: string, value: string) {
    setItem((prev) => ({ ...prev, [key]: value }));
  }
  async function handlePhotoChange(
  e: React.ChangeEvent<HTMLInputElement>
) {
  const file = e.target.files?.[0];

  if (!file) return;

  try {
    const compressedFile = await compressImage(file, t);

    setPhotoFile(compressedFile);
    setPhotoPreview(URL.createObjectURL(compressedFile));

    console.log("Pôvodná veľkosť:", file.size, "bytes");
    console.log(
      "Komprimovaná veľkosť:",
      compressedFile.size,
      "bytes"
    );
  } catch (error) {
    console.error("Chyba pri kompresii fotografie:", error);
    alert(t("inbox.errors.photoProcessFailed"));
  }
}

  async function saveItem() {
    if (saveInProgressRef.current) return;

    if (!item.name) {
      alert(t("inventory.errors.nameRequired"));
      return;
    }

    if (!userId) {
      alert(t("inbox.errors.notLoggedIn"));
      return;
    }

    if (!editingId && legalHold) {
      alert(t("common.legalHoldMessage"));
      return;
    }

    saveInProgressRef.current = true;
    setIsSaving(true);

    const payload = {
      user_id: userId,
      name: item.name || null,
      category: item.category || null,
      quantity: item.quantity ? Number(item.quantity) : 0,
      unit: item.unit || null,
      min_quantity: item.min_quantity ? Number(item.min_quantity) : null,
      location: item.location || null,
      notes: item.notes || null,
    };

    let createdNewItem = false;

    try {
  let savedItemId = editingId;

  if (editingId) {
    const { error } = await supabase
      .from("inventory_items")
      .update(payload)
      .eq("id", editingId)
      .eq("company_id", companyId);

    if (error) throw error;
  } else {
    const latestUsage = await refreshPlanUsage();

    if (latestUsage?.isLimited) {
      alert(t("common.planLimitMessage"));
      return;
    }

    const { data, error } = await supabase
      .from("inventory_items")
      .insert(payload)
      .select("id")
      .single();

    if (error) throw error;

    savedItemId = data.id;
    createdNewItem = true;
  }

  if (photoFile && savedItemId) {
    const fileExtension =
      photoFile.name.split(".").pop()?.toLowerCase() || "jpg";

    const filePath =
      `${userId}/${savedItemId}/${Date.now()}.${fileExtension}`;

    const { error: uploadError } = await supabase.storage
      .from("inventory-photos")
      .upload(filePath, photoFile, {
        cacheControl: "3600",
        upsert: false,
        contentType: photoFile.type,
      });

    if (uploadError) throw uploadError;

    const { error: photoError } = await supabase
      .from("inventory_photos")
      .insert({
        inventory_item_id: savedItemId,
        user_id: userId,
        file_path: filePath,
      });

    if (photoError) throw photoError;
  }

  setItem(emptyItem);
  setEditingId(null);
  setShowForm(false);
  setPhotoFile(null);

  if (photoPreview) {
    URL.revokeObjectURL(photoPreview);
  }

  setPhotoPreview(null);
  if (createdNewItem) {
    await Promise.all([loadItems(companyId), refreshPlanUsage()]);
  } else {
    await loadItems(companyId);
  }
} catch (saveError: unknown) {
  if (isPlanLimitReachedError(saveError, "inventory_items")) {
    alert(t("common.planLimitMessage"));
    await refreshPlanUsage();
  } else {
    const message =
      saveError instanceof Error
        ? saveError.message
        : t("vehicles.errors.unknownError");
    alert(t("inventory.errors.saveFailedPrefix", { message }));

    if (createdNewItem) {
      await Promise.all([loadItems(), refreshPlanUsage()]);
    }
  }
} finally {
  saveInProgressRef.current = false;
  setIsSaving(false);
}
  }

  function editItem(row: InventoryItemRow) {
    setEditingId(row.id);
    setShowForm(true);

    setItem({
      name: row.name || "",
      category: row.category || "",
      quantity: row.quantity === null || row.quantity === undefined ? "" : String(row.quantity),
      unit: row.unit || "",
      min_quantity:
        row.min_quantity === null || row.min_quantity === undefined
          ? ""
          : String(row.min_quantity),
      location: row.location || "",
      notes: row.notes || "",
    });

    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function deleteItem(id: string) {
  const confirmed = confirm(
    t("inventory.errors.deleteConfirm")
  );

  if (!confirmed) return;

  const { data: itemPhotos, error: photosError } = await supabase
    .from("inventory_photos")
    .select("file_path")
    .eq("inventory_item_id", id)
    .eq("company_id", companyId);

  if (photosError) {
    console.error(
      "Chyba pri načítaní fotografií skladovej položky:",
      photosError
    );
    alert(t("inventory.errors.photosLoadFailed"));
    return;
  }

  const photoPaths = (itemPhotos || [])
    .map((photo: { file_path: string }) => photo.file_path)
    .filter(Boolean);

  if (photoPaths.length > 0) {
  
    const { error: storageError } = await supabase.storage
  .from("inventory-photos")
  .remove(photoPaths);


    if (storageError) {
      console.error(
        "Chyba pri mazaní fotografií zo Storage:",
        storageError
      );
      alert(t("inventory.errors.photosStorageDeleteFailed"));
      return;
    }
  }

  const { error: deleteError } = await supabase
    .from("inventory_items")
    .delete()
    .eq("id", id)
    .eq("company_id", companyId);

  if (deleteError) {
    alert(t("inventory.errors.deleteFailedPrefix", { message: deleteError.message }));
    return;
  }

  await Promise.all([loadItems(companyId), refreshPlanUsage()]);
}

  // ---------------------------------------------------------------------------
  // Odvodené zobrazenie registra
  // ---------------------------------------------------------------------------
  const categories = inventoryCategories(items);

  const visibleItems = items.filter((row) => {
    if (!matchesInventoryQuery(row, search)) return false;
    if (categoryFilter !== "all" && (row.category ?? "") !== categoryFilter) return false;
    if (stockFilter !== "all" && stockStatus(row) !== stockFilter) return false;
    return true;
  });

  const statusCounts = items.reduce<Record<StockStatus, number>>(
    (acc, row) => {
      acc[stockStatus(row)] += 1;
      return acc;
    },
    { out: 0, low: 0, ok: 0, untracked: 0 }
  );

  const activeFilterCount =
    (categoryFilter !== "all" ? 1 : 0) + (stockFilter !== "all" ? 1 : 0);

  /**
   * Množstvo je hlavná informácia skladu, takže sa píše ako jedno číslo
   * s jednotkou ("24 ks"), nie ako dva štítkované riadky.
   */
  function quantityLabel(row: InventoryItemRow): string {
    const amount =
      typeof row.quantity === "number" ? formatNumber(row.quantity, locale) : "—";
    return row.unit ? `${amount} ${row.unit}` : amount;
  }

  function stockBadge(row: InventoryItemRow) {
    const status = stockStatus(row);
    if (status === "out")
      return <StatusBadge kind="error" label={t("inventory.stock.out")} />;
    if (status === "low")
      return <StatusBadge kind="needs_review" label={t("inventory.stock.low")} />;
    if (status === "ok")
      return <StatusBadge kind="paid" label={t("inventory.stock.ok")} />;
    // Bez nastaveného minima appka nevie povedať, či je zásoba dostatočná —
    // tvrdiť "Dostupné" by bola domnienka.
    return <StatusBadge kind="draft" label={t("inventory.stock.untracked")} />;
  }

  return (
    <PageShell wide>
      <BackLink href="/" label={t("inbox.backToMenu")} className="mb-6" />

      <PageHeader
        eyebrow={
          <span className="inline-flex items-center gap-2">
            <PackageIcon size={18} />
            {t("nav.inventory")}
          </span>
        }
        title={t("inventory.register.title")}
        meta={t("inventory.list.subtitle")}
        aside={
          <button
            type="button"
            onClick={() => {
              setShowForm(!showForm);
              setEditingId(null);
              setItem(emptyItem);
            }}
            disabled={isItemCreationUnavailable && !showForm}
            className={`${docButtonPrimary} gap-2`}
          >
            <PlusIcon size={16} />
            {t("inventory.list.addItem")}
          </button>
        }
      />

      {!planUsageLoading && isPlanLimited && (
        <PlanLimitNotice
          resource="inventory_items"
          usage={planUsage}
          limit={planLimit}
          className="mt-4"
        />
      )}

      {legalHold && (
        <div className="mt-4">
          <Notice tone="warning">{t("common.legalHoldMessage")}</Notice>
        </div>
      )}

      {showForm && (
        <div className="mt-6">
          <SectionPanel
            title={
              editingId ? t("inventory.list.editItemTitle") : t("inventory.list.addItemTitle")
            }
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className={docLabel} htmlFor="item-name">
                  {t("inventory.list.namePlaceholder")}
                </label>
                <input
                  id="item-name"
                  className={docField}
                  value={item.name}
                  onChange={(event) => updateItem("name", event.target.value)}
                />
              </div>

              <div>
                <label className={docLabel} htmlFor="item-category">
                  {t("inventory.list.categoryLabel")}
                </label>
                <input
                  id="item-category"
                  className={docField}
                  value={item.category}
                  onChange={(event) => updateItem("category", event.target.value)}
                />
              </div>

              <div>
                <label className={docLabel} htmlFor="item-location">
                  {t("inventory.list.locationLabel")}
                </label>
                <input
                  id="item-location"
                  className={docField}
                  value={item.location}
                  onChange={(event) => updateItem("location", event.target.value)}
                />
              </div>

              <div>
                <label className={docLabel} htmlFor="item-quantity">
                  {t("inventory.list.quantityLabel")}
                </label>
                <input
                  id="item-quantity"
                  type="number"
                  inputMode="decimal"
                  className={docField}
                  value={item.quantity}
                  onChange={(event) => updateItem("quantity", event.target.value)}
                />
              </div>

              <div>
                <label className={docLabel} htmlFor="item-unit">
                  {t("inventory.list.unitPlaceholder")}
                </label>
                <input
                  id="item-unit"
                  className={docField}
                  value={item.unit}
                  onChange={(event) => updateItem("unit", event.target.value)}
                />
              </div>

              <div className="sm:col-span-2">
                <label className={docLabel} htmlFor="item-min">
                  {t("inventory.list.minimumLabel")}
                </label>
                <input
                  id="item-min"
                  type="number"
                  inputMode="decimal"
                  className={docField}
                  value={item.min_quantity}
                  onChange={(event) => updateItem("min_quantity", event.target.value)}
                />
                <p className="mt-1 text-xs text-muted-esblu">
                  {t("inventory.list.minimumHint")}
                </p>
              </div>

              <div className="sm:col-span-2">
                <label className={docLabel} htmlFor="item-notes">
                  {t("inventory.list.notesLabel")}
                </label>
                <textarea
                  id="item-notes"
                  rows={3}
                  className={docField}
                  value={item.notes}
                  onChange={(event) => updateItem("notes", event.target.value)}
                />
              </div>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <label
                className={`${docButtonSecondary} cursor-pointer gap-2 ${
                  isSaving ? "pointer-events-none opacity-40" : ""
                }`}
              >
                <CameraIcon size={16} />
                {t("inbox.registration.takePhoto")}
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="sr-only"
                  onChange={handlePhotoChange}
                />
              </label>
              <label
                className={`${docButtonSecondary} cursor-pointer gap-2 ${
                  isSaving ? "pointer-events-none opacity-40" : ""
                }`}
              >
                <ImageIcon size={16} />
                {t("machines.detail.galleryButton")}
                <input
                  type="file"
                  accept="image/*"
                  className="sr-only"
                  onChange={handlePhotoChange}
                />
              </label>
            </div>

            {photoPreview && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={photoPreview}
                alt={t("inventory.list.photoPreviewAlt")}
                className="mt-3 h-40 w-full rounded-doc border border-doc-border object-cover"
              />
            )}

            <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => {
                  setShowForm(false);
                  setEditingId(null);
                  setItem(emptyItem);
                }}
                className={docButtonSecondary}
              >
                {t("vehicles.forms.cancelEdit")}
              </button>
              <button
                type="button"
                onClick={saveItem}
                disabled={isSaving}
                className={docButtonPrimary}
              >
                {isSaving ? t("common.buttons.saving") : t("inventory.list.saveItem")}
              </button>
            </div>
          </SectionPanel>
        </div>
      )}

      <div className="mt-6">
        <RegisterToolbar
          filtersLabel={t("common.register.filters")}
          filtersCloseLabel={t("common.register.filtersClose")}
          activeFilterCount={activeFilterCount}
          search={
            <SearchField
              label={t("inventory.register.searchLabel")}
              placeholder={t("inventory.register.searchPlaceholder")}
              value={search}
              onChange={setSearch}
            />
          }
          filters={
            <div className="space-y-2">
              <FilterChips
                label={t("inventory.register.stockFilterLabel")}
                active={stockFilter}
                onSelect={(key) => setStockFilter(key as StockFilter)}
                options={[
                  { key: "all", label: t("common.register.all"), count: items.length },
                  { key: "low", label: t("inventory.stock.low"), count: statusCounts.low },
                  { key: "out", label: t("inventory.stock.out"), count: statusCounts.out },
                  { key: "ok", label: t("inventory.stock.ok"), count: statusCounts.ok },
                  {
                    key: "untracked",
                    label: t("inventory.stock.untracked"),
                    count: statusCounts.untracked,
                  },
                ]}
              />
              {categories.length > 0 && (
                <FilterChips
                  label={t("inventory.list.categoryLabel")}
                  active={categoryFilter}
                  onSelect={setCategoryFilter}
                  options={[
                    { key: "all", label: t("common.register.allCategories") },
                    ...categories.map((category) => ({ key: category, label: category })),
                  ]}
                />
              )}
            </div>
          }
        />
      </div>

      <div className="mt-4">
        {loading ? (
          <LoadingRows label={t("common.buttons.loading")} />
        ) : loadError ? (
          <Notice tone="critical">{loadError}</Notice>
        ) : items.length === 0 ? (
          <EmptyState
            title={t("inventory.list.noneYet")}
            action={
              <button
                type="button"
                onClick={() => setShowForm(true)}
                disabled={isItemCreationUnavailable}
                className={`${docButtonPrimary} gap-2`}
              >
                <PlusIcon size={16} />
                {t("inventory.list.addItem")}
              </button>
            }
          />
        ) : visibleItems.length === 0 ? (
          <EmptyState title={t("common.register.noMatches")} />
        ) : (
          <>
            <RegisterHeader columns={INVENTORY_COLUMNS}>
              <span>{t("inventory.register.colItem")}</span>
              <span>{t("inventory.list.locationLabel")}</span>
              <span className="text-right">{t("inventory.list.quantityLabel")}</span>
              <span>{t("inventory.register.colStock")}</span>
            </RegisterHeader>

            <ul className="mt-2 space-y-1.5">
              {visibleItems.map((row) => (
                <DataRow
                  key={row.id}
                  href={inventoryItemDetailHref(row.id)}
                  columns={INVENTORY_COLUMNS}
                  ariaLabel={row.name ?? t("dashboard.noName")}
                  trailing={
                    <>
                      <button
                        type="button"
                        onClick={() => editItem(row)}
                        aria-label={`${t("common.buttons.edit")}: ${row.name ?? ""}`}
                        className={`${docButtonSecondary} px-2.5 text-xs`}
                      >
                        {t("common.buttons.edit")}
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteItem(row.id)}
                        aria-label={`${t("common.buttons.delete")}: ${row.name ?? ""}`}
                        className={`${docButtonDanger} px-2.5 text-xs`}
                      >
                        {t("common.buttons.delete")}
                      </button>
                    </>
                  }
                >
                  <div className="flex min-w-0 items-center gap-3">
                    {row.first_photo_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={row.first_photo_url}
                        alt=""
                        className="h-10 w-10 shrink-0 rounded-doc-sm border border-doc-border object-cover"
                      />
                    ) : (
                      <span
                        aria-hidden="true"
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-doc-sm border border-doc-border bg-surface-2 text-muted-esblu"
                      >
                        <PackageIcon size={18} />
                      </span>
                    )}
                    <div className="min-w-0">
                      <span className="block truncate font-medium text-primary">
                        {row.name || t("dashboard.noName")}
                      </span>
                      <span className="mt-0.5 block truncate text-sm text-muted-esblu">
                        {row.category || "—"}
                      </span>
                    </div>
                  </div>

                  <p className="mt-1.5 truncate text-sm text-secondary sm:mt-0">
                    {row.location || "—"}
                  </p>

                  {/* Množstvo a stav idú na mobile do jedného riadku, aby
                      položka zabrala tri riadky namiesto šiestich. */}
                  <div className="mt-2 flex items-center justify-between gap-3 sm:contents">
                    <p className="text-base font-semibold tabular-nums text-primary sm:text-sm sm:text-right">
                      {quantityLabel(row)}
                    </p>
                    <div className="flex sm:justify-start">{stockBadge(row)}</div>
                  </div>
                </DataRow>
              ))}
            </ul>
          </>
        )}
      </div>
    </PageShell>
  );
}
