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
import { machineDetailHref } from "@/lib/entity-links";
import {
  machineCategories,
  machineServiceAttention,
  matchesMachineQuery,
  summarizeMachineServices,
  type MachineRow,
  type MachineServiceRow,
  type MachineServiceSummary,
} from "@/lib/machines";
import { formatDate, formatNumber } from "@/lib/i18n/format";
import {
  PageShell,
  PageHeader,
  RegisterToolbar,
  RegisterHeader,
  SearchField,
  FilterChips,
  DataRow,
  EmptyState,
  LoadingRows,
  SectionPanel,
  Notice,
  StatusBadge,
  docButtonPrimary,
  docButtonSecondary,
  docButtonDanger,
  docField,
  docLabel,
} from "@/app/components/ui/Primitives";
import { MachineIcon, PlusIcon } from "@/app/components/icons/AppIcons";

/** Jedna šablóna stĺpcov pre hlavičku aj riadky registra. */
const MACHINE_COLUMNS =
  "sm:grid-cols-[minmax(0,2.4fr)_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.2fr)]";

type ServiceFilter = "all" | "attention" | "scheduled" | "none";

export default function StrojePage() {
  const { t, locale } = useLocale();
  const [userId, setUserId] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [machines, setMachines] = useState<MachineRow[]>([]);
  const [serviceSummaries, setServiceSummaries] = useState<
    Record<string, MachineServiceSummary>
  >({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [serviceFilter, setServiceFilter] = useState<ServiceFilter>("all");
  const [showForm, setShowForm] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [deletingMachineId, setDeletingMachineId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const saveInProgressRef = useRef(false);
  const {
    usage: planUsage,
    limit: planLimit,
    isLimited: isPlanLimited,
    loading: planUsageLoading,
    refresh: refreshPlanUsage,
  } = usePlanUsage("machines");
  const { legalHold } = useCompanyDpaLegalHold();
  const isMachineCreationUnavailable =
    planUsageLoading || isPlanLimited || legalHold;

  const emptyMachine = {
    name: "",
    category: "",
    manufacturer: "",
    model: "",
    serial_number: "",
    year: "",
    purchase_date: "",
    status: "",
    notes: "",
  };

  const [machine, setMachine] = useState(emptyMachine);

  useEffect(() => {
    checkUser();
  }, []);

  function photoUrl(path: string) {
    const { data } = supabase.storage
      .from("machine-photos")
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
      setMachines([]);
      return;
    }

    setCompanyId(membership.company_id);
    loadMachines(membership.company_id);
  }

  async function loadMachines(currentCompanyId: string = companyId) {
    if (!currentCompanyId) return;

    setLoading(true);
    setLoadError("");

    const { data: machinesData, error } = await supabase
      .from("machines")
      .select("*")
      .eq("company_id", currentCompanyId)
      .order("created_at", { ascending: false });

    if (error) {
      setLoadError(t("machines.errors.loadFailedPrefix", { message: error.message }));
      setLoading(false);
      return;
    }

    const machineIds = (machinesData || []).map((m) => m.id);

    let photosData: { machine_id: string; file_path: string }[] = [];
    let servicesData: MachineServiceRow[] = [];

    if (machineIds.length > 0) {
      // Dva dotazy naraz. Servisy potrebuje register kvôli motohodinám a
      // termínom — tabuľka machines tieto údaje nemá (pozri lib/machines.ts).
      const [photos, services] = await Promise.all([
        supabase
          .from("machine_photos")
          .select("*")
          .in("machine_id", machineIds)
          .eq("company_id", currentCompanyId)
          .order("created_at", { ascending: false }),
        supabase
          .from("machine_services")
          .select("id, machine_id, service_date, mileage, title, cost, next_service_date")
          .in("machine_id", machineIds)
          .eq("company_id", currentCompanyId)
          .order("service_date", { ascending: false }),
      ]);

      photosData = photos.data || [];
      servicesData = (services.data as MachineServiceRow[]) || [];
    }

    const byMachine = new Map<string, MachineServiceRow[]>();
    for (const service of servicesData) {
      if (!service.machine_id) continue;
      const list = byMachine.get(service.machine_id);
      if (list) list.push(service);
      else byMachine.set(service.machine_id, [service]);
    }

    const summaries: Record<string, MachineServiceSummary> = {};
    for (const id of machineIds) {
      summaries[id] = summarizeMachineServices(byMachine.get(id) ?? []);
    }

    const machinesWithPhotos = (machinesData || []).map((item) => {
      const firstPhoto = photosData.find((photo) => photo.machine_id === item.id);

      return {
        ...item,
        first_photo_url: firstPhoto ? photoUrl(firstPhoto.file_path) : null,
      };
    });

    setMachines(machinesWithPhotos as MachineRow[]);
    setServiceSummaries(summaries);
    setLoading(false);
  }

  function updateMachine(key: string, value: string) {
    setMachine((prev) => ({
      ...prev,
      [key]: value,
    }));
  }

  async function saveMachine() {
    if (saveInProgressRef.current) return;

    if (!machine.name) {
      alert(t("machines.errors.nameRequired"));
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
      name: machine.name || null,
      category: machine.category || null,
      manufacturer: machine.manufacturer || null,
      model: machine.model || null,
      serial_number: machine.serial_number || null,
      year: machine.year ? Number(machine.year) : null,
      purchase_date: machine.purchase_date || null,
      status: machine.status || null,
      notes: machine.notes || null,
    };

    try {
      if (editingId) {
        const { error } = await supabase
          .from("machines")
          .update(payload)
          .eq("id", editingId)
          .eq("company_id", companyId);

        if (error) throw error;

        setMachine(emptyMachine);
        setEditingId(null);
        setShowForm(false);
        await loadMachines();
        return;
      }

      const latestUsage = await refreshPlanUsage();

      if (latestUsage?.isLimited) {
        alert(t("common.planLimitMessage"));
        return;
      }

      const { error } = await supabase.from("machines").insert(payload);
      if (error) throw error;

      setMachine(emptyMachine);
      setEditingId(null);
      setShowForm(false);
      await Promise.all([loadMachines(), refreshPlanUsage()]);
    } catch (saveError: unknown) {
      if (isPlanLimitReachedError(saveError, "machines")) {
        alert(t("common.planLimitMessage"));
        await refreshPlanUsage();
      } else {
        const message =
          saveError instanceof Error
            ? saveError.message
            : t("vehicles.errors.unknownError");
        alert(t("machines.errors.saveFailedPrefix", { message }));
      }
    } finally {
      saveInProgressRef.current = false;
      setIsSaving(false);
    }
  }

  function editMachine(item: MachineRow) {
    setEditingId(item.id);
    setShowForm(true);

    setMachine({
      name: item.name || "",
      category: item.category || "",
      manufacturer: item.manufacturer || "",
      model: item.model || "",
      serial_number: item.serial_number || "",
      year: item.year ? String(item.year) : "",
      purchase_date: item.purchase_date || "",
      status: item.status || "",
      notes: item.notes || "",
    });

    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function deleteMachine(machineId: string) {
    if (deletingMachineId) return;

    const confirmed = confirm(t("machines.errors.deleteConfirm"));
    if (!confirmed) return;

    setDeletingMachineId(machineId);

    try {
      const membership = await getMyActiveMembership();

      if (!membership) {
        throw new Error(t("vehicles.errors.notLoggedInFormal"));
      }

      const activeCompanyId = membership.company_id;

      const { data: machinePhotos, error: photosError } = await supabase
        .from("machine_photos")
        .select("id, file_path")
        .eq("machine_id", machineId)
        .eq("company_id", activeCompanyId);

      if (photosError) throw photosError;

      const photoPaths = Array.from(
        new Set(
          (machinePhotos || [])
            .map((photo) => photo.file_path)
            .filter((path): path is string => Boolean(path))
        )
      );

      let { data: deletedMachines, error: deleteMachineError } = await supabase
          .from("machines")
          .delete()
          .eq("id", machineId)
          .eq("company_id", activeCompanyId)
          .select("id");

      // Pri RESTRICT foreign key najprv bezpečne odstránime DB riadky fotiek
      // a rovnaký presný delete stroja zopakujeme. Bez tejto vetvy by stroj
      // zostal v databáze po už odstránených súboroch zo Storage.
      if (deleteMachineError?.code === "23503") {
        const { error: restrictedPhotosError } = await supabase
          .from("machine_photos")
          .delete()
          .eq("machine_id", machineId)
          .eq("company_id", activeCompanyId)
          .select("id");

        if (restrictedPhotosError) throw restrictedPhotosError;

        const retryResult = await supabase
          .from("machines")
          .delete()
          .eq("id", machineId)
          .eq("company_id", activeCompanyId)
          .select("id");

        deletedMachines = retryResult.data;
        deleteMachineError = retryResult.error;
      }

      if (deleteMachineError) throw deleteMachineError;

      if (deletedMachines?.length !== 1) {
        throw new Error(t("machines.errors.deleteDbMismatch"));
      }

      // Ak databáza nemá ON DELETE CASCADE, odstránime riadky fotografií
      // explicitne. Pri existujúcom cascade bude tento delete bezpečne prázdny.
      const { error: deletePhotosError } = await supabase
        .from("machine_photos")
        .delete()
        .eq("machine_id", machineId)
        .eq("company_id", activeCompanyId)
        .select("id");

      if (deletePhotosError) throw deletePhotosError;

      const { data: remainingPhotos, error: verifyPhotosError } = await supabase
        .from("machine_photos")
        .select("id")
        .eq("machine_id", machineId)
        .eq("company_id", activeCompanyId);

      if (verifyPhotosError) throw verifyPhotosError;

      if ((remainingPhotos || []).length > 0) {
        throw new Error(t("machines.errors.photosCleanupFailed"));
      }

      // UI obnovíme až po potvrdenom vymazaní databázových záznamov.
      await Promise.all([
        loadMachines(activeCompanyId),
        refreshPlanUsage(),
      ]);

      // Storage čistíme až nakoniec. Jeho chyba nesmie zakryť úspešný DB delete.
      if (photoPaths.length > 0) {
        const { error: storageError } = await supabase.storage
          .from("machine-photos")
          .remove(photoPaths);

        if (storageError) {
          console.error(
            "Stroj bol vymazaný, ale fotografie sa nepodarilo odstrániť zo Storage:",
            storageError
          );
          alert(t("machines.errors.photosStorageDeleteFailed"));
        }
      }
    } catch (deleteError: unknown) {
      console.error("Chyba pri mazaní stroja:", deleteError);
      const message =
        deleteError instanceof Error
          ? deleteError.message
          : typeof deleteError === "object" &&
              deleteError !== null &&
              "message" in deleteError
            ? String(deleteError.message)
            : t("vehicles.errors.unknownError");
      alert(t("machines.errors.deleteFailedPrefix", { message }));
    } finally {
      setDeletingMachineId(null);
    }
  }

  function cancelEdit() {
    setEditingId(null);
    setMachine(emptyMachine);
    setShowForm(false);
  }

  // ---------------------------------------------------------------------------
  // Odvodené zobrazenie registra
  // ---------------------------------------------------------------------------
  const categories = machineCategories(machines);

  const visibleMachines = machines.filter((item) => {
    if (!matchesMachineQuery(item, search)) return false;
    if (categoryFilter !== "all" && (item.category ?? "") !== categoryFilter) return false;

    if (serviceFilter !== "all") {
      const attention = machineServiceAttention(serviceSummaries[item.id]?.nextServiceDate);
      if (serviceFilter === "attention" && attention !== "overdue" && attention !== "due_soon")
        return false;
      if (serviceFilter === "scheduled" && attention !== "ok" && attention !== "due_soon")
        return false;
      if (serviceFilter === "none" && attention !== "unknown") return false;
    }

    return true;
  });

  const attentionCount = machines.filter((item) => {
    const attention = machineServiceAttention(serviceSummaries[item.id]?.nextServiceDate);
    return attention === "overdue" || attention === "due_soon";
  }).length;

  const activeFilterCount =
    (categoryFilter !== "all" ? 1 : 0) + (serviceFilter !== "all" ? 1 : 0);

  function serviceCell(machineId: string) {
    const summary = serviceSummaries[machineId];
    const next = summary?.nextServiceDate ?? null;
    const attention = machineServiceAttention(next);

    if (!next) {
      return <span className="text-sm text-muted-esblu">{t("machines.register.noService")}</span>;
    }

    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <span
          className={`text-sm tabular-nums ${
            attention === "overdue"
              ? "text-danger"
              : attention === "due_soon"
                ? "text-warning"
                : "text-secondary"
          }`}
        >
          {formatDate(next, locale)}
        </span>
        {attention === "overdue" && (
          <StatusBadge kind="overdue" label={t("machines.service.overdue")} />
        )}
        {attention === "due_soon" && (
          <StatusBadge kind="needs_review" label={t("machines.service.dueSoon")} />
        )}
      </span>
    );
  }

  return (
    <PageShell wide>
      <BackLink href="/" label={t("inbox.backToMenu")} className="mb-6" />

      <PageHeader
        eyebrow={
          <span className="inline-flex items-center gap-2">
            <MachineIcon size={18} />
            {t("nav.machines")}
          </span>
        }
        title={t("machines.register.title")}
        meta={t("machines.list.subtitle")}
        aside={
          <button
            type="button"
            onClick={() => {
              setShowForm((value) => !value);
              if (showForm) cancelEdit();
            }}
            disabled={isMachineCreationUnavailable && !showForm}
            className={`${docButtonPrimary} gap-2`}
          >
            <PlusIcon size={16} />
            {t("machines.list.addMachine")}
          </button>
        }
      />

      {isPlanLimited && (
        <div className="mt-4">
          <PlanLimitNotice
            resource="machines"
            usage={planUsage}
            limit={planLimit}
            className="mt-0"
          />
        </div>
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
              editingId ? t("machines.list.editMachineTitle") : t("machines.list.addMachineTitle")
            }
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className={docLabel} htmlFor="machine-name">
                  {t("machines.list.namePlaceholder")}
                </label>
                <input
                  id="machine-name"
                  className={docField}
                  value={machine.name}
                  onChange={(event) => updateMachine("name", event.target.value)}
                />
              </div>

              <div>
                <label className={docLabel} htmlFor="machine-category">
                  {t("machines.list.categoryLabel")}
                </label>
                <input
                  id="machine-category"
                  className={docField}
                  value={machine.category}
                  onChange={(event) => updateMachine("category", event.target.value)}
                />
              </div>

              <div>
                <label className={docLabel} htmlFor="machine-status">
                  {t("machines.list.statusLabel")}
                </label>
                <input
                  id="machine-status"
                  className={docField}
                  value={machine.status}
                  onChange={(event) => updateMachine("status", event.target.value)}
                />
                {/* machines.status je v databáze voľný text bez číselníka —
                    UI preto neponúka výber, iba pole. Pozri lib/machines.ts. */}
                <p className="mt-1 text-xs text-muted-esblu">
                  {t("machines.list.statusHint")}
                </p>
              </div>

              <div>
                <label className={docLabel} htmlFor="machine-manufacturer">
                  {t("machines.list.manufacturerLabel")}
                </label>
                <input
                  id="machine-manufacturer"
                  className={docField}
                  value={machine.manufacturer}
                  onChange={(event) => updateMachine("manufacturer", event.target.value)}
                />
              </div>

              <div>
                <label className={docLabel} htmlFor="machine-model">
                  {t("machines.list.modelLabel")}
                </label>
                <input
                  id="machine-model"
                  className={docField}
                  value={machine.model}
                  onChange={(event) => updateMachine("model", event.target.value)}
                />
              </div>

              <div>
                <label className={docLabel} htmlFor="machine-serial">
                  {t("machines.list.serialNumberLabel")}
                </label>
                <input
                  id="machine-serial"
                  className={docField}
                  value={machine.serial_number}
                  onChange={(event) => updateMachine("serial_number", event.target.value)}
                />
              </div>

              <div>
                <label className={docLabel} htmlFor="machine-year">
                  {t("inbox.fields.rokVyroby")}
                </label>
                <input
                  id="machine-year"
                  inputMode="numeric"
                  className={docField}
                  value={machine.year}
                  onChange={(event) => updateMachine("year", event.target.value)}
                />
              </div>

              <div>
                <label className={docLabel} htmlFor="machine-purchase">
                  {t("machines.detail.purchaseDateLabel")}
                </label>
                <input
                  id="machine-purchase"
                  type="date"
                  className={docField}
                  value={machine.purchase_date}
                  onChange={(event) => updateMachine("purchase_date", event.target.value)}
                />
              </div>

              <div className="sm:col-span-2">
                <label className={docLabel} htmlFor="machine-notes">
                  {t("machines.detail.notesLabel")}
                </label>
                <textarea
                  id="machine-notes"
                  rows={3}
                  className={docField}
                  value={machine.notes}
                  onChange={(event) => updateMachine("notes", event.target.value)}
                />
              </div>
            </div>

            <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
              <button type="button" onClick={cancelEdit} className={docButtonSecondary}>
                {t("vehicles.forms.cancelEdit")}
              </button>
              <button
                type="button"
                onClick={saveMachine}
                disabled={isSaving}
                className={docButtonPrimary}
              >
                {isSaving ? t("common.buttons.saving") : t("machines.list.saveMachine")}
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
              label={t("machines.register.searchLabel")}
              placeholder={t("machines.register.searchPlaceholder")}
              value={search}
              onChange={setSearch}
            />
          }
          filters={
            <div className="space-y-2">
              <FilterChips
                label={t("machines.register.serviceFilterLabel")}
                active={serviceFilter}
                onSelect={(key) => setServiceFilter(key as ServiceFilter)}
                options={[
                  { key: "all", label: t("common.register.all"), count: machines.length },
                  {
                    key: "attention",
                    label: t("machines.register.needsAttention"),
                    count: attentionCount,
                  },
                  { key: "scheduled", label: t("machines.register.scheduled") },
                  { key: "none", label: t("machines.register.noServicePlan") },
                ]}
              />
              {categories.length > 0 && (
                <FilterChips
                  label={t("machines.list.categoryLabel")}
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
        ) : machines.length === 0 ? (
          <EmptyState
            title={t("machines.list.noneYet")}
            action={
              <button
                type="button"
                onClick={() => setShowForm(true)}
                disabled={isMachineCreationUnavailable}
                className={`${docButtonPrimary} gap-2`}
              >
                <PlusIcon size={16} />
                {t("machines.list.addMachine")}
              </button>
            }
          />
        ) : visibleMachines.length === 0 ? (
          <EmptyState title={t("common.register.noMatches")} />
        ) : (
          <>
            <RegisterHeader columns={MACHINE_COLUMNS}>
              <span>{t("machines.register.colMachine")}</span>
              <span>{t("machines.register.colIdentification")}</span>
              <span className="text-right">{t("machines.register.colHours")}</span>
              <span>{t("machines.register.colNextService")}</span>
            </RegisterHeader>

            <ul className="mt-2 space-y-1.5">
              {visibleMachines.map((item) => {
                const summary = serviceSummaries[item.id];
                return (
                  <DataRow
                    key={item.id}
                    href={machineDetailHref(item.id)}
                    columns={MACHINE_COLUMNS}
                    ariaLabel={item.name ?? t("dashboard.noName")}
                    trailing={
                      <>
                        <button
                          type="button"
                          onClick={() => editMachine(item)}
                          aria-label={`${t("common.buttons.edit")}: ${item.name ?? ""}`}
                          className={`${docButtonSecondary} px-2.5 text-xs`}
                        >
                          {t("common.buttons.edit")}
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteMachine(item.id)}
                          disabled={deletingMachineId === item.id}
                          aria-label={`${t("common.buttons.delete")}: ${item.name ?? ""}`}
                          className={`${docButtonDanger} px-2.5 text-xs`}
                        >
                          {deletingMachineId === item.id
                            ? t("inbox.deleting")
                            : t("common.buttons.delete")}
                        </button>
                      </>
                    }
                  >
                    {/* 1 stroj — miniatúra, názov, stav */}
                    <div className="flex min-w-0 items-center gap-3">
                      {item.first_photo_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={item.first_photo_url}
                          alt=""
                          className="h-10 w-10 shrink-0 rounded-doc-sm border border-doc-border object-cover"
                        />
                      ) : (
                        <span
                          aria-hidden="true"
                          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-doc-sm border border-doc-border bg-surface-2 text-muted-esblu"
                        >
                          <MachineIcon size={18} />
                        </span>
                      )}
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate font-medium text-primary">
                            {item.name || t("dashboard.noName")}
                          </span>
                          {item.status && (
                            <span className="shrink-0 rounded-doc-sm border border-doc-border px-2 py-0.5 text-[11px] font-medium text-muted-esblu">
                              {item.status}
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 truncate text-sm text-muted-esblu">
                          {[item.category, item.manufacturer, item.model]
                            .filter(Boolean)
                            .join(" · ") || "—"}
                        </p>
                      </div>
                    </div>

                    {/* 2 identifikácia */}
                    <div className="mt-1.5 min-w-0 sm:mt-0">
                      <p className="truncate text-sm text-secondary">
                        {item.serial_number || "—"}
                      </p>
                      {item.year && (
                        <p className="mt-0.5 text-sm text-muted-esblu tabular-nums">{item.year}</p>
                      )}
                    </div>

                    {/* 3 motohodiny — posledný ZNÁMY stav, nie aktuálny */}
                    <div className="mt-1.5 sm:mt-0 sm:text-right">
                      {summary?.lastKnownMileage !== null &&
                      summary?.lastKnownMileage !== undefined ? (
                        <>
                          <p className="text-sm font-semibold tabular-nums text-primary">
                            {formatNumber(summary.lastKnownMileage, locale)}
                          </p>
                          <p className="text-xs text-muted-esblu">
                            {t("machines.register.atLastService")}
                          </p>
                        </>
                      ) : (
                        <p className="text-sm text-muted-esblu">—</p>
                      )}
                    </div>

                    {/* 4 ďalší servis */}
                    <div className="mt-1.5 sm:mt-0">{serviceCell(item.id)}</div>
                  </DataRow>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </PageShell>
  );
}
