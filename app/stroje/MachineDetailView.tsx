"use client";

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import BackLink from "@/app/components/BackLink";
import { getMyActiveMembership } from "@/lib/company";
import { useCompanyDpaLegalHold } from "@/app/components/CompanyDpaGate";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { computeDeadlineStatus } from "@/lib/deadlines";

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
  const [machine, setMachine] = useState<any>(null);
  const [photos, setPhotos] = useState<any[]>([]);
  const [services, setServices] = useState<MachineService[]>([]);
  const [service, setService] = useState(emptyService);
  const [showServiceForm, setShowServiceForm] = useState(false);
  const [editingServiceId, setEditingServiceId] = useState<string | null>(null);
  const [isServiceSaving, setIsServiceSaving] = useState(false);
  const [deletingServiceId, setDeletingServiceId] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [deletingPhotoId, setDeletingPhotoId] = useState<string | null>(null);
  const serviceSaveInProgressRef = useRef(false);
  const serviceDeleteInProgressRef = useRef(false);
  const { legalHold } = useCompanyDpaLegalHold();
  const { t } = useLocale();

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
  } catch (error: any) {
    console.error("Chyba pri nahrávaní fotografie stroja:", error);

    alert(
      t("machines.errors.photoUploadFailedPrefix", {
        message: error?.message || t("vehicles.errors.unknownError"),
      })
    );
  } finally {
    setIsUploading(false);

    // Umožní znovu vybrať aj tú istú fotografiu.
    event.target.value = "";
  }
}
  async function deletePhoto(photo: any) {
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

  if (!machine) {
    return <div className="p-10">{t("common.buttons.loading")}</div>;
  }

  return (
    <main className="app-shell-bg min-h-screen p-10">
      <BackLink href="/stroje" label={t("nav.machines")} className="mb-4" />

      <h1 className="text-4xl font-bold">🚜 {machine.name}</h1>

      {/* Upozornenie na ďalší servis — Intent Engine / Deadline Engine
          (zadanie, bod 9B: "Detail vozidla/stroja — relevantné upozornenie
          pri konkrétnej entite"). Číta VÝLUČNE už načítané `services`
          (žiadny nový dopyt) — `services[0]` je najnovší servis (zoradené
          service_date DESC pri loadServices()), presne rovnaká
          "posledný servis → jeho next_service_date" logika, akú používa
          zdieľaný lib/deadlines.ts pre Dashboard aj Intent Engine. */}
      {(() => {
        const nextServiceDate = services[0]?.next_service_date;
        const status = computeDeadlineStatus(nextServiceDate);
        if (!status) return null;

        const isOverdue = status.severity === "overdue";

        return (
          <div
            className={`mt-4 rounded-2xl border px-4 py-3 text-sm font-medium ${
              isOverdue
                ? "border-red-400/30 bg-red-400/10 text-red-400"
                : "border-amber-400/30 bg-amber-400/10 text-amber-400"
            }`}
          >
            {isOverdue
              ? t("search.answers.dateOverdue", {
                  type: t("search.deadlineTypeLabels.machineService"),
                  entity: machine.name || "",
                  date: new Date(nextServiceDate as string).toLocaleDateString(),
                  days: Math.abs(status.daysRemaining),
                })
              : t("search.answers.dateDueSoon", {
                  type: t("search.deadlineTypeLabels.machineService"),
                  entity: machine.name || "",
                  date: new Date(nextServiceDate as string).toLocaleDateString(),
                  days: status.daysRemaining,
                })}
          </div>
        );
      })()}

      <div className="surface-card mt-8 p-8">
        <div className="grid grid-cols-2 gap-5">
          <p><b>{t("machines.list.categoryLabel")}:</b> {machine.category || "—"}</p>
          <p><b>{t("machines.list.manufacturerLabel")}:</b> {machine.manufacturer || "—"}</p>
          <p><b>{t("machines.list.modelLabel")}:</b> {machine.model || "—"}</p>
          <p><b>{t("machines.list.serialNumberLabel")}:</b> {machine.serial_number || "—"}</p>
          <p><b>{t("inbox.fields.rokVyroby")}:</b> {machine.year || "—"}</p>
          <p><b>{t("machines.detail.purchaseDateLabel")}:</b> {machine.purchase_date || "—"}</p>
          <p><b>{t("machines.list.statusLabel")}:</b> {machine.status || "—"}</p>
        </div>

        {machine.notes && (
          <div className="mt-6 rounded-xl bg-surface-2 p-4">
            <b>{t("machines.detail.notesLabel")}</b>
            <p className="mt-2">{machine.notes}</p>
          </div>
        )}
      </div>

      <section className="mt-10 rounded-2xl bg-surface-1 p-5 shadow sm:p-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-2xl font-bold">{t("machines.detail.servicesTitle")}</h2>

          <button
            type="button"
            onClick={() => {
              if (showServiceForm) {
                cancelServiceEdit();
              } else {
                if (legalHold) {
                  alert(t("common.legalHoldMessage"));
                  return;
                }
                setService(emptyService);
                setEditingServiceId(null);
                setShowServiceForm(true);
              }
            }}
            disabled={
              isServiceSaving ||
              deletingServiceId !== null ||
              (!showServiceForm && legalHold)
            }
            className="w-full rounded-xl bg-blue-600 px-5 py-3 text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-400 sm:w-auto"
          >
            {showServiceForm ? t("machines.detail.closeForm") : t("vehicles.services.addService")}
          </button>
        </div>

        {legalHold && !showServiceForm && (
          <p className="mt-3 text-sm text-amber-400">{t("common.legalHoldMessage")}</p>
        )}

        {showServiceForm && (
          <div className="mt-6 rounded-2xl border border-subtle bg-surface-2 p-4 sm:p-6">
            <h3 className="text-xl font-bold">
              {editingServiceId
                ? t("vehicles.services.editServiceTitle")
                : t("vehicles.services.addServiceTitle")}
            </h3>

            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
              <label className="min-w-0 text-sm font-medium text-secondary">
                {t("machines.detail.serviceDateLabel")}
                <input
                  type="date"
                  value={service.service_date}
                  onChange={(event) =>
                    updateService("service_date", event.target.value)
                  }
                  disabled={isServiceSaving}
                  className="mt-1 w-full min-w-0 rounded-xl border bg-surface-1 p-3 text-base font-normal text-primary disabled:bg-surface-2"
                />
              </label>

              <label className="min-w-0 text-sm font-medium text-secondary">
                {t("machines.detail.mileageLabel")}
                <input
                  type="number"
                  min="0"
                  step="1"
                  inputMode="numeric"
                  value={service.mileage}
                  onChange={(event) =>
                    updateService("mileage", event.target.value)
                  }
                  disabled={isServiceSaving}
                  className="mt-1 w-full min-w-0 rounded-xl border bg-surface-1 p-3 text-base font-normal text-primary disabled:bg-surface-2"
                />
              </label>

              <label className="min-w-0 text-sm font-medium text-secondary">
                {t("machines.detail.titleLabel")}
                <input
                  value={service.title}
                  onChange={(event) =>
                    updateService("title", event.target.value)
                  }
                  disabled={isServiceSaving}
                  className="mt-1 w-full min-w-0 rounded-xl border bg-surface-1 p-3 text-base font-normal text-primary disabled:bg-surface-2"
                />
              </label>

              <label className="min-w-0 text-sm font-medium text-secondary">
                {t("machines.detail.costLabel")}
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  value={service.cost}
                  onChange={(event) =>
                    updateService("cost", event.target.value)
                  }
                  disabled={isServiceSaving}
                  className="mt-1 w-full min-w-0 rounded-xl border bg-surface-1 p-3 text-base font-normal text-primary disabled:bg-surface-2"
                />
              </label>

              <label className="min-w-0 text-sm font-medium text-secondary">
                {t("machines.detail.technicianLabel")}
                <input
                  value={service.technician}
                  onChange={(event) =>
                    updateService("technician", event.target.value)
                  }
                  disabled={isServiceSaving}
                  className="mt-1 w-full min-w-0 rounded-xl border bg-surface-1 p-3 text-base font-normal text-primary disabled:bg-surface-2"
                />
              </label>

              <label className="min-w-0 text-sm font-medium text-secondary">
                {t("inbox.fields.nextServiceDate")}
                <input
                  type="date"
                  value={service.next_service_date}
                  onChange={(event) =>
                    updateService("next_service_date", event.target.value)
                  }
                  disabled={isServiceSaving}
                  className="mt-1 w-full min-w-0 rounded-xl border bg-surface-1 p-3 text-base font-normal text-primary disabled:bg-surface-2"
                />
              </label>
            </div>

            <label className="mt-4 block text-sm font-medium text-secondary">
              {t("machines.detail.descriptionLabel")}
              <textarea
                value={service.description}
                onChange={(event) =>
                  updateService("description", event.target.value)
                }
                disabled={isServiceSaving}
                rows={4}
                className="mt-1 w-full min-w-0 resize-y rounded-xl border bg-surface-1 p-3 text-base font-normal text-primary disabled:bg-surface-2"
              />
            </label>

            <div className="mt-5 flex flex-col gap-3 sm:flex-row">
              <button
                type="button"
                onClick={saveService}
                disabled={isServiceSaving || deletingServiceId !== null}
                className="w-full rounded-xl bg-green-600 px-5 py-3 text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:bg-gray-400 sm:w-auto"
              >
                {isServiceSaving
                  ? t("common.buttons.saving")
                  : editingServiceId
                    ? t("machines.detail.saveChangesPlain")
                    : t("machines.detail.saveServicePlain")}
              </button>

              <button
                type="button"
                onClick={cancelServiceEdit}
                disabled={isServiceSaving}
                className="w-full rounded-xl bg-surface-2 px-5 py-3 text-primary hover:bg-surface-hover disabled:cursor-not-allowed disabled:bg-surface-1 disabled:text-muted-esblu sm:w-auto"
              >
                {t("common.buttons.cancel")}
              </button>
            </div>
          </div>
        )}

        {services.length === 0 ? (
          <p className="mt-6 text-muted-esblu">
            {t("machines.detail.noServicesYet")}
          </p>
        ) : (
          <div className="mt-6 space-y-4">
            {services.map((item) => (
              <article
                key={item.id}
                className="min-w-0 rounded-2xl border border-subtle bg-surface-2 p-4 shadow-sm sm:p-6"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <h3 className="break-words text-xl font-bold text-primary sm:text-2xl">
                      🔧 {item.title}
                    </h3>
                    <p className="mt-1 text-sm text-muted-esblu">
                      📅 {item.service_date}
                    </p>
                  </div>

                  {item.cost != null && (
                    <div className="badge-success self-start rounded-xl px-4 py-2 font-bold">
                      {item.cost} €
                    </div>
                  )}
                </div>

                <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-3">
                  <div className="rounded-xl bg-surface-1 p-4">
                    <p className="text-sm text-muted-esblu">{t("machines.detail.mileageLabel")}</p>
                    <p className="break-words text-lg font-bold">
                      {item.mileage != null ? item.mileage : "—"}
                    </p>
                  </div>

                  <div className="rounded-xl bg-surface-1 p-4">
                    <p className="text-sm text-muted-esblu">{t("machines.detail.technicianLabel")}</p>
                    <p className="break-words text-lg font-bold">
                      {item.technician || "—"}
                    </p>
                  </div>

                  <div className="rounded-xl bg-surface-1 p-4">
                    <p className="text-sm text-muted-esblu">{t("inbox.fields.nextServiceDate")}</p>
                    <p className="break-words text-lg font-bold">
                      {item.next_service_date || "—"}
                    </p>
                  </div>
                </div>

                {item.description && (
                  <p className="mt-5 whitespace-pre-wrap break-words rounded-xl bg-surface-1 p-4 text-secondary">
                    {item.description}
                  </p>
                )}

                <div className="mt-5 flex flex-col gap-3 sm:flex-row">
                  <button
                    type="button"
                    onClick={() => startEditService(item)}
                    disabled={
                      isServiceSaving || deletingServiceId !== null
                    }
                    className="w-full rounded-xl bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-400 sm:w-auto"
                  >
                    {t("common.buttons.edit")}
                  </button>

                  <button
                    type="button"
                    onClick={() => deleteService(item.id)}
                    disabled={
                      isServiceSaving || deletingServiceId !== null
                    }
                    className="w-full rounded-xl bg-red-600 px-4 py-2 text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-gray-400 sm:w-auto"
                  >
                    {deletingServiceId === item.id ? t("inbox.deleting") : t("common.buttons.delete")}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <div className="surface-card mt-10 p-8">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold">{t("machines.detail.galleryTitle")}</h2>

          <div className="flex gap-3">
  <label className="cursor-pointer rounded-xl bg-blue-600 px-5 py-3 text-white hover:bg-blue-700">
    {isUploading ? t("inbox.uploading") : t("inbox.registration.takePhoto")}
    <input
      type="file"
      accept="image/*"
      capture="environment"
      className="hidden"
      onChange={uploadPhoto}
      disabled={isUploading || legalHold}
    />
  </label>

  <label className="cursor-pointer rounded-xl border border-subtle bg-surface-1 px-5 py-3 text-secondary">
    {t("machines.detail.galleryButton")}
    <input
      type="file"
      accept="image/*"
      className="hidden"
      onChange={uploadPhoto}
      disabled={isUploading || legalHold}
    />
  </label>
</div>
        </div>

        {legalHold && (
          <p className="mt-3 text-sm text-amber-400">{t("common.legalHoldMessage")}</p>
        )}

        {photos.length === 0 ? (
          <p className="mt-6 text-muted-esblu">
            {t("machines.detail.noPhotosYet")}
          </p>
        ) : (
          <div className="mt-6 grid grid-cols-1 gap-5 md:grid-cols-3">
            {photos.map((photo) => (
              <div key={photo.id} className="rounded-xl border border-subtle bg-surface-2 p-3">
                <img
                  src={photoUrl(photo.file_path)}
                  alt={t("machines.photoAlt")}
                  className="h-48 w-full rounded-xl object-cover"
                />

                <button
                  onClick={() => deletePhoto(photo)}
                  disabled={deletingPhotoId !== null}
                  className="mt-3 w-full rounded-xl bg-red-600 px-4 py-2 text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-gray-400"
                >
                  {deletingPhotoId === String(photo.id)
                    ? t("inbox.deleting")
                    : t("vehicles.buttons.deleteWithIcon")}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
