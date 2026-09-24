"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { openExternalUrl } from "@/lib/file-actions";
import BackLink from "@/app/components/BackLink";
import {
  PageShell,
  PageHeader,
  SectionPanel,
  MetricGrid,
  Metric,
  MetadataGrid,
  Notice,
  EmptyState,
  Modal,
  PhotoGrid,
  PlateBadge,
  StatusBadge,
  TimelineItem,
  UploadActions,
  docButtonPrimary,
  docButtonSecondary,
  docButtonDanger,
} from "@/app/components/ui/Primitives";
import { CarIcon, WrenchIcon } from "@/app/components/icons/AppIcons";
import { inspectionState } from "@/lib/vehicles";
import {
  getMyActiveMembership,
  canOperate,
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

type VehicleTab = "overview" | "vignettes" | "documents" | "service" | "photos";
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
// Otvorenie KONKRÉTNEHO priradeného dokumentu (PZP/TP) cez
// ?openDocument=<documents.id> — Intent Engine "ukáž dokumenty vozidla..."
// výsledok (lib/vehicle-documents.ts) pre dokument, ktorého "domovom" je
// TÁTO stránka (archived_from_inbox_at je nastavené, pozri komentár tam).
// Automatizuje presne to isté "Otvoriť" tlačidlo, ktoré appka už dnes
// stavia pre KAŽDÝ linkedDocuments riadok (signedUrl + openExternalUrl
// nižšie) — žiadny nový viewer. Next.js vyžaduje, aby useSearchParams() bol
// obalený v <Suspense> (rovnaký, už zavedený vzor ako
// mobile/app/vozidla/detail/page.tsx) — vyčlenené do malej samostatnej
// komponenty, nech Suspense fallback neblokuje vykreslenie celej stránky.
// -----------------------------------------------------------------------------
function OpenLinkedDocumentFromQueryParam({
  onOpenDocument,
}: {
  onOpenDocument: (id: string) => void;
}) {
  const searchParams = useSearchParams();

  useEffect(() => {
    const openDocument = searchParams.get("openDocument");
    if (openDocument) onOpenDocument(openDocument);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  return null;
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
  const [tab, setTab] = useState<VehicleTab>("overview");
  const [lightboxPhoto, setLightboxPhoto] = useState<any>(null);
  const [linkedDocuments, setLinkedDocuments] = useState<
    LinkedVehicleDocument[]
  >([]);
  const [linkedDocumentsLoading, setLinkedDocumentsLoading] = useState(false);
  const [deletingDocumentId, setDeletingDocumentId] = useState<string | null>(
    null
  );
  // ?openDocument=<id> (pozri OpenLinkedDocumentFromQueryParam vyššie) —
  // čaká na to, kým linkedDocuments dotiahne dáta VRÁTANE signedUrl, potom
  // automaticky spustí presne to isté otvorenie, aké robí "Otvoriť"
  // tlačidlo nižšie. Ak sa zhoda nenájde alebo dokument nemá signedUrl
  // (chýbajúci storage súbor), appka bezpečne nič neurobí.
  const [pendingOpenDocumentId, setPendingOpenDocumentId] = useState<string | null>(
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

  // ?openDocument=<id> — akonáhle linkedDocuments dotiahne dáta (vrátane
  // signedUrl, pozri loadLinkedDocuments nižšie), otvorí zodpovedajúci
  // dokument presne tak, ako by to urobil ručný klik na "Otvoriť".
  useEffect(() => {
    if (!pendingOpenDocumentId) return;
    const match = linkedDocuments.find((doc) => doc.id === pendingOpenDocumentId);
    if (!match) return;

    // setState/openExternalUrl je zámerne v setTimeout callbacku, nie
    // synchrónne v tele efektu — react-hooks/set-state-in-effect.
    if (match.signedUrl) {
      const signedUrl = match.signedUrl;
      const timer = setTimeout(() => {
        openExternalUrl(signedUrl);
        setPendingOpenDocumentId(null);
      }, 0);
      return () => clearTimeout(timer);
    }

    if (!linkedDocumentsLoading) {
      // Zhoda existuje, ale nemá signedUrl (chýbajúci storage súbor) a
      // načítanie už skončilo — nemá zmysel ďalej čakať.
      const timer = setTimeout(() => setPendingOpenDocumentId(null), 0);
      return () => clearTimeout(timer);
    }
  }, [pendingOpenDocumentId, linkedDocuments, linkedDocumentsLoading]);

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
    return (
      <PageShell moduleContext="vehicles" uiContext={{ module: "vehicle", entityType: "vehicle", entityId }}>
        <p className="py-10 text-sm text-secondary">{t("common.buttons.loading")}</p>
      </PageShell>
    );
  }

  // Termíny STK/EK/známok pre TOTO vozidlo. Prahy aj texty prichádzajú z
  // lib/deadlines.ts — rovnaký zdroj, aký používa Dashboard aj Intent
  // Engine, aby si jeden termín nikde neprotirečil. next_service_date sem
  // zámerne nepatrí, tá má vlastnú záložku.
  const activeDeadlines = buildVehicleDeadlines([vehicle], vignettes, [], locale).filter(
    (item) => item.deadlineType !== "vehicle_service"
  );

  const stkState = inspectionState(vehicle.stk);
  const ekState = inspectionState(vehicle.ek);

  const TABS: { key: VehicleTab; label: string; count?: number }[] = [
    { key: "overview", label: t("machines.detail.tabOverview") },
    { key: "vignettes", label: t("vehicles.vignettes.title"), count: vignettes.length },
    {
      key: "documents",
      label: t("vehicles.detail.documentsTitle"),
      count: linkedDocuments.length,
    },
    { key: "service", label: t("vehicles.services.title"), count: services.length },
    { key: "photos", label: t("vehicles.gallery.title"), count: photos.length },
  ];

  const coverPhoto = photos[0] ? photoUrl(photos[0].storage_path) : null;

  function inspectionMetricTone(state: { severity: string | null; ok: boolean }) {
    if (state.severity === "overdue") return "critical" as const;
    if (state.severity) return "warning" as const;
    return "neutral" as const;
  }

  return (
    <PageShell moduleContext="vehicles" uiContext={{ module: "vehicle", entityType: "vehicle", entityId }}>
      <Suspense fallback={null}>
        <OpenLinkedDocumentFromQueryParam onOpenDocument={setPendingOpenDocumentId} />
      </Suspense>
      <BackLink href="/vozidla" label={t("nav.vehicles")} className="mb-6" />

      <PageHeader
        eyebrow={
          <span className="inline-flex items-center gap-2">
            <CarIcon size={18} />
            {vehicle.palivo || t("nav.vehicles")}
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
                <CarIcon size={22} />
              </span>
            )}
            <span className="min-w-0 break-words">
              {[vehicle.znacka, vehicle.model].filter(Boolean).join(" ") ||
                vehicle.spz ||
                t("dashboard.noName")}
            </span>
          </span>
        }
        badges={
          <>
            <PlateBadge plate={vehicle.spz || t("dashboard.noPlate")} size="sm" />
            {stkState.severity === "overdue" && (
              <StatusBadge kind="overdue" label={t("vehicles.fields.stk")} />
            )}
            {ekState.severity === "overdue" && (
              <StatusBadge kind="overdue" label={t("vehicles.fields.ek")} />
            )}
          </>
        }
        meta={
          vehicle.vin ? (
            // VIN je 17 znakov bez medzier — neproporcionálne písmo a
            // zalomenie kdekoľvek, aby na úzkom telefóne nevytlačil stránku do šírky.
            <span className="inline-flex max-w-full flex-wrap items-baseline gap-x-2">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-esblu">
                {t("inbox.fields.vin")}
              </span>
              <span className="break-all font-mono text-[15px] tracking-wide text-primary sm:text-sm">
                {vehicle.vin}
              </span>
            </span>
          ) : undefined
        }
      />

      <div className="mt-6">
        <MetricGrid>
          <Metric
            label={t("vehicles.fields.stk")}
            value={vehicle.stk ? formatDate(vehicle.stk, locale) : t("common.misc.notFilled")}
            tone={inspectionMetricTone(stkState)}
          />
          <Metric
            label={t("vehicles.fields.ek")}
            value={vehicle.ek ? formatDate(vehicle.ek, locale) : t("common.misc.notFilled")}
            tone={inspectionMetricTone(ekState)}
          />
          <Metric
            label={t("inbox.fields.vykon")}
            value={vehicle.vykon ? `${vehicle.vykon} kW` : "—"}
          />
          <Metric
            label={t("inbox.fields.rokVyroby")}
            value={vehicle.rok_vyroby ? String(vehicle.rok_vyroby) : "—"}
          />
        </MetricGrid>
      </div>

      {activeDeadlines.length > 0 && (
        <div className="mt-4 space-y-2">
          {activeDeadlines.map((item, index) => {
            const isOverdue = item.severity === "overdue";
            const label = deadlineTypeLabel(item.deadlineType, locale, item.vignetteCountryCode);
            return (
              <Notice
                key={`${item.deadlineType}-${index}`}
                tone={isOverdue ? "critical" : "warning"}
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
              </Notice>
            );
          })}
        </div>
      )}

      <div
        role="tablist"
        aria-label={t("vehicles.detail.sectionsLabel")}
        className="mt-6 -mx-1 flex snap-x gap-1 overflow-x-auto px-1 pb-1 [scrollbar-width:thin]"
      >
        {TABS.map((item) => (
          <button
            key={item.key}
            role="tab"
            type="button"
            aria-selected={tab === item.key}
            onClick={() => setTab(item.key)}
            className={`min-h-11 shrink-0 snap-start whitespace-nowrap rounded-doc-sm border px-3.5 py-2 text-sm font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${
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

      {tab === "overview" && (
        <div className="mt-4">
          <SectionPanel title={t("machines.detail.tabOverview")}>
            <MetadataGrid
              items={[
                { label: t("inbox.fields.spz"), value: vehicle.spz },
                { label: t("inbox.fields.vin"), value: vehicle.vin },
                { label: t("inbox.fields.znacka"), value: vehicle.znacka },
                { label: t("inbox.fields.model"), value: vehicle.model },
                { label: t("inbox.fields.rokVyroby"), value: vehicle.rok_vyroby },
                {
                  label: t("inbox.fields.datumPrvejEvidencie"),
                  value: vehicle.datum_prvej_evidencie
                    ? formatDate(vehicle.datum_prvej_evidencie, locale)
                    : null,
                },
                { label: t("inbox.fields.palivo"), value: vehicle.palivo },
                { label: t("vehicles.fields.objem"), value: vehicle.objem },
                { label: t("inbox.fields.vykon"), value: vehicle.vykon },
                { label: t("inbox.fields.farba"), value: vehicle.farba },
                { label: t("vehicles.fields.hmotnost"), value: vehicle.hmotnost },
                { label: t("inbox.fields.pocetMiest"), value: vehicle.pocet_miest },
              ]}
            />
          </SectionPanel>
        </div>
      )}

      {/* Diaľničné známky (vehicle_vignettes) — 1 vozidlo môže mať viac
          známok pre rôzne krajiny naraz. owner/admin vidia formulár a
          tlačidlá upraviť/odstrániť, employee iba zoznam. */}
      {tab === "vignettes" && (
      <div className="mt-4 rounded-doc border border-doc-border bg-doc-surface p-4 sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-base font-semibold text-primary">{t("vehicles.vignettes.title")}</h2>
            <p className="mt-1 text-sm text-muted-esblu">
              {t("vehicles.vignettes.description")}
            </p>
          </div>

          {canOperate(role) && (
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
              className={`shrink-0 ${docButtonSecondary}`}
            >
              {t("vehicles.vignettes.add")}
            </button>
          )}
        </div>

        {canOperate(role) && !editingVignetteId && legalHold && (
          <div className="mt-3"><Notice tone="warning">{t("common.legalHoldMessage")}</Notice></div>
        )}

        {canOperate(role) && showVignetteForm && (
          <div className="mt-4 rounded-doc border border-doc-border bg-surface-2 p-4">
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
                className={docButtonPrimary}
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
          <p className="mt-4 text-sm text-muted-esblu">{t("common.buttons.loading")}</p>
        ) : vignettes.length === 0 ? (
          <p className="mt-4 text-sm text-muted-esblu">
            {t("vehicles.vignettes.noneYet")}
          </p>
        ) : (
          <ul className="mt-6 space-y-3">
            {vignettes.map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-doc border border-doc-border bg-surface-2 p-3"
              >
                <p className="font-medium text-primary">
                  {t("vehicles.vignettes.validUntilLine", {
                    country: vignetteCountryLabel(item.country_code, locale),
                    date: formatDate(item.valid_until, locale),
                  })}
                </p>

                {canOperate(role) && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => startEditVignette(item)}
                      className={`${docButtonSecondary} px-2.5 text-sm sm:text-xs`}
                    >
                      {t("vehicles.vignettes.edit")}
                    </button>
                    <button
                      onClick={() => deleteVignette(item.id)}
                      disabled={deletingVignetteId !== null}
                      className={`${docButtonDanger} px-2.5 text-sm sm:text-xs`}
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
      )}

      {tab === "documents" && (
      <div className="mt-4 rounded-doc border border-doc-border bg-doc-surface p-4 sm:p-5">
        <h2 className="text-base font-semibold text-primary">{t("vehicles.detail.documentsTitle")}</h2>
        <p className="mt-1 text-sm text-muted-esblu">
          {t("vehicles.detail.documentsDescription")}
        </p>

        {linkedDocumentsLoading ? (
          <p className="mt-4 text-sm text-muted-esblu">{t("vehicles.detail.loadingDocuments")}</p>
        ) : linkedDocuments.length === 0 ? (
          <p className="mt-4 text-sm text-muted-esblu">
            {t("vehicles.detail.noDocumentsYet")}
          </p>
        ) : (
          <div className="mt-6 space-y-4">
            {linkedDocuments.map((doc) => (
              <div
                key={doc.id}
                className="rounded-doc border border-doc-border bg-surface-2 p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-primary">
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
                      <p className="mt-1 text-sm text-muted-esblu sm:text-xs">
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
                        className={`${docButtonSecondary} px-2.5 text-sm sm:text-xs`}
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
                          className={`${docButtonDanger} px-2.5 text-sm sm:text-xs`}
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
                          className="min-h-11 rounded-lg border border-subtle bg-surface-1 px-3 py-2 text-sm font-semibold text-secondary hover:bg-surface-hover sm:min-h-0 sm:text-xs"
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
      )}

      {tab === "photos" && (
      <div className="mt-4 rounded-doc border border-doc-border bg-doc-surface p-4 sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-base font-semibold text-primary">{t("vehicles.gallery.title")}</h2>

          {/* Pridávanie fotografií smie aj employee (rovnaké oprávnenie ako
              SELECT/INSERT na vehicle_photos) — vymazanie fotografie ostáva
              iba owner/admin nižšie. Toto sa netýka samotného vozidla
              (vehicles) — employee ho naďalej nemôže editovať ani mazať. */}
          <UploadActions
            className="shrink-0"
            multiple
            cameraLabel={t("inbox.registration.takePhoto")}
            galleryLabel={t("vehicles.gallery.addPhotos")}
            disabled={isUploadingPhotos || legalHold}
            onSelect={uploadVehiclePhotos}
          />
        </div>

        {legalHold && (
          <div className="mt-3"><Notice tone="warning">{t("common.legalHoldMessage")}</Notice></div>
        )}

        {isUploadingPhotos && (
          <p className="mt-3 text-sm text-secondary">{t("inbox.uploading")}</p>
        )}

        {photos.length === 0 ? (
          <div className="mt-4">
            <EmptyState title={t("vehicles.gallery.noneYet")} />
          </div>
        ) : (
          <div className="mt-4">
            <PhotoGrid
              photos={photos.map((photo) => ({
                id: String(photo.id),
                url: photoUrl(photo.storage_path),
                alt: t("vehicles.gallery.photoAlt"),
              }))}
              onOpen={(tile) => {
                const found = photos.find((photo) => String(photo.id) === tile.id);
                if (found) setLightboxPhoto(found);
              }}
              /* Mazanie fotky ostáva owner/admin — rovnaké pravidlo ako
                 predtým aj ako v RLS na vehicle_photos. */
              onDelete={
                isOwnerOrAdmin(role)
                  ? (tile) => {
                      const found = photos.find((photo) => String(photo.id) === tile.id);
                      if (found) deletePhoto(found);
                    }
                  : undefined
              }
              deleteLabel={t("vehicles.buttons.deleteWithIcon")}
              deletingId={deletingPhotoId}
            />
          </div>
        )}
      </div>

      )}

      {tab === "service" && (
      <div className="mt-4 rounded-doc border border-doc-border bg-doc-surface p-4 sm:p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-primary">{t("vehicles.services.title")}</h2>

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
            className={docButtonSecondary}
          >
            {t("vehicles.services.addService")}
          </button>
        </div>

        {!editingServiceId && legalHold && (
          <div className="mt-3"><Notice tone="warning">{t("common.legalHoldMessage")}</Notice></div>
        )}

        {showForm && (
          <div className="mt-4 rounded-doc border border-doc-border bg-surface-2 p-4">
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
                className={docButtonPrimary}
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
          <div className="mt-4">
            <EmptyState title={t("vehicles.services.noneYet")} />
          </div>
        ) : (
          /* Časová os namiesto kariet — servisná história sa číta
             chronologicky. Rovnaký tvar ako na detaile stroja, aby servis
             vozidla a servis stroja nevyzerali ako dve rôzne appky. */
          <ol className="mt-4">
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
                    {item.mileage ? (
                      <span className="text-muted-esblu">
                        {t("vehicles.services.mileage")}:{" "}
                        <span className="tabular-nums">{item.mileage} km</span>
                      </span>
                    ) : null}
                    {item.technician && (
                      <span className="text-muted-esblu">{item.technician}</span>
                    )}
                    <span className="font-medium tabular-nums text-primary">
                      {item.cost ? `${item.cost} €` : t("vehicles.services.costNotProvided")}
                    </span>
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
                      aria-label={`${t("vehicles.services.editButton")}: ${item.title}`}
                      className={`${docButtonSecondary} px-2.5 text-sm sm:text-xs`}
                    >
                      {t("vehicles.services.editButton")}
                    </button>
                    {canOperate(role) && (
                      <button
                        type="button"
                        onClick={() => deleteService(item.id)}
                        aria-label={`${t("vehicles.buttons.deleteWithIcon")}: ${item.title}`}
                        className={`${docButtonDanger} px-2.5 text-sm sm:text-xs`}
                      >
                        {t("vehicles.buttons.deleteWithIcon")}
                      </button>
                    )}
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
      </div>
      )}

      {lightboxPhoto && (
        <Modal
          title={t("vehicles.gallery.photoLightboxAlt")}
          onClose={() => setLightboxPhoto(null)}
          closeLabel={t("common.buttons.close")}
          size="xl"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={photoUrl(lightboxPhoto.storage_path)}
            alt={t("vehicles.gallery.photoLightboxAlt")}
            className="max-h-[70vh] w-full rounded-doc object-contain"
          />
        </Modal>
      )}
    </PageShell>
  );
}
