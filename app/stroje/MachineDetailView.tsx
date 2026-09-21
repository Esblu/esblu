"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import BackLink from "@/app/components/BackLink";
import { getMyActiveMembership } from "@/lib/company";
import { useCompanyDpaLegalHold } from "@/app/components/CompanyDpaGate";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { computeDeadlineStatus } from "@/lib/deadlines";
import { formatDate, formatNumber } from "@/lib/i18n/format";
import {
  machineServiceAttention,
  summarizeMachineServices,
  type MachineRow,
  type MachineServiceRow,
} from "@/lib/machines";

type MachinePhoto = {
  id: string;
  machine_id: string | null;
  file_path: string;
  created_at: string;
};
import {
  fetchMachineDocuments,
  type MachineDocumentEntry,
} from "@/lib/machine-documents";
import {
  PageShell,
  PageHeader,
  SectionPanel,
  MetricGrid,
  Metric,
  MetadataGrid,
  Notice,
  EmptyState,
  TimelineItem,
  StatusBadge,
  docButtonPrimary,
  docButtonSecondary,
  docButtonDanger,
  docField,
  docLabel,
} from "@/app/components/ui/Primitives";
import {
  CameraIcon,
  FileIcon,
  ImageIcon,
  MachineIcon,
  PlusIcon,
  TrashIcon,
  WrenchIcon,
} from "@/app/components/icons/AppIcons";

type DetailTab = "overview" | "service" | "documents" | "photos";

type MachineService = {
  id: string;
  machine_id: string;
  user_id: string;
  service_date: string;
  mileage: number | string | null;
  title: string;
  description: string | null;
  cost: number | string | null;
  technician: string | null;
  next_service_date: string | null;
  created_at: string;
};

const emptyService = {
  service_date: "",
  mileage: "",
  title: "",
  description: "",
  cost: "",
  technician: "",
  next_service_date: "",
};

function parseOptionalNonNegativeNumber(
  value: string,
  fieldName: string,
  t: (key: string, vars?: Record<string, string | number>) => string,
  requireSafeInteger = false
): number | null {
  const trimmedValue = value.trim();

  if (!trimmedValue) return null;

  const parsedValue = Number(trimmedValue);
  const isValidInteger =
    !requireSafeInteger || Number.isSafeInteger(parsedValue);

  if (!Number.isFinite(parsedValue) || parsedValue < 0 || !isValidInteger) {
    const key = requireSafeInteger
      ? "machines.errors.invalidNonNegativeInteger"
      : "machines.errors.invalidNonNegativeNumber";
    throw new Error(t(key, { field: fieldName }));
  }

  return parsedValue;
}

async function compressImage(
  file: File,
  t: (key: string) => string
): Promise<File> {
  const imageUrl = URL.createObjectURL(file);

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();

      img.onload = () => resolve(img);
      img.onerror = () =>
        reject(new Error(t("vehicles.errors.photoLoadFailed")));

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
// -----------------------------------------------------------------------------
// Zdieľaný detail stroja — pozri obdobný komentár v
// app/vozidla/VehicleDetailView.tsx. Web wrapper: app/stroje/[id]/page.tsx
// (useParams). Mobile wrapper: mobile/app/stroje/detail/page.tsx
// (useSearchParams).
// -----------------------------------------------------------------------------
export default function MachineDetailView({
  entityId,
}: {
  entityId: string;
}) {
  const machineId = entityId;

  const [userId, setUserId] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [machine, setMachine] = useState<MachineRow | null>(null);
  const [photos, setPhotos] = useState<MachinePhoto[]>([]);
  const [services, setServices] = useState<MachineService[]>([]);
  const [service, setService] = useState(emptyService);
  const [showServiceForm, setShowServiceForm] = useState(false);
  const [editingServiceId, setEditingServiceId] = useState<string | null>(null);
  const [isServiceSaving, setIsServiceSaving] = useState(false);
  const [deletingServiceId, setDeletingServiceId] = useState<string | null>(null);
  const [documents, setDocuments] = useState<MachineDocumentEntry[]>([]);
  const [tab, setTab] = useState<DetailTab>("overview");
  const [isUploading, setIsUploading] = useState(false);
  const [deletingPhotoId, setDeletingPhotoId] = useState<string | null>(null);
  const serviceSaveInProgressRef = useRef(false);
  const serviceDeleteInProgressRef = useRef(false);
  const { legalHold } = useCompanyDpaLegalHold();
  const { t, locale } = useLocale();

  useEffect(() => {
    checkUser();
  }, []);

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
      setMachine(null);
      setPhotos([]);
      setServices([]);
      return;
    }

    setCompanyId(membership.company_id);
    loadMachine(membership.company_id);
    loadPhotos(membership.company_id);
    loadServices(membership.company_id);
    loadDocuments();
  }

  async function loadMachine(currentCompanyId: string) {
    const { data } = await supabase
      .from("machines")
      .select("*")
      .eq("id", machineId)
      .eq("company_id", currentCompanyId)
      .single();

    setMachine(data);
  }

  /**
   * Dokumenty priradené k stroju. Väzba document_links.machine_id /
   * ai_evidence.machine_id v DB existuje a Inbox do nej už dnes zapisuje
   * ("Uložiť k stroju") — detail stroja ich len nikdy nezobrazil.
   * Žiadna nová tabuľka, žiadna nová migrácia, iba čítanie cez RLS.
   */
  async function loadDocuments() {
    setDocuments(await fetchMachineDocuments(supabase, machineId));
  }

  async function loadPhotos(currentCompanyId: string = companyId) {
    if (!currentCompanyId) return;

    const { data } = await supabase
      .from("machine_photos")
      .select("*")
      .eq("machine_id", machineId)
      .eq("company_id", currentCompanyId)
      .order("created_at", { ascending: false });

    setPhotos(data || []);
  }

  async function loadServices(currentCompanyId: string = companyId) {
    if (!currentCompanyId) return;

    const { data, error } = await supabase
      .from("machine_services")
      .select("*")
      .eq("machine_id", machineId)
      .eq("company_id", currentCompanyId)
      .order("service_date", { ascending: false });

    if (error) {
      alert(t("machines.errors.loadServicesFailedPrefix", { message: error.message }));
      return;
    }

    setServices(data || []);
  }

  function updateService(key: keyof typeof emptyService, value: string) {
    setService((currentService) => ({
      ...currentService,
      [key]: value,
    }));
  }

  function startEditService(item: MachineService) {
    setEditingServiceId(item.id);
    setShowServiceForm(true);
    setService({
      service_date: item.service_date || "",
      mileage: item.mileage == null ? "" : String(item.mileage),
      title: item.title || "",
      description: item.description || "",
      cost: item.cost == null ? "" : String(item.cost),
      technician: item.technician || "",
      next_service_date: item.next_service_date || "",
    });
  }

  function cancelServiceEdit() {
    setEditingServiceId(null);
    setService(emptyService);
    setShowServiceForm(false);
  }

  async function saveService() {
    if (
      serviceSaveInProgressRef.current ||
      serviceDeleteInProgressRef.current
    ) {
      return;
    }

    if (!service.service_date || !service.title.trim()) {
      alert(t("machines.errors.serviceValidationRequired"));
      return;
    }

    if (!editingServiceId && legalHold) {
      alert(t("common.legalHoldMessage"));
      return;
    }

    serviceSaveInProgressRef.current = true;
    setIsServiceSaving(true);

    try {
      const mileage = parseOptionalNonNegativeNumber(
        service.mileage,
        t("machines.detail.mileageLabel"),
        t,
        true
      );
      const cost = parseOptionalNonNegativeNumber(
        service.cost,
        t("machines.errors.costFieldName"),
        t
      );

      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();

      if (userError || !user) {
        throw new Error(t("machines.errors.serviceSaveLoginRequired"));
      }

      const membership = await getMyActiveMembership();

      if (!membership) {
        throw new Error(t("machines.errors.serviceSaveLoginRequired"));
      }

      const payload = {
        machine_id: machineId,
        user_id: user.id,
        service_date: service.service_date,
        mileage,
        title: service.title.trim(),
        description: service.description.trim() || null,
        cost,
        technician: service.technician.trim() || null,
        next_service_date: service.next_service_date || null,
      };

      if (editingServiceId) {
        const { data: updatedServices, error: updateError } = await supabase
          .from("machine_services")
          .update(payload)
          .eq("id", editingServiceId)
          .eq("machine_id", machineId)
          .eq("company_id", membership.company_id)
          .select("id");

        if (updateError) throw updateError;

        if (updatedServices?.length !== 1) {
          throw new Error(t("machines.errors.serviceUpdateFailedPermission"));
        }
      } else {
        const { data: insertedServices, error: insertError } = await supabase
          .from("machine_services")
          .insert(payload)
          .select("id");

        if (insertError) throw insertError;

        if (insertedServices?.length !== 1) {
          throw new Error(t("machines.errors.serviceInsertFailed"));
        }
      }

      setService(emptyService);
      setEditingServiceId(null);
      setShowServiceForm(false);
      await loadServices(membership.company_id);
    } catch (saveError: unknown) {
      const message =
        saveError instanceof Error
          ? saveError.message
          : t("vehicles.errors.unknownError");
      alert(t("machines.errors.serviceSaveFailedPrefix", { message }));
    } finally {
      serviceSaveInProgressRef.current = false;
      setIsServiceSaving(false);
    }
  }

  async function deleteService(serviceId: string) {
    if (
      serviceDeleteInProgressRef.current ||
      serviceSaveInProgressRef.current
    ) {
      return;
    }

    const confirmed = confirm(t("machines.errors.serviceDeleteConfirm"));
    if (!confirmed) return;

    serviceDeleteInProgressRef.current = true;
    setDeletingServiceId(serviceId);

    try {
      const membership = await getMyActiveMembership();

      if (!membership) {
        throw new Error(t("machines.errors.serviceDeleteLoginRequired"));
      }

      const { data: deletedServices, error: deleteError } = await supabase
        .from("machine_services")
        .delete()
        .eq("id", serviceId)
        .eq("machine_id", machineId)
        .eq("company_id", membership.company_id)
        .select("id");

      if (deleteError) throw deleteError;

      if (deletedServices?.length !== 1) {
        throw new Error(t("machines.errors.serviceDeleteFailedPermission"));
      }

      setServices((currentServices) =>
        currentServices.filter((item) => item.id !== serviceId)
      );

      if (editingServiceId === serviceId) {
        cancelServiceEdit();
      }
    } catch (deleteError: unknown) {
      const message =
        deleteError instanceof Error
          ? deleteError.message
          : t("vehicles.errors.unknownError");
      alert(t("machines.errors.serviceDeleteFailedPrefix", { message }));
    } finally {
      serviceDeleteInProgressRef.current = false;
      setDeletingServiceId(null);
    }
  }

  async function uploadPhoto(
  event: React.ChangeEvent<HTMLInputElement>
) {
  const originalFile = event.target.files?.[0];

  if (!originalFile || !userId || !machineId) return;

  if (legalHold) {
    event.target.value = "";
    alert(t("common.legalHoldMessage"));
    return;
  }

  setIsUploading(true);

  try {
    const compressedFile = await compressImage(originalFile, t);

    console.log(
      "Pôvodná veľkosť fotografie stroja:",
      originalFile.size,
      "bytes"
    );

    console.log(
      "Komprimovaná veľkosť fotografie stroja:",
      compressedFile.size,
      "bytes"
    );

    const filePath =
      `${userId}/${machineId}/${Date.now()}-${compressedFile.name}`;

    const { error: uploadError } = await supabase.storage
      .from("machine-photos")
      .upload(filePath, compressedFile, {
        cacheControl: "3600",
        upsert: false,
        contentType: compressedFile.type,
      });

    if (uploadError) {
      throw uploadError;
    }

    const { error: dbError } = await supabase
      .from("machine_photos")
      .insert({
        user_id: userId,
        machine_id: machineId,
        file_path: filePath,
      });

    if (dbError) {
      // Ak zlyhá zápis do databázy, odstránime už nahraný súbor.
      await supabase.storage
        .from("machine-photos")
        .remove([filePath]);

      throw dbError;
    }

    await loadPhotos();
  } catch (error: unknown) {
    console.error("Chyba pri nahrávaní fotografie stroja:", error);

    alert(
      t("machines.errors.photoUploadFailedPrefix", {
        message:
          error instanceof Error ? error.message : t("vehicles.errors.unknownError"),
      })
    );
  } finally {
    setIsUploading(false);

    // Umožní znovu vybrať aj tú istú fotografiu.
    event.target.value = "";
  }
}
  async function deletePhoto(photo: MachinePhoto) {
    if (deletingPhotoId) return;

    const photoId = String(photo?.id || "");

    if (!photoId) {
      alert(t("machines.errors.photoNoValidId"));
      return;
    }

    const confirmed = confirm(t("vehicles.gallery.confirmDeletePhoto"));
    if (!confirmed) return;

    setDeletingPhotoId(photoId);

    try {
      const membership = await getMyActiveMembership();

      if (!membership) {
        throw new Error(t("vehicles.errors.notLoggedInFormal"));
      }

      const { data: deletedPhotos, error: deletePhotoError } = await supabase
        .from("machine_photos")
        .delete()
        .eq("id", photoId)
        .eq("machine_id", machineId)
        .eq("company_id", membership.company_id)
        .select("id, file_path");

      if (deletePhotoError) throw deletePhotoError;

      if (deletedPhotos?.length !== 1) {
        throw new Error(t("vehicles.errors.photoDeleteDbMismatch"));
      }

      // UI aktualizujeme až po potvrdenom databázovom delete.
      setPhotos((currentPhotos) =>
        currentPhotos.filter(
          (currentPhoto) => String(currentPhoto.id) !== photoId
        )
      );

      const deletedFilePath = deletedPhotos[0].file_path;

      // Storage čistíme až po vymazaní DB riadku a aktualizácii UI.
      if (deletedFilePath) {
        const { error: storageError } = await supabase.storage
          .from("machine-photos")
          .remove([deletedFilePath]);

        if (storageError) {
          console.error(
            "Databázový záznam fotografie bol vymazaný, ale Storage cleanup zlyhal:",
            storageError
          );
          alert(t("vehicles.errors.photoStorageDeleteFailed"));
        }
      }
    } catch (deleteError: unknown) {
      console.error("Chyba pri mazaní fotografie stroja:", deleteError);
      const message =
        deleteError instanceof Error
          ? deleteError.message
          : typeof deleteError === "object" &&
              deleteError !== null &&
              "message" in deleteError
            ? String(deleteError.message)
            : t("vehicles.errors.unknownError");
      alert(t("vehicles.errors.deletePhotoFailedPrefix", { message }));
    } finally {
      setDeletingPhotoId(null);
    }
  }

  function photoUrl(path: string) {
    const { data } = supabase.storage
      .from("machine-photos")
      .getPublicUrl(path);

    return data.publicUrl;
  }

  // ---------------------------------------------------------------------------
  // Odvodené ukazovatele. Tabuľka `machines` nemá motohodiny ani termíny
  // servisu — všetko nižšie pochádza z už načítaných machine_services.
  // ---------------------------------------------------------------------------
  const summary = summarizeMachineServices(services as unknown as MachineServiceRow[]);
  const attention = machineServiceAttention(summary.nextServiceDate);

  if (!machine) {
    return (
      <PageShell>
        <p className="py-10 text-sm text-secondary">{t("common.buttons.loading")}</p>
      </PageShell>
    );
  }

  const TABS: { key: DetailTab; label: string; count?: number }[] = [
    { key: "overview", label: t("machines.detail.tabOverview") },
    { key: "service", label: t("machines.detail.servicesTitle"), count: services.length },
    { key: "documents", label: t("machines.detail.documentsTitle"), count: documents.length },
    { key: "photos", label: t("machines.detail.galleryTitle"), count: photos.length },
  ];

  const coverPhoto = photos[0] ? photoUrl(photos[0].file_path) : null;

  return (
    <PageShell>
      <BackLink href="/stroje" label={t("nav.machines")} className="mb-6" />

      <PageHeader
        eyebrow={
          <span className="inline-flex items-center gap-2">
            <MachineIcon size={18} />
            {machine.category || t("nav.machines")}
          </span>
        }
        title={
          <span className="flex items-center gap-3">
            {coverPhoto ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={coverPhoto}
                alt=""
                className="h-11 w-11 shrink-0 rounded-doc-sm border border-doc-border object-cover"
              />
            ) : (
              <span
                aria-hidden="true"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-doc-sm border border-doc-border bg-surface-2 text-muted-esblu"
              >
                <MachineIcon size={22} />
              </span>
            )}
            <span className="min-w-0 break-words">{machine.name}</span>
          </span>
        }
        badges={
          <>
            {machine.status && (
              <span className="rounded-doc-sm border border-doc-border px-2 py-0.5 text-xs font-medium text-secondary">
                {machine.status}
              </span>
            )}
            {attention === "overdue" && (
              <StatusBadge kind="overdue" label={t("machines.service.overdue")} />
            )}
            {attention === "due_soon" && (
              <StatusBadge kind="needs_review" label={t("machines.service.dueSoon")} />
            )}
          </>
        }
        meta={
          [machine.manufacturer, machine.model, machine.serial_number]
            .filter(Boolean)
            .join(" · ") || undefined
        }
      />

      {/* Kľúčové ukazovatele. Motohodiny sú zámerne označené ako "pri
          poslednom servise" — machines nemá stĺpec s aktuálnym stavom a
          tváriť sa, že ho máme, by bolo klamstvo v evidencii majetku. */}
      <div className="mt-6">
        <MetricGrid>
          <Metric
            label={t("machines.detail.mileageLabel")}
            value={
              summary.lastKnownMileage === null
                ? "—"
                : formatNumber(summary.lastKnownMileage, locale)
            }
            hint={
              summary.lastKnownMileage === null
                ? undefined
                : t("machines.register.atLastService")
            }
          />
          <Metric
            label={t("machines.detail.lastServiceLabel")}
            value={
              summary.lastServiceDate ? formatDate(summary.lastServiceDate, locale) : "—"
            }
            hint={
              summary.serviceCount > 0
                ? t("machines.detail.serviceCount", { count: String(summary.serviceCount) })
                : undefined
            }
          />
          <Metric
            label={t("inbox.fields.nextServiceDate")}
            value={
              summary.nextServiceDate ? formatDate(summary.nextServiceDate, locale) : "—"
            }
            tone={
              attention === "overdue" ? "critical" : attention === "due_soon" ? "warning" : "neutral"
            }
          />
          <Metric
            label={t("machines.detail.totalServiceCostLabel")}
            value={
              summary.totalCost === null
                ? "—"
                : formatNumber(summary.totalCost, locale, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })
            }
            hint={summary.totalCost === null ? undefined : t("machines.detail.fromServiceRecords")}
          />
        </MetricGrid>
      </div>

      {/* Upozornenie na termín — rovnaké prahy ako Dashboard a Intent
          Engine (lib/deadlines.ts), aby si jeden termín neprotirečil. */}
      {(attention === "overdue" || attention === "due_soon") && summary.nextServiceDate && (
        <div className="mt-4">
          <Notice tone={attention === "overdue" ? "critical" : "warning"}>
            {attention === "overdue"
              ? t("search.answers.dateOverdue", {
                  type: t("search.deadlineTypeLabels.machineService"),
                  entity: machine.name || "",
                  date: formatDate(summary.nextServiceDate, locale),
                  days: Math.abs(computeDeadlineStatus(summary.nextServiceDate)?.daysRemaining ?? 0),
                })
              : t("search.answers.dateDueSoon", {
                  type: t("search.deadlineTypeLabels.machineService"),
                  entity: machine.name || "",
                  date: formatDate(summary.nextServiceDate, locale),
                  days: computeDeadlineStatus(summary.nextServiceDate)?.daysRemaining ?? 0,
                })}
          </Notice>
        </div>
      )}

      {/* Záložky. Detail majetku má štyri celkom odlišné obsahy —
          zoskrolovať ich pod seba by znamenalo, že fotky sú 900 px
          pod servisom. */}
      <div
        role="tablist"
        aria-label={t("machines.detail.sectionsLabel")}
        className="mt-6 -mx-1 flex gap-1 overflow-x-auto px-1"
      >
        {TABS.map((item) => (
          <button
            key={item.key}
            role="tab"
            type="button"
            aria-selected={tab === item.key}
            onClick={() => setTab(item.key)}
            className={`whitespace-nowrap rounded-doc-sm border px-3 py-2 text-sm font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-cyan ${
              tab === item.key
                ? "border-border-strong bg-surface-hover text-primary"
                : "border-doc-border text-secondary hover:text-primary"
            }`}
          >
            {item.label}
            {item.count !== undefined && item.count > 0 && (
              <span className="ml-1.5 tabular-nums opacity-70">{item.count}</span>
            )}
          </button>
        ))}
      </div>

      {/* ------------------------------ PREHĽAD ----------------------------- */}
      {tab === "overview" && (
        <div className="mt-4 space-y-4">
          <SectionPanel title={t("machines.detail.tabOverview")}>
            <MetadataGrid
              items={[
                { label: t("machines.list.categoryLabel"), value: machine.category },
                { label: t("machines.list.manufacturerLabel"), value: machine.manufacturer },
                { label: t("machines.list.modelLabel"), value: machine.model },
                { label: t("machines.list.serialNumberLabel"), value: machine.serial_number },
                { label: t("inbox.fields.rokVyroby"), value: machine.year },
                {
                  label: t("machines.detail.purchaseDateLabel"),
                  value: machine.purchase_date
                    ? formatDate(machine.purchase_date, locale)
                    : null,
                },
                { label: t("machines.list.statusLabel"), value: machine.status },
              ]}
            />
          </SectionPanel>

          {machine.notes && (
            <SectionPanel title={t("machines.detail.notesLabel")}>
              <p className="whitespace-pre-wrap text-sm text-secondary">{machine.notes}</p>
            </SectionPanel>
          )}
        </div>
      )}

      {/* ------------------------------- SERVIS ----------------------------- */}
      {tab === "service" && (
        <div className="mt-4">
          <SectionPanel
            title={t("machines.detail.servicesTitle")}
            actions={
              <button
                type="button"
                onClick={() => {
                  if (showServiceForm) cancelServiceEdit();
                  else setShowServiceForm(true);
                }}
                className={`${docButtonSecondary} gap-2`}
              >
                {showServiceForm ? null : <PlusIcon size={16} />}
                {showServiceForm
                  ? t("machines.detail.closeForm")
                  : t("vehicles.services.addService")}
              </button>
            }
          >
            {legalHold && (
              <div className="mb-4">
                <Notice tone="warning">{t("common.legalHoldMessage")}</Notice>
              </div>
            )}

            {showServiceForm && (
              <div className="mb-4 rounded-doc border border-doc-border bg-surface-2 p-4">
                <p className="mb-3 text-sm font-semibold text-primary">
                  {editingServiceId
                    ? t("vehicles.services.editServiceTitle")
                    : t("vehicles.services.addServiceTitle")}
                </p>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className={docLabel} htmlFor="service-date">
                      {t("machines.detail.serviceDateLabel")}
                    </label>
                    <input
                      id="service-date"
                      type="date"
                      className={docField}
                      value={service.service_date}
                      onChange={(event) => updateService("service_date", event.target.value)}
                    />
                  </div>

                  <div>
                    <label className={docLabel} htmlFor="service-title">
                      {t("machines.detail.titleLabel")}
                    </label>
                    <input
                      id="service-title"
                      className={docField}
                      value={service.title}
                      onChange={(event) => updateService("title", event.target.value)}
                    />
                  </div>

                  <div>
                    <label className={docLabel} htmlFor="service-mileage">
                      {t("machines.detail.mileageLabel")}
                    </label>
                    <input
                      id="service-mileage"
                      inputMode="numeric"
                      className={docField}
                      value={service.mileage}
                      onChange={(event) => updateService("mileage", event.target.value)}
                    />
                  </div>

                  <div>
                    <label className={docLabel} htmlFor="service-cost">
                      {t("machines.detail.costLabel")}
                    </label>
                    <input
                      id="service-cost"
                      inputMode="decimal"
                      className={docField}
                      value={service.cost}
                      onChange={(event) => updateService("cost", event.target.value)}
                    />
                  </div>

                  <div>
                    <label className={docLabel} htmlFor="service-technician">
                      {t("machines.detail.technicianLabel")}
                    </label>
                    <input
                      id="service-technician"
                      className={docField}
                      value={service.technician}
                      onChange={(event) => updateService("technician", event.target.value)}
                    />
                  </div>

                  <div>
                    <label className={docLabel} htmlFor="service-next">
                      {t("inbox.fields.nextServiceDate")}
                    </label>
                    <input
                      id="service-next"
                      type="date"
                      className={docField}
                      value={service.next_service_date}
                      onChange={(event) =>
                        updateService("next_service_date", event.target.value)
                      }
                    />
                  </div>

                  <div className="sm:col-span-2">
                    <label className={docLabel} htmlFor="service-description">
                      {t("machines.detail.descriptionLabel")}
                    </label>
                    <textarea
                      id="service-description"
                      rows={3}
                      className={docField}
                      value={service.description}
                      onChange={(event) => updateService("description", event.target.value)}
                    />
                  </div>
                </div>

                <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
                  <button
                    type="button"
                    onClick={cancelServiceEdit}
                    className={docButtonSecondary}
                  >
                    {t("vehicles.forms.cancelEdit")}
                  </button>
                  <button
                    type="button"
                    onClick={saveService}
                    disabled={isServiceSaving}
                    className={docButtonPrimary}
                  >
                    {isServiceSaving
                      ? t("common.buttons.saving")
                      : editingServiceId
                        ? t("machines.detail.saveChangesPlain")
                        : t("machines.detail.saveServicePlain")}
                  </button>
                </div>
              </div>
            )}

            {services.length === 0 ? (
              <EmptyState title={t("machines.detail.noServicesYet")} />
            ) : (
              /* Časová os namiesto kopy kariet — servisná história sa číta
                 chronologicky, nie ako galéria. */
              <ol className="mt-1">
                {services.map((item, index) => (
                  <TimelineItem
                    key={item.id}
                    last={index === services.length - 1}
                    marker={<WrenchIcon size={14} />}
                    title={item.title}
                    meta={
                      <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm">
                        <span className="tabular-nums text-secondary">
                          {item.service_date ? formatDate(item.service_date, locale) : "—"}
                        </span>
                        {item.mileage !== null && item.mileage !== "" && (
                          <span className="text-muted-esblu">
                            {t("machines.detail.mileageLabel")}:{" "}
                            <span className="tabular-nums">{item.mileage}</span>
                          </span>
                        )}
                        {item.technician && (
                          <span className="text-muted-esblu">{item.technician}</span>
                        )}
                        {item.cost !== null && item.cost !== "" && (
                          <span className="font-medium tabular-nums text-primary">
                            {item.cost} €
                          </span>
                        )}
                        {item.next_service_date && (
                          <span className="text-muted-esblu">
                            {t("inbox.fields.nextServiceDate")}:{" "}
                            <span className="tabular-nums">
                              {formatDate(item.next_service_date, locale)}
                            </span>
                          </span>
                        )}
                      </span>
                    }
                    actions={
                      <>
                        <button
                          type="button"
                          onClick={() => startEditService(item)}
                          aria-label={`${t("common.buttons.edit")}: ${item.title}`}
                          className={`${docButtonSecondary} px-2.5 text-xs`}
                        >
                          {t("common.buttons.edit")}
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteService(item.id)}
                          disabled={deletingServiceId === item.id}
                          aria-label={`${t("common.buttons.delete")}: ${item.title}`}
                          className={`${docButtonDanger} px-2.5 text-xs`}
                        >
                          {deletingServiceId === item.id
                            ? t("inbox.deleting")
                            : t("common.buttons.delete")}
                        </button>
                      </>
                    }
                  >
                    {item.description && (
                      <p className="whitespace-pre-wrap text-sm text-secondary">
                        {item.description}
                      </p>
                    )}
                  </TimelineItem>
                ))}
              </ol>
            )}
          </SectionPanel>
        </div>
      )}

      {/* ----------------------------- DOKUMENTY ---------------------------- */}
      {tab === "documents" && (
        <div className="mt-4">
          <SectionPanel
            title={t("machines.detail.documentsTitle")}
            description={t("machines.detail.documentsHint")}
          >
            {documents.length === 0 ? (
              <EmptyState title={t("machines.detail.noDocuments")} />
            ) : (
              <ul className="space-y-1.5">
                {documents.map((doc) => (
                  <li key={`${doc.source}-${doc.id}`}>
                    <Link
                      href={doc.href}
                      className="flex items-center gap-3 rounded-doc border border-doc-border bg-surface-2 px-3 py-2.5 transition hover:border-border-strong hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-cyan"
                    >
                      <span aria-hidden="true" className="shrink-0 text-muted-esblu">
                        <FileIcon size={18} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-primary">
                          {doc.label || t("inbox.documentFallback")}
                        </span>
                        <span className="mt-0.5 block truncate text-sm text-muted-esblu">
                          {doc.documentType || t("inbox.documentFallback")}
                          {doc.date ? ` · ${formatDate(doc.date, locale)}` : ""}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </SectionPanel>
        </div>
      )}

      {/* ---------------------------- FOTOGRAFIE ---------------------------- */}
      {tab === "photos" && (
        <div className="mt-4">
          <SectionPanel
            title={t("machines.detail.galleryTitle")}
            actions={
              <>
                <label
                  className={`${docButtonSecondary} cursor-pointer gap-2 ${
                    isUploading || legalHold ? "pointer-events-none opacity-40" : ""
                  }`}
                >
                  <CameraIcon size={16} />
                  {t("inbox.registration.takePhoto")}
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="sr-only"
                    disabled={isUploading || legalHold}
                    onChange={uploadPhoto}
                  />
                </label>
                <label
                  className={`${docButtonSecondary} cursor-pointer gap-2 ${
                    isUploading || legalHold ? "pointer-events-none opacity-40" : ""
                  }`}
                >
                  <ImageIcon size={16} />
                  {t("machines.detail.galleryButton")}
                  <input
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    disabled={isUploading || legalHold}
                    onChange={uploadPhoto}
                  />
                </label>
              </>
            }
          >
            {legalHold && (
              <div className="mb-4">
                <Notice tone="warning">{t("common.legalHoldMessage")}</Notice>
              </div>
            )}

            {isUploading && (
              <p className="mb-3 text-sm text-secondary">{t("inbox.uploading")}</p>
            )}

            {photos.length === 0 ? (
              <EmptyState title={t("machines.detail.noPhotosYet")} />
            ) : (
              /* Rovnaký pomer strán pre každú fotku — mriežka s náhodne
                 vysokými dlaždicami pôsobí ako nástenka, nie ako evidencia. */
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {photos.map((photo) => (
                  <li key={photo.id} className="group relative">
                    <a
                      href={photoUrl(photo.file_path)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block overflow-hidden rounded-doc border border-doc-border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-cyan"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={photoUrl(photo.file_path)}
                        alt={t("machines.photoAlt")}
                        className="aspect-[4/3] w-full object-cover transition group-hover:opacity-90"
                      />
                    </a>
                    <button
                      type="button"
                      onClick={() => deletePhoto(photo)}
                      disabled={deletingPhotoId === photo.id || legalHold}
                      aria-label={t("vehicles.buttons.deleteWithIcon")}
                      className="absolute right-2 top-2 flex h-9 w-9 items-center justify-center rounded-doc-sm border border-danger/30 bg-page-bg/80 text-danger backdrop-blur transition hover:bg-danger-soft disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-cyan"
                    >
                      <TrashIcon size={16} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </SectionPanel>
        </div>
      )}
    </PageShell>
  );
}
