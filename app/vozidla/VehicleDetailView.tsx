"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { openExternalUrl } from "@/lib/file-actions";
import BackLink from "@/app/components/BackLink";
import {
  getMyActiveMembership,
  isOwnerOrAdmin,
  type CompanyMemberRole,
} from "@/lib/company";
import { useCompanyDpaLegalHold } from "@/app/components/CompanyDpaGate";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { formatDate } from "@/lib/i18n/format";
import {
  VIGNETTE_COUNTRIES,
  VIGNETTE_OTHER_COUNTRY_OPTION,
  isValidVignetteCountryCode,
  vignetteCountryLabel,
  type VehicleVignette,
} from "@/lib/vehicle-vignettes";
import {
  buildVehicleDeadlines,
  deadlineTypeLabel,
} from "@/lib/deadlines";

// Dokumenty priradené k vozidlu z AI Inboxu (PZP, technický preukaz) —
// bod 2/3 zadania: po potvrdení v Inboxe majú tieto dokumenty "skončiť"
// priamo pri vozidle. Reuse existujúceho document/document_links modelu
// (žiadna nová tabuľka) — rovnaké riadky, aké appka už zapisuje z
// app/ai-evidencia, iba čítané tu cez vehicle_id namiesto company_id.
function getLinkedDocumentTypeLabels(
  t: (key: string) => string
): Record<string, string> {
  return {
    insurance: t("inbox.documentTypes.insurance"),
    vehicle_registration: t("vehicles.detail.documentTypeRegistration"),
  };
}

function getLinkedAttachmentTypeLabels(
  t: (key: string) => string
): Record<string, string> {
  return {
    white_card: t("inbox.attachmentTypes.white_card"),
    green_card: t("inbox.attachmentTypes.green_card"),
    insurance_event: t("inbox.attachmentTypes.insurance_event"),
    vehicle_registration_back: t("inbox.attachmentTypes.vehicle_registration_back"),
    other: t("inbox.attachmentTypes.other"),
  };
}

type LinkedVehicleDocument = {
  id: string;
  document_type: string | null;
  extracted_fields: Record<string, unknown> | null;
  storage_bucket: string | null;
  storage_path: string | null;
  original_filename: string | null;
  created_at: string | null;
  signedUrl: string | null;
  attachments: {
    id: string;
    attachment_type: string;
    signedUrl: string | null;
  }[];
};

function describeInsuranceSummary(
  fields: Record<string, unknown> | null,
  t: (key: string, vars?: Record<string, string | number>) => string
): string {
  if (!fields) return "";
  const provider = typeof fields.provider === "string" ? fields.provider : "";
  const policyNumber =
    typeof fields.policyNumber === "string" ? fields.policyNumber : "";
  const parts = [
    provider,
    policyNumber ? t("vehicles.detail.policyNumberPrefix", { number: policyNumber }) : "",
  ].filter(Boolean);
  return parts.join(" — ");
}

async function compressVehiclePhoto(
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

    const baseName = file.name.replace(/\.[^/.]+$/, "") || t("vehicles.gallery.defaultPhotoFileName");

    return new File([blob], `${baseName}.webp`, {
      type: "image/webp",
      lastModified: Date.now(),
    });
  } finally {
    URL.revokeObjectURL(imageUrl);
  }
}

// -----------------------------------------------------------------------------
// Zdieľaný detail vozidla — VŠETKA business logika, Supabase queries a JSX pre
// detail vozidla žijú VÝHRADNE tu. Web aj mobile routa sú iba tenké wrappery,
// ktoré si vlastným (presne jedným) hookom zistia ID vozidla a odovzdajú ho
// sem cez `entityId` prop — pozri app/vozidla/[id]/page.tsx (useParams, web)
// a mobile/app/vozidla/detail/page.tsx (useSearchParams, mobile static
// export). Toto zámerne NIE JE hook a nevolá žiadny hook podmienene, takže
// nijako neporušuje Rules of Hooks.
// -----------------------------------------------------------------------------
export default function VehicleDetailView({
  entityId,
}: {
  entityId: string;
}) {
  const vehicleId = entityId;

  const [vehicle, setVehicle] = useState<any>(null);
  const [services, setServices] = useState<any[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [editingServiceId, setEditingServiceId] = useState<string | null>(null);
  const [role, setRole] = useState<CompanyMemberRole | null>(null);
  const [userId, setUserId] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [photos, setPhotos] = useState<any[]>([]);
  const [isUploadingPhotos, setIsUploadingPhotos] = useState(false);
  const [deletingPhotoId, setDeletingPhotoId] = useState<string | null>(null);
  const [lightboxPhoto, setLightboxPhoto] = useState<any>(null);
  const [linkedDocuments, setLinkedDocuments] = useState<
    LinkedVehicleDocument[]
  >([]);
  const [linkedDocumentsLoading, setLinkedDocumentsLoading] = useState(false);
  const [deletingDocumentId, setDeletingDocumentId] = useState<string | null>(
    null
  );

  // Diaľničné známky (vehicle_vignettes) — samostatná tabuľka, 1:N na
  // vozidlo (pozri migráciu 20260823090000). owner/admin môžu pridávať/
  // upravovať/mazať (rovnaké RLS ako vehicles), employee iba prezerá — UI
  // nižšie preto formulár/tlačidlá vôbec nerenderuje pre role === "employee"
  // (nielen disabled input), server-side to navyše vynucuje RLS.
  const [vignettes, setVignettes] = useState<VehicleVignette[]>([]);
  const [vignettesLoading, setVignettesLoading] = useState(false);
  const [showVignetteForm, setShowVignetteForm] = useState(false);
  const [editingVignetteId, setEditingVignetteId] = useState<string | null>(
    null
  );
  const [isSavingVignette, setIsSavingVignette] = useState(false);
  const [deletingVignetteId, setDeletingVignetteId] = useState<string | null>(
    null
  );
  const emptyVignette = { country_code: "", valid_until: "" };
  const [vignette, setVignette] = useState(emptyVignette);
  // Select ponúka VIGNETTE_COUNTRIES + voľbu "Iná krajina" — pri jej výbere
  // sa zobrazí voľný ISO alpha-2 vstup (pozri JSX nižšie). Appka teda nie je
  // prakticky obmedzená na predpripravený zoznam krajín, iba naň
  // optimalizovaná pre najbežnejšie prípady (bod zadania).
  const [vignetteCountryIsCustom, setVignetteCountryIsCustom] =
    useState(false);

  const emptyService = {
    service_date: "",
    mileage: "",
    title: "",
    description: "",
    cost: "",
    technician: "",
    next_service_date: "",
  };

  const [service, setService] = useState(emptyService);
  const { legalHold } = useCompanyDpaLegalHold();
  const { locale, t } = useLocale();
  const linkedDocumentTypeLabels = getLinkedDocumentTypeLabels(t);
  const linkedAttachmentTypeLabels = getLinkedAttachmentTypeLabels(t);

  useEffect(() => {
    loadVehicle();
    loadServices();
    loadMembership();
    loadVignettes();
  }, []);

  async function loadMembership() {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    setUserId(session?.user?.id || "");

    const membership = await getMyActiveMembership();
    setRole(membership?.role ?? null);
    setCompanyId(membership?.company_id ?? "");

    if (membership?.company_id) {
      loadPhotos(membership.company_id);
      loadLinkedDocuments(membership.company_id);
    }
  }

  // Dokumenty priradené k tomuto vozidlu z AI Inboxu (PZP, technický
  // preukaz) — pozri komentár pri LINKED_DOCUMENT_TYPE_LABELS vyššie.
  // Číta výhradne existujúce public.documents/document_links/
  // document_attachments (žiadna nová tabuľka), RLS je rovnaká pre
  // owner/admin/employee (SELECT je pre všetky aktívne role firmy).
  async function loadLinkedDocuments(currentCompanyId: string = companyId) {
    if (!currentCompanyId) {
      setLinkedDocuments([]);
      return;
    }

    setLinkedDocumentsLoading(true);

    try {
      const { data, error } = await supabase
        .from("documents")
        .select(
          "id, document_type, extracted_fields, storage_bucket, storage_path, original_filename, created_at, document_links!inner(vehicle_id)"
        )
        .eq("company_id", currentCompanyId)
        .eq("document_links.vehicle_id", vehicleId)
        .in("document_type", ["insurance", "vehicle_registration"])
        .is("deleted_at", null)
        .order("created_at", { ascending: false });

      if (error || !data) {
        console.error("Chyba pri načítaní dokumentov vozidla:", error);
        setLinkedDocuments([]);
        return;
      }

      type LinkedDocumentRow = {
        id: string;
        document_type: string | null;
        extracted_fields: Record<string, unknown> | null;
        storage_bucket: string | null;
        storage_path: string | null;
        original_filename: string | null;
        created_at: string | null;
      };
      type LinkedAttachmentRow = {
        id: string;
        document_id: string;
        storage_bucket: string;
        storage_path: string;
        attachment_type: string;
      };

      const documentRows = data as unknown as LinkedDocumentRow[];
      const documentIds = documentRows.map((doc) => doc.id);

      const { data: attachmentsData, error: attachmentsError } =
        documentIds.length > 0
          ? await supabase
              .from("document_attachments")
              .select("id, document_id, storage_bucket, storage_path, attachment_type")
              .eq("company_id", currentCompanyId)
              .in("document_id", documentIds)
          : { data: [] as LinkedAttachmentRow[], error: null };

      if (attachmentsError) {
        console.error(
          "Chyba pri načítaní príloh dokumentov vozidla:",
          attachmentsError
        );
      }

      const enriched = await Promise.all(
        documentRows.map(async (doc) => {
          let signedUrl: string | null = null;

          if (doc.storage_bucket && doc.storage_path) {
            const { data: signed } = await supabase.storage
              .from(doc.storage_bucket)
              .createSignedUrl(doc.storage_path, 3600);
            signedUrl = signed?.signedUrl ?? null;
          }

          const docAttachments = ((attachmentsData as LinkedAttachmentRow[]) || []).filter(
            (a) => a.document_id === doc.id
          );

          const attachmentsWithUrls = await Promise.all(
            docAttachments.map(async (a) => {
              let attachmentUrl: string | null = null;

              if (a.storage_bucket && a.storage_path) {
                const { data: signed } = await supabase.storage
                  .from(a.storage_bucket)
                  .createSignedUrl(a.storage_path, 3600);
                attachmentUrl = signed?.signedUrl ?? null;
              }

              return {
                id: a.id,
                attachment_type: a.attachment_type,
                signedUrl: attachmentUrl,
              };
            })
          );

          return {
            id: doc.id,
            document_type: doc.document_type,
            extracted_fields: doc.extracted_fields,
            storage_bucket: doc.storage_bucket,
            storage_path: doc.storage_path,
            original_filename: doc.original_filename,
            created_at: doc.created_at,
            signedUrl,
            attachments: attachmentsWithUrls,
          } as LinkedVehicleDocument;
        })
      );

      setLinkedDocuments(enriched);
    } finally {
      setLinkedDocumentsLoading(false);
    }
  }

  // Vymazanie finalizovanej PZP (documents.document_type === "insurance")
  // priradenej k tomuto vozidlu — owner/admin. UI tlačidlo nižšie sa
  // renderuje iba pre isOwnerOrAdmin(role) a iba pre PZP (nie technický
  // preukaz — ten si zachováva iba existujúci náhľad, zámerne mimo scope).
  // Skutočné vynútenie prístupu je ale na DB strane (RLS
  // documents_delete_owner_admin/document_attachments_delete_owner_admin/
  // document_links_delete_owner_admin, 20260814160000) — toto tlačidlo je
  // iba pohodlie, nie bezpečnostná hranica. Poradie zámerne rovnaké ako
  // osvedčený vzor deleteOtherDocument() v app/ai-evidencia/page.tsx:
  // najprv Storage (hlavný súbor aj všetky prílohy — biela/zelená karta,
  // záznam o nehode), až potom DB riadok documents, aby nikdy nevznikol
  // osirotený súbor v Storage bez zodpovedajúceho DB záznamu (aj preto, že
  // Storage DELETE policy pre finalizovaný objekt vyžaduje, aby matching
  // documents riadok v čase mazania ešte existoval). document_links aj
  // document_attachments majú FK ON DELETE CASCADE, takže sa v DB odstránia
  // automaticky spolu s dokumentom — žiadny orphan link/attachment záznam.
  // storage_path je pre documents aj document_attachments UNIQUE (bucket,
  // path), takže tento konkrétny súbor nemôže byť zdieľaný s iným
  // dokumentom — bezpečné zmazať bez ďalšieho overovania referencií.
  async function deleteLinkedDocument(doc: LinkedVehicleDocument) {
    if (deletingDocumentId) return;

    if (!confirm(t("inbox.errors.confirmDeleteDocument"))) return;

    setDeletingDocumentId(doc.id);

    try {
      const membership = await getMyActiveMembership();

      if (!membership) {
        throw new Error(t("vehicles.errors.notLoggedInFormal"));
      }

      const { data: docAttachments, error: attachmentsError } = await supabase
        .from("document_attachments")
        .select("storage_bucket, storage_path")
        .eq("document_id", doc.id)
        .eq("company_id", membership.company_id);

      if (attachmentsError) {
        throw new Error(
          t("inbox.errors.documentAttachmentsLoadFailed", {
            message: attachmentsError.message,
          })
        );
      }

      const pathsByBucket = new Map<string, string[]>();
      const addPath = (bucket: string | null, path: string | null) => {
        if (!bucket || !path) return;
        const existing = pathsByBucket.get(bucket) ?? [];
        existing.push(path);
        pathsByBucket.set(bucket, existing);
      };

      addPath(doc.storage_bucket, doc.storage_path);
      (docAttachments || []).forEach((attachment) =>
        addPath(attachment.storage_bucket, attachment.storage_path)
      );

      for (const [bucket, paths] of pathsByBucket.entries()) {
        const { error: removeError } = await supabase.storage
          .from(bucket)
          .remove(paths);

        if (removeError) {
          throw new Error(
            t("inbox.errors.documentFilesDeleteFailed", {
              message: removeError.message,
            })
          );
        }
      }

      const { error: deleteError } = await supabase
        .from("documents")
        .delete()
        .eq("id", doc.id)
        .eq("company_id", membership.company_id);

      if (deleteError) throw deleteError;

      setLinkedDocuments((current) => current.filter((d) => d.id !== doc.id));
    } catch (deleteError: unknown) {
      alert(
        deleteError instanceof Error
          ? deleteError.message
          : t("inbox.errors.deleteDocumentFailed")
      );
    } finally {
      setDeletingDocumentId(null);
    }
  }

  async function loadPhotos(currentCompanyId: string = companyId) {
    if (!currentCompanyId) return;

    const { data, error } = await supabase
      .from("vehicle_photos")
      .select("*")
      .eq("vehicle_id", vehicleId)
      .eq("company_id", currentCompanyId)
      .order("created_at", { ascending: false });

    if (!error) setPhotos(data || []);
  }

  function photoUrl(path: string) {
    const { data } = supabase.storage.from("vehicle-photos").getPublicUrl(path);
    return data.publicUrl;
  }

  async function uploadVehiclePhotos(
    event: React.ChangeEvent<HTMLInputElement>
  ) {
    const files = Array.from(event.target.files || []);
    event.target.value = "";

    if (files.length === 0 || !userId) return;

    if (legalHold) {
      alert(t("common.legalHoldMessage"));
      return;
    }

    setIsUploadingPhotos(true);

    const uploadedPaths: string[] = [];
    let failedCount = 0;

    try {
      for (const originalFile of files) {
        try {
          const compressedFile = await compressVehiclePhoto(originalFile, t);
          const filePath = `${userId}/${vehicleId}/${Date.now()}-${crypto.randomUUID()}-${compressedFile.name}`;

          const { error: uploadError } = await supabase.storage
            .from("vehicle-photos")
            .upload(filePath, compressedFile, {
              cacheControl: "3600",
              upsert: false,
              contentType: compressedFile.type,
            });

          if (uploadError) throw uploadError;

          uploadedPaths.push(filePath);

          const { error: dbError } = await supabase
            .from("vehicle_photos")
            .insert({
              user_id: userId,
              vehicle_id: vehicleId,
              storage_path: filePath,
            });

          if (dbError) {
            await supabase.storage.from("vehicle-photos").remove([filePath]);
            throw dbError;
          }
        } catch (singleUploadError) {
          failedCount += 1;
          console.error(
            "Chyba pri nahrávaní fotografie vozidla:",
            singleUploadError
          );
        }
      }

      await loadPhotos();

      if (failedCount > 0) {
        alert(
          t("vehicles.errors.photosUploadFailedCount", {
            failedCount,
            total: files.length,
          })
        );
      }
    } finally {
      setIsUploadingPhotos(false);
    }
  }

  async function deletePhoto(photo: any) {
    if (deletingPhotoId) return;

    const photoId = String(photo?.id || "");
    if (!photoId) return;

    const confirmed = confirm(t("vehicles.gallery.confirmDeletePhoto"));
    if (!confirmed) return;

    setDeletingPhotoId(photoId);

    try {
      const membership = await getMyActiveMembership();

      if (!membership) {
        throw new Error(t("vehicles.errors.notLoggedInFormal"));
      }

      const { data: deletedPhotos, error: deleteError } = await supabase
        .from("vehicle_photos")
        .delete()
        .eq("id", photoId)
        .eq("vehicle_id", vehicleId)
        .eq("company_id", membership.company_id)
        .select("id, storage_path");

      if (deleteError) throw deleteError;

      if (deletedPhotos?.length !== 1) {
        throw new Error(t("vehicles.errors.photoDeleteDbMismatch"));
      }

      setPhotos((current) => current.filter((p) => String(p.id) !== photoId));
      setLightboxPhoto((current: any) =>
        current && String(current.id) === photoId ? null : current
      );

      const deletedPath = deletedPhotos[0].storage_path;

      if (deletedPath) {
        const { error: storageError } = await supabase.storage
          .from("vehicle-photos")
          .remove([deletedPath]);

        if (storageError) {
          console.error(
            "Databázový záznam fotografie bol vymazaný, ale Storage cleanup zlyhal:",
            storageError
          );
          alert(t("vehicles.errors.photoStorageDeleteFailed"));
        }
      }
    } catch (deleteError: unknown) {
      const message =
        deleteError instanceof Error
          ? deleteError.message
          : t("vehicles.errors.unknownError");
      alert(t("vehicles.errors.deletePhotoFailedPrefix", { message }));
    } finally {
      setDeletingPhotoId(null);
    }
  }

  async function loadVehicle() {
    const { data, error } = await supabase
      .from("vehicles")
      .select("*")
      .eq("id", vehicleId)
      .single();

    if (!error) setVehicle(data);
  }

  async function loadServices() {
    const { data, error } = await supabase
      .from("vehicle_services")
      .select("*")
      .eq("vehicle_id", vehicleId)
      .order("service_date", { ascending: false });

    if (!error) setServices(data || []);
  }

  async function loadVignettes() {
    setVignettesLoading(true);

    const { data, error } = await supabase
      .from("vehicle_vignettes")
      .select("*")
      .eq("vehicle_id", vehicleId)
      .order("valid_until", { ascending: true });

    if (!error) setVignettes(data || []);
    setVignettesLoading(false);
  }

  function updateVignetteField(key: string, value: string) {
    setVignette((prev) => ({ ...prev, [key]: value }));
  }

  function startAddVignette() {
    setEditingVignetteId(null);
    setVignette(emptyVignette);
    setVignetteCountryIsCustom(false);
    setShowVignetteForm(true);
  }

  // Select nastaví buď priamo krajinu zo zoznamu, alebo (pri
  // VIGNETTE_OTHER_COUNTRY_OPTION) prepne na voľný ISO alpha-2 vstup —
  // country_code sa v tom prípade vynuluje, kým používateľ kód nezadá sám.
  function handleVignetteCountrySelect(value: string) {
    if (value === VIGNETTE_OTHER_COUNTRY_OPTION) {
      setVignetteCountryIsCustom(true);
      updateVignetteField("country_code", "");
    } else {
      setVignetteCountryIsCustom(false);
      updateVignetteField("country_code", value);
    }
  }

  // Ručný ISO alpha-2 vstup — automaticky veľké písmená, iba A-Z, max 2
  // znaky (rovnaký formát ako DB CHECK vehicle_vignettes_country_code_format).
  function handleVignetteCustomCountryInput(value: string) {
    updateVignetteField(
      "country_code",
      value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2)
    );
  }

  function startEditVignette(item: VehicleVignette) {
    setEditingVignetteId(item.id);
    setVignette({
      country_code: item.country_code || "",
      valid_until: item.valid_until || "",
    });
    // Ak už uložená krajina nie je v predpripravenom zozname (napr. bola
    // pôvodne zadaná ako "Iná krajina"), formulár sa má rovno otvoriť v
    // custom režime — inak by select ticho spadol na prázdny placeholder.
    setVignetteCountryIsCustom(
      !VIGNETTE_COUNTRIES.some((c) => c.code === item.country_code)
    );
    setShowVignetteForm(true);
  }

  function cancelVignetteEdit() {
    setEditingVignetteId(null);
    setVignette(emptyVignette);
    setVignetteCountryIsCustom(false);
    setShowVignetteForm(false);
  }

  async function saveVignette() {
    if (!vignette.country_code || !vignette.valid_until) {
      alert(t("vehicles.vignettes.selectCountryPlaceholder"));
      return;
    }

    if (vignetteCountryIsCustom && !isValidVignetteCountryCode(vignette.country_code)) {
      alert(t("vehicles.vignettes.invalidCountryCode"));
      return;
    }

    // Rovnaká obranná legalHold kontrola ako pri servise vyššie — DB trigger
    // esblu_require_company_dpa_before_insert by INSERT (nie UPDATE) aj tak
    // odmietol, toto je iba včasná spätná väzba pre používateľa.
    if (!editingVignetteId && legalHold) {
      alert(t("common.legalHoldMessage"));
      return;
    }

    // Klientská poistka proti duplicite krajiny pri PRIDÁVANÍ novej známky
    // (DB unique(vehicle_id, country_code) je konečná autorita — toto iba
    // ušetrí zbytočný request s jasnejšou správou). Pri úprave existujúcej
    // známky (editingVignetteId) sa krajina zvyčajne nemení.
    if (
      !editingVignetteId &&
      vignettes.some((v) => v.country_code === vignette.country_code)
    ) {
      alert(t("vehicles.vignettes.duplicateCountry"));
      return;
    }

    setIsSavingVignette(true);

    const payload = {
      vehicle_id: vehicleId,
      country_code: vignette.country_code,
      valid_until: vignette.valid_until,
      updated_at: new Date().toISOString(),
    };

    const { error } = editingVignetteId
      ? await supabase
          .from("vehicle_vignettes")
          .update(payload)
          .eq("id", editingVignetteId)
      : await supabase.from("vehicle_vignettes").insert(payload);

    setIsSavingVignette(false);

    if (error) {
      alert(
        t("vehicles.errors.vignetteSaveFailedPrefix", { message: error.message })
      );
      return;
    }

    setVignette(emptyVignette);
    setEditingVignetteId(null);
    setVignetteCountryIsCustom(false);
    setShowVignetteForm(false);
    loadVignettes();
  }

  async function deleteVignette(vignetteId: string) {
    const confirmed = confirm(t("vehicles.vignettes.confirmDelete"));
    if (!confirmed) return;

    setDeletingVignetteId(vignetteId);

    const { error } = await supabase
      .from("vehicle_vignettes")
      .delete()
      .eq("id", vignetteId);

    setDeletingVignetteId(null);

    if (error) {
      alert(
        t("vehicles.errors.vignetteDeleteFailedPrefix", { message: error.message })
      );
      return;
    }

    loadVignettes();
  }

  function updateService(key: string, value: string) {
    setService((prev) => ({ ...prev, [key]: value }));
  }

  function startEditService(item: any) {
    setEditingServiceId(item.id);
    setShowForm(true);

    setService({
      service_date: item.service_date || "",
      mileage: item.mileage || "",
      title: item.title || "",
      description: item.description || "",
      cost: item.cost || "",
      technician: item.technician || "",
      next_service_date: item.next_service_date || "",
    });

    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function cancelServiceEdit() {
    setEditingServiceId(null);
    setService(emptyService);
    setShowForm(false);
  }

  async function saveService() {
    if (!service.service_date || !service.title) {
      alert(t("vehicles.services.validationRequired"));
      return;
    }

    // Obranná kontrola pred INSERTom — DB trigger na vehicle_services by
    // to aj tak odmietol (ESBLU_COMPANY_DPA_NOT_ACCEPTED), ale používateľ
    // nemá vyplniť celý formulár a až pri uložení naraziť na chybu.
    // Úpravu existujúceho servisu (editingServiceId nastavené) neblokuje.
    if (!editingServiceId && legalHold) {
      alert(t("common.legalHoldMessage"));
      return;
    }

    setIsSaving(true);

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      setIsSaving(false);
      alert(t("vehicles.errors.serviceSaveLoginRequired"));
      return;
    }

    const payload = {
      user_id: user.id,
      vehicle_id: vehicleId,
      service_date: service.service_date,
      mileage: service.mileage ? Number(service.mileage) : null,
      title: service.title,
      description: service.description || null,
      cost: service.cost ? Number(service.cost) : null,
      technician: service.technician || null,
      next_service_date: service.next_service_date || null,
    };

    const { error } = editingServiceId
      ? await supabase
          .from("vehicle_services")
          .update(payload)
          .eq("id", editingServiceId)
      : await supabase.from("vehicle_services").insert(payload);

    setIsSaving(false);

    if (error) {
      alert(t("vehicles.errors.serviceSaveFailedPrefix", { message: error.message }));
      return;
    }

    setService(emptyService);
    setEditingServiceId(null);
    setShowForm(false);
    loadServices();
  }

  async function deleteService(serviceId: string) {
    const confirmed = confirm(t("vehicles.services.confirmDelete"));
    if (!confirmed) return;

    const { error } = await supabase
      .from("vehicle_services")
      .delete()
      .eq("id", serviceId);

    if (error) {
      alert(t("vehicles.errors.serviceDeleteFailedPrefix", { message: error.message }));
      return;
    }

    loadServices();
  }

  if (!vehicle) {
    return <div className="p-10">{t("common.buttons.loading")}</div>;
  }

  return (
    <main className="app-shell-bg min-h-screen p-10">
      <BackLink href="/vozidla" label={t("nav.vehicles")} className="mb-4" />

      <h1 className="text-4xl font-bold">
        {vehicle.znacka} {vehicle.model}
      </h1>

      {/* Upozornenia na STK/EK/diaľničné známky pre TOTO KONKRÉTNE vozidlo
          (zadanie, bod 9B: "Detail vozidla/stroja — relevantné upozornenie
          pri konkrétnej entite"). Číta VÝHRADNE už načítané `vehicle` a
          `vignettes` (žiadny nový dopyt) cez ten istý zdieľaný
          lib/deadlines.ts, aký používa Dashboard aj Intent Engine — jedna
          definícia prahov/farieb na celú appku (bod 8 a 17 zadania).
          next_service_date sem zámerne NEPATRÍ (servisná sekcia nižšie má
          vlastný, podrobnejší zoznam) — iba časovo-kritické STK/EK/známky. */}
      {(() => {
        const activeDeadlines = buildVehicleDeadlines(
          [vehicle],
          vignettes,
          [],
          locale
        ).filter((item) => item.deadlineType !== "vehicle_service");

        if (activeDeadlines.length === 0) return null;

        return (
          <div className="mt-4 space-y-2">
            {activeDeadlines.map((item, index) => {
              const isOverdue = item.severity === "overdue";
              const label = deadlineTypeLabel(
                item.deadlineType,
                locale,
                item.vignetteCountryCode
              );

              return (
                <div
                  key={`${item.deadlineType}-${index}`}
                  className={`rounded-2xl border px-4 py-3 text-sm font-medium ${
                    isOverdue
                      ? "border-red-400/30 bg-red-400/10 text-red-400"
                      : "border-amber-400/30 bg-amber-400/10 text-amber-400"
                  }`}
                >
                  {isOverdue
                    ? t("dashboard.alertOverdue", {
                        type: label,
                        name: `${vehicle.znacka || ""} ${vehicle.model || ""}`.trim(),
                        spz: vehicle.spz || t("dashboard.noPlate"),
                      })
                    : t("dashboard.alertDueSoon", {
                        type: label,
                        name: `${vehicle.znacka || ""} ${vehicle.model || ""}`.trim(),
                        spz: vehicle.spz || t("dashboard.noPlate"),
                        days: item.daysRemaining,
                      })}
                </div>
              );
            })}
          </div>
        );
      })()}

      <div className="surface-card mt-8 p-8">
        <div className="grid grid-cols-2 gap-5">
          <p><b>{t("inbox.fields.spz")}:</b> {vehicle.spz}</p>
          <p><b>{t("inbox.fields.vin")}:</b> {vehicle.vin}</p>
          <p><b>{t("inbox.fields.rokVyroby")}:</b> {vehicle.rok_vyroby}</p>
          <p><b>{t("inbox.fields.palivo")}:</b> {vehicle.palivo}</p>
          <p><b>{t("inbox.fields.vykon")}:</b> {vehicle.vykon}</p>
          <p><b>{t("vehicles.fields.objem")}:</b> {vehicle.objem}</p>
          <p><b>{t("inbox.fields.farba")}:</b> {vehicle.farba}</p>
          <p><b>{t("vehicles.fields.hmotnost")}:</b> {vehicle.hmotnost}</p>
          <p><b>{t("inbox.fields.pocetMiest")}:</b> {vehicle.pocet_miest}</p>
          <p><b>{t("vehicles.fields.stk")}:</b> {vehicle.stk || t("common.misc.notFilled")}</p>
          <p><b>{t("vehicles.fields.ek")}:</b> {vehicle.ek || t("common.misc.notFilled")}</p>
        </div>
      </div>

      {/* Diaľničné známky (vehicle_vignettes) — v logickej blízkosti STK/EK
          vyššie, ako samostatná sekcia (1 vozidlo môže mať viac známok pre
          rôzne krajiny naraz). owner/admin vidia formulár a tlačidlá
          upraviť/odstrániť, employee iba zoznam. */}
      <div className="surface-card mt-10 p-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-2xl font-bold">{t("vehicles.vignettes.title")}</h2>
            <p className="mt-1 text-sm text-muted-esblu">
              {t("vehicles.vignettes.description")}
            </p>
          </div>

          {role !== "employee" && (
            <button
              onClick={() => {
                if (!editingVignetteId && legalHold) {
                  alert(t("common.legalHoldMessage"));
                  return;
                }
                if (showVignetteForm) {
                  cancelVignetteEdit();
                } else {
                  startAddVignette();
                }
              }}
              disabled={!editingVignetteId && legalHold && !showVignetteForm}
              className="shrink-0 rounded-xl bg-blue-600 px-5 py-3 text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-400"
            >
              {t("vehicles.vignettes.add")}
            </button>
          )}
        </div>

        {role !== "employee" && !editingVignetteId && legalHold && (
          <p className="mt-3 text-sm text-amber-400">
            {t("common.legalHoldMessage")}
          </p>
        )}

        {role !== "employee" && showVignetteForm && (
          <div className="mt-6 rounded-2xl border border-subtle bg-surface-2 p-6">
            <h3 className="mb-4 text-xl font-bold">
              {editingVignetteId
                ? t("vehicles.vignettes.editTitle")
                : t("vehicles.vignettes.addTitle")}
            </h3>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <label className="block">
                <span className="text-sm font-medium text-secondary">
                  {t("vehicles.vignettes.country")}
                </span>
                <select
                  className="mt-1 w-full rounded-xl border p-3"
                  value={
                    vignetteCountryIsCustom
                      ? VIGNETTE_OTHER_COUNTRY_OPTION
                      : vignette.country_code
                  }
                  onChange={(e) => handleVignetteCountrySelect(e.target.value)}
                >
                  <option value="">
                    {t("vehicles.vignettes.selectCountryPlaceholder")}
                  </option>
                  {VIGNETTE_COUNTRIES.map((c) => (
                    <option key={c.code} value={c.code}>
                      {vignetteCountryLabel(c.code, locale)}
                    </option>
                  ))}
                  <option value={VIGNETTE_OTHER_COUNTRY_OPTION}>
                    {t("vehicles.vignettes.otherCountry")}
                  </option>
                </select>

                {/* "Iná krajina" — voľný ISO alpha-2 vstup, aby appka nebola
                    prakticky obmedzená na VIGNETTE_COUNTRIES zoznam. */}
                {vignetteCountryIsCustom && (
                  <input
                    className="mt-2 w-full rounded-xl border p-3 uppercase"
                    maxLength={2}
                    placeholder={t(
                      "vehicles.vignettes.otherCountryCodePlaceholder"
                    )}
                    value={vignette.country_code}
                    onChange={(e) =>
                      handleVignetteCustomCountryInput(e.target.value)
                    }
                  />
                )}
              </label>

              <label className="block">
                <span className="text-sm font-medium text-secondary">
                  {t("vehicles.vignettes.validUntil")}
                </span>
                <input
                  type="date"
                  className="mt-1 w-full rounded-xl border p-3"
                  value={vignette.valid_until}
                  onChange={(e) =>
                    updateVignetteField("valid_until", e.target.value)
                  }
                />
              </label>
            </div>

            <div className="mt-4 flex gap-3">
              <button
                onClick={saveVignette}
                disabled={isSavingVignette}
                className="rounded-xl bg-green-600 px-5 py-3 text-white hover:bg-green-700 disabled:bg-gray-400"
              >
                {isSavingVignette
                  ? t("common.buttons.saving")
                  : editingVignetteId
                  ? t("vehicles.vignettes.saveChanges")
                  : t("vehicles.vignettes.save")}
              </button>

              <button
                onClick={cancelVignetteEdit}
                className="rounded-xl bg-surface-2 px-5 py-3 text-primary hover:bg-surface-hover"
              >
                {t("vehicles.vignettes.cancelEdit")}
              </button>
            </div>
          </div>
        )}

        {vignettesLoading ? (
          <p className="mt-6 text-muted-esblu">{t("common.buttons.loading")}</p>
        ) : vignettes.length === 0 ? (
          <p className="mt-6 text-muted-esblu">
            {t("vehicles.vignettes.noneYet")}
          </p>
        ) : (
          <ul className="mt-6 space-y-3">
            {vignettes.map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-subtle bg-surface-2 p-4"
              >
                <p className="font-medium text-primary">
                  {t("vehicles.vignettes.validUntilLine", {
                    country: vignetteCountryLabel(item.country_code, locale),
                    date: formatDate(item.valid_until, locale),
                  })}
                </p>

                {role !== "employee" && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => startEditVignette(item)}
                      className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-bold text-white hover:bg-blue-700"
                    >
                      {t("vehicles.vignettes.edit")}
                    </button>
                    <button
                      onClick={() => deleteVignette(item.id)}
                      disabled={deletingVignetteId !== null}
                      className="rounded-lg bg-red-600 px-3 py-2 text-xs font-bold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-gray-400"
                    >
                      {deletingVignetteId === String(item.id)
                        ? t("inbox.deleting")
                        : t("vehicles.vignettes.remove")}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="surface-card mt-10 p-8">
        <h2 className="text-2xl font-bold">{t("vehicles.detail.documentsTitle")}</h2>
        <p className="mt-1 text-sm text-muted-esblu">
          {t("vehicles.detail.documentsDescription")}
        </p>

        {linkedDocumentsLoading ? (
          <p className="mt-6 text-muted-esblu">{t("vehicles.detail.loadingDocuments")}</p>
        ) : linkedDocuments.length === 0 ? (
          <p className="mt-6 text-muted-esblu">
            {t("vehicles.detail.noDocumentsYet")}
          </p>
        ) : (
          <div className="mt-6 space-y-4">
            {linkedDocuments.map((doc) => (
              <div
                key={doc.id}
                className="rounded-2xl border border-subtle bg-surface-2 p-6"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-bold text-primary">
                      {linkedDocumentTypeLabels[doc.document_type || ""] ||
                        t("vehicles.detail.documentFallback")}
                    </h3>

                    {doc.document_type === "insurance" && (
                      <p className="mt-1 text-sm text-muted-esblu">
                        {describeInsuranceSummary(doc.extracted_fields, t) ||
                          t("vehicles.detail.noFurtherDetails")}
                      </p>
                    )}

                    {doc.created_at && (
                      <p className="mt-1 text-xs text-muted-esblu">
                        {t("vehicles.detail.uploadedOn", {
                          date: formatDate(doc.created_at, locale),
                        })}
                      </p>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    {doc.signedUrl && (
                      <button
                        type="button"
                        onClick={() => {
                          const url = doc.signedUrl;
                          if (url) openExternalUrl(url);
                        }}
                        className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-700"
                      >
                        {t("inbox.open")}
                      </button>
                    )}

                    {/* Zmazať — iba PZP (nie technický preukaz, mimo scope)
                        a iba owner/admin. Employee tlačidlo vôbec nevidí
                        (nie iba disabled) — rovnaký vzor ako pri fotkách
                        vozidla a diaľničných známkach vyššie v tomto
                        súbore. Skutočné vynútenie je DB-side RLS, toto je
                        iba UI pohodlie. */}
                    {doc.document_type === "insurance" &&
                      isOwnerOrAdmin(role) && (
                        <button
                          type="button"
                          onClick={() => deleteLinkedDocument(doc)}
                          disabled={deletingDocumentId !== null}
                          className="rounded-xl bg-red-600 px-4 py-2 text-sm font-bold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-gray-400"
                        >
                          {deletingDocumentId === doc.id
                            ? t("inbox.deleting")
                            : t("vehicles.buttons.deleteWithIcon")}
                        </button>
                      )}
                  </div>
                </div>

                {doc.attachments.length > 0 && (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {doc.attachments.map((attachment) => {
                      const attachmentUrl = attachment.signedUrl;
                      if (!attachmentUrl) return null;

                      return (
                        <button
                          key={attachment.id}
                          type="button"
                          onClick={() => openExternalUrl(attachmentUrl)}
                          className="rounded-lg border border-subtle bg-surface-1 px-3 py-2 text-xs font-semibold text-secondary hover:bg-surface-hover"
                        >
                          {linkedAttachmentTypeLabels[
                            attachment.attachment_type
                          ] || t("vehicles.detail.attachmentFallback")}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="surface-card mt-10 p-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-2xl font-bold">{t("vehicles.gallery.title")}</h2>

          {/* Pridávanie fotografií smie aj employee (rovnaké oprávnenie ako
              SELECT/INSERT na vehicle_photos) — vymazanie fotografie ostáva
              iba owner/admin nižšie. Toto sa netýka samotného vozidla
              (vehicles) — employee ho naďalej nemôže editovať ani mazať. */}
          <div className="flex gap-3">
            <label className="cursor-pointer rounded-xl bg-blue-600 px-5 py-3 text-white hover:bg-blue-700">
              {isUploadingPhotos ? t("inbox.uploading") : t("vehicles.gallery.takeOrUploadPhotos")}
              <input
                type="file"
                accept="image/*"
                capture="environment"
                multiple
                className="hidden"
                onChange={uploadVehiclePhotos}
                disabled={isUploadingPhotos || legalHold}
              />
            </label>

            <label className="cursor-pointer rounded-xl border border-subtle bg-surface-1 px-5 py-3 text-secondary">
              {t("vehicles.gallery.addPhotos")}
              <input
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={uploadVehiclePhotos}
                disabled={isUploadingPhotos || legalHold}
              />
            </label>
          </div>
        </div>

        {legalHold && (
          <p className="mt-3 text-sm text-amber-400">{t("common.legalHoldMessage")}</p>
        )}

        {photos.length === 0 ? (
          <p className="mt-6 text-muted-esblu">
            {t("vehicles.gallery.noneYet")}
          </p>
        ) : (
          <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {photos.map((photo) => (
              <div
                key={photo.id}
                className="rounded-xl border border-subtle bg-surface-2 p-2"
              >
                <button
                  type="button"
                  onClick={() => setLightboxPhoto(photo)}
                  className="block w-full"
                >
                  <img
                    src={photoUrl(photo.storage_path)}
                    alt={t("vehicles.gallery.photoAlt")}
                    className="h-32 w-full rounded-lg object-cover sm:h-36"
                  />
                </button>

                {isOwnerOrAdmin(role) && (
                  <button
                    onClick={() => deletePhoto(photo)}
                    disabled={deletingPhotoId !== null}
                    className="mt-2 w-full rounded-lg bg-red-600 px-3 py-2 text-xs font-bold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-gray-400"
                  >
                    {deletingPhotoId === String(photo.id)
                      ? t("inbox.deleting")
                      : t("vehicles.buttons.deleteWithIcon")}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* "Pridať servis" — presunuté úplne na spodok detailu vozidla
          (posledná sekcia pred lightbox modálom), presne podľa zadania.
          Žiadna zmena servisnej logiky/dát/formulára/validácie/oprávnení —
          iba UI poradie. */}
      <div className="surface-card mt-10 mb-10 p-8">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold">{t("vehicles.services.title")}</h2>

          <button
            onClick={() => {
              if (!editingServiceId && legalHold) {
                alert(t("common.legalHoldMessage"));
                return;
              }
              setShowForm(!showForm);
              setEditingServiceId(null);
              setService(emptyService);
            }}
            disabled={!editingServiceId && legalHold && !showForm}
            className="rounded-xl bg-blue-600 px-5 py-3 text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-400"
          >
            {t("vehicles.services.addService")}
          </button>
        </div>

        {!editingServiceId && legalHold && (
          <p className="mt-3 text-sm text-amber-400">
            {t("common.legalHoldMessage")}
          </p>
        )}

        {showForm && (
          <div className="mt-6 rounded-2xl border border-subtle bg-surface-2 p-6">
            <h3 className="mb-4 text-xl font-bold">
              {editingServiceId
                ? t("vehicles.services.editServiceTitle")
                : t("vehicles.services.addServiceTitle")}
            </h3>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <input
                type="date"
                className="rounded-xl border p-3"
                value={service.service_date}
                onChange={(e) => updateService("service_date", e.target.value)}
              />

              <input
                type="number"
                placeholder={t("vehicles.services.mileage")}
                className="rounded-xl border p-3"
                value={service.mileage}
                onChange={(e) => updateService("mileage", e.target.value)}
              />

              <input
                placeholder={t("vehicles.services.titlePlaceholder")}
                className="rounded-xl border p-3"
                value={service.title}
                onChange={(e) => updateService("title", e.target.value)}
              />

              <input
                type="number"
                placeholder={t("vehicles.services.costPlaceholder")}
                className="rounded-xl border p-3"
                value={service.cost}
                onChange={(e) => updateService("cost", e.target.value)}
              />

              <input
                placeholder={t("vehicles.services.technician")}
                className="rounded-xl border p-3"
                value={service.technician}
                onChange={(e) => updateService("technician", e.target.value)}
              />

              <input
                type="date"
                className="rounded-xl border p-3"
                value={service.next_service_date}
                onChange={(e) =>
                  updateService("next_service_date", e.target.value)
                }
              />
            </div>

            <textarea
              placeholder={t("vehicles.services.descriptionPlaceholder")}
              className="mt-4 w-full rounded-xl border p-3"
              value={service.description}
              onChange={(e) => updateService("description", e.target.value)}
            />

            <div className="mt-4 flex gap-3">
              <button
                onClick={saveService}
                disabled={isSaving}
                className="rounded-xl bg-green-600 px-5 py-3 text-white hover:bg-green-700 disabled:bg-gray-400"
              >
                {isSaving
                  ? t("common.buttons.saving")
                  : editingServiceId
                  ? t("vehicles.forms.saveChanges")
                  : t("vehicles.services.saveService")}
              </button>

              {editingServiceId && (
                <button
                  onClick={cancelServiceEdit}
                  className="rounded-xl bg-surface-2 px-5 py-3 text-primary hover:bg-surface-hover"
                >
                  {t("vehicles.forms.cancelEdit")}
                </button>
              )}
            </div>
          </div>
        )}

        {services.length === 0 ? (
          <p className="mt-6 text-muted-esblu">
            {t("vehicles.services.noneYet")}
          </p>
        ) : (
          <div className="mt-6 space-y-4">
            {services.map((item) => (
              <div
                key={item.id}
                className="rounded-2xl border border-subtle bg-surface-2 p-6 shadow-sm"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="text-2xl font-bold text-primary">
                      🔧 {item.title}
                    </h3>

                    <p className="mt-1 text-sm text-muted-esblu">
                      📅 {item.service_date}
                    </p>
                  </div>

                  <div className="badge-success rounded-xl px-4 py-2 text-lg font-bold">
                    {item.cost ? `${item.cost} €` : t("vehicles.services.costNotProvided")}
                  </div>
                </div>

                <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-3">
                  <div className="rounded-xl bg-surface-1 p-4">
                    <p className="text-sm text-muted-esblu">{t("vehicles.services.mileage")}</p>
                    <p className="text-lg font-bold">
                      {item.mileage ? `${item.mileage} km` : "—"}
                    </p>
                  </div>

                  <div className="rounded-xl bg-surface-1 p-4">
                    <p className="text-sm text-muted-esblu">{t("vehicles.services.technician")}</p>
                    <p className="text-lg font-bold">
                      {item.technician || "—"}
                    </p>
                  </div>

                  <div className="rounded-xl bg-surface-1 p-4">
                    <p className="text-sm text-muted-esblu">{t("inbox.fields.nextServiceDate")}</p>
                    <p className="text-lg font-bold">
                      {item.next_service_date || "—"}
                    </p>
                  </div>
                </div>

                {item.description && (
                  <p className="mt-5 rounded-xl bg-surface-1 p-4 text-secondary">
                    {item.description}
                  </p>
                )}

                <div className="mt-5 flex gap-3">
                  <button
                    onClick={() => startEditService(item)}
                    className="rounded-xl bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
                  >
                    {t("vehicles.services.editButton")}
                  </button>

                  {role !== "employee" && (
                    <button
                      onClick={() => deleteService(item.id)}
                      className="rounded-xl bg-red-600 px-4 py-2 text-white hover:bg-red-700"
                    >
                      {t("vehicles.buttons.deleteWithIcon")}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {lightboxPhoto && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setLightboxPhoto(null)}
        >
          <div className="relative max-h-[90vh] max-w-4xl">
            <img
              src={photoUrl(lightboxPhoto.storage_path)}
              alt={t("vehicles.gallery.photoLightboxAlt")}
              className="max-h-[90vh] max-w-full rounded-2xl object-contain"
              onClick={(e) => e.stopPropagation()}
            />
            <button
              type="button"
              onClick={() => setLightboxPhoto(null)}
              className="absolute -top-4 -right-4 rounded-full bg-surface-1 px-3 py-2 text-lg font-bold text-primary shadow-lg"
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
