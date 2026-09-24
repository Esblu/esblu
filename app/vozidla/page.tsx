"use client";

import { useRef, useState, useEffect } from "react";
import { supabase } from "@/lib/supabase";
import PlanLimitNotice from "@/app/components/PlanLimitNotice";
import { usePlanUsage } from "@/hooks/use-plan-usage";
import { isPlanLimitReachedError } from "@/lib/plan-limits";
import { normalizeSpz } from "@/lib/normalize-spz";
import { formatDate } from "@/lib/i18n/format";
import { vehicleDetailHref } from "@/lib/entity-links";
import {
  inspectionState,
  matchesVehicleQuery,
  vehicleAttention,
  vehicleFuels,
  vehicleTitle,
  type VehicleRow,
} from "@/lib/vehicles";
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
  UploadActions,
  PlateBadge,
  docButtonPrimary,
  docButtonSecondary,
  docButtonDanger,
  docField,
  docLabel,
} from "@/app/components/ui/Primitives";
import { CarIcon, PlusIcon, ScanIcon } from "@/app/components/icons/AppIcons";

/** Jedna šablóna stĺpcov pre hlavičku aj riadky fleet registra. */
const VEHICLE_COLUMNS =
  "sm:grid-cols-[minmax(0,2.4fr)_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1.3fr)]";

type InspectionFilter = "all" | "attention" | "missing";
import BackLink from "../components/BackLink";
import {
  getMyActiveMembership,
  canOperate,
  isOwnerOrAdmin,
  type CompanyMemberRole,
} from "@/lib/company";
import { useCompanyDpaLegalHold } from "@/app/components/CompanyDpaGate";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { apiUrl } from "@/lib/api-url";
import { REQUEST_LOCALE_HEADER } from "@/lib/i18n/request-locale";
import { compressImage } from "@/lib/image-compress";
import {
  VIGNETTE_COUNTRIES,
  VIGNETTE_OTHER_COUNTRY_OPTION,
  isValidVignetteCountryCode,
  vignetteCountryLabel,
  type DraftVehicleVignette,
} from "@/lib/vehicle-vignettes";

// Diaľničné známky v TP review formulári — zoznam krajín, typ a lokalizovaný
// label sú zdieľané z lib/vehicle-vignettes.ts (rovnaký zdroj pravdy ako
// sekcia "Diaľničné známky" v detaile vozidla), nie duplikované natvrdo.
type RegistrationVignetteRow = DraftVehicleVignette & {
  // UI-only pole (neposiela sa na server) — riadi, či select zobrazuje
  // krajinu zo zoznamu, alebo voľný ISO alpha-2 vstup ("Iná krajina").
  countryMode: "list" | "custom";
};

// Vozidlo nájdené podľa VIN/ŠPZ pri spracovaní technického preukazu —
// presunuté z pôvodného Inbox (ai-evidencia) TP flow bezo zmeny správania
// (bod 2 zadania "UX reorganizácia Inbox + Vozidlá + Chat").
async function findDuplicateVehicle(
  companyId: string,
  vin: unknown,
  spz: unknown
): Promise<any | null> {
  const normalizedSpz = normalizeSpz(spz);
  const trimmedVin =
    typeof vin === "string" && vin.trim() ? vin.trim().toUpperCase() : "";

  if (!normalizedSpz && !trimmedVin) return null;

  const { data, error } = await supabase
    .from("vehicles")
    .select("*")
    .eq("company_id", companyId);

  if (error || !data) {
    console.error("Chyba pri hľadaní duplicitného vozidla:", error);
    return null;
  }

  const vinMatch = trimmedVin
    ? data.find(
        (vehicle) =>
          typeof vehicle.vin === "string" &&
          vehicle.vin.trim().toUpperCase() === trimmedVin
      )
    : undefined;

  if (vinMatch) return vinMatch;

  if (!normalizedSpz) return null;

  return (
    data.find((vehicle) => normalizeSpz(vehicle.spz) === normalizedSpz) ??
    null
  );
}

async function compressVehiclePhoto(
  file: File,
  t: (key: string, vars?: Record<string, string | number>) => string
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

    const baseName =
      file.name.replace(/\.[^/.]+$/, "") ||
      t("vehicles.gallery.defaultPhotoFileName");

    return new File([blob], `${baseName}.webp`, {
      type: "image/webp",
      lastModified: Date.now(),
    });
  } finally {
    URL.revokeObjectURL(imageUrl);
  }
}

export default function VozidlaPage() {
  const { t, tCount, locale } = useLocale();
  const [userId, setUserId] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [role, setRole] = useState<CompanyMemberRole | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [vehicle, setVehicle] = useState<any | null>(null);
  const [vehicles, setVehicles] = useState<VehicleRow[]>([]);
  const [photosByVehicle, setPhotosByVehicle] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [search, setSearch] = useState("");
  const [fuelFilter, setFuelFilter] = useState("all");
  const [inspectionFilter, setInspectionFilter] = useState<InspectionFilter>("all");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [photoTargetVehicleId, setPhotoTargetVehicleId] = useState("");
  const [isUploadingVehiclePhotos, setIsUploadingVehiclePhotos] =
    useState(false);
  const [photoUploadFeedback, setPhotoUploadFeedback] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const saveInProgressRef = useRef(false);
  const {
    usage: planUsage,
    limit: planLimit,
    isLimited: isPlanLimited,
    loading: planUsageLoading,
    refresh: refreshPlanUsage,
  } = usePlanUsage("vehicles");
  const { legalHold } = useCompanyDpaLegalHold();
  // Legal-hold blokuje IBA vytváranie NOVÝCH vozidiel (rovnako ako
  // plan-limit vyššie) — presne to, čo by aj tak odmietol DB trigger
  // esblu_require_company_dpa_before_insert na tabuľke vehicles
  // (20260816090000_add_company_dpa_acceptance.sql). Úprava/mazanie
  // existujúceho vozidla (editingId nastavené) ostáva nedotknutá.
  const isNewVehicleBlocked =
    !editingId && (planUsageLoading || isPlanLimited || legalHold);

  // ---------------------------------------------------------------------
  // Technický preukaz vozidla (TP) — presunuté z Inbox (app/ai-evidencia/
  // page.tsx) do Vozidlá (bod 2 zadania "UX reorganizácia Inbox + Vozidlá +
  // Chat"): predná + voliteľná zadná strana sa spracujú AI ako JEDEN
  // dokument cez /api/scan-vehicle-registration (nie generický
  // /api/scan-document — ten TP typ dokumentu ani nepovoľuje). Vozidlo sa
  // vytvorí/aktualizuje AŽ po výslovnom potvrdení používateľom — rovnaká AI
  // Evidence zásada ako predtým v Inbox. Stav, handlery aj JSX sú presunuté
  // bezo zmeny správania.
  // ---------------------------------------------------------------------
  const [showRegistrationFlow, setShowRegistrationFlow] = useState(false);
  const [regFrontFile, setRegFrontFile] = useState<File | null>(null);
  const [regFrontPreview, setRegFrontPreview] = useState<string | null>(null);
  const [regBackFile, setRegBackFile] = useState<File | null>(null);
  const [regBackPreview, setRegBackPreview] = useState<string | null>(null);
  const [isPreparingRegFront, setIsPreparingRegFront] = useState(false);
  const [isPreparingRegBack, setIsPreparingRegBack] = useState(false);
  const [isProcessingRegistration, setIsProcessingRegistration] =
    useState(false);
  const [isSavingRegistration, setIsSavingRegistration] = useState(false);
  const [registrationError, setRegistrationError] = useState("");
  const [registrationFields, setRegistrationFields] = useState<Record<
    string,
    string
  > | null>(null);
  // Vozidlo nájdené podľa VIN/ŠPZ pri spracovaní technického preukazu —
  // ak je nastavené, uloženie AKTUALIZUJE toto vozidlo namiesto vytvorenia
  // duplicity.
  const [registrationDuplicateVehicle, setRegistrationDuplicateVehicle] =
    useState<any | null>(null);
  // Diaľničné známky zadané RUČNE v review formulári (AI ich z technického
  // preukazu neextrahuje, štandardne ho ani neobsahuje). Každý riadok je
  // nezávislý {country_code, valid_until} — voliteľné, predvolene prázdny
  // zoznam, pridávaný tlačidlom "+ Pridať ďalšiu známku". Uložené sú AŽ v
  // saveRegistrationDocument(), rovnakým vehicle_vignettes upsertom
  // (vehicle_id, country_code) ako v detaile vozidla — žiadny paralelný
  // dátový model.
  const [registrationVignettes, setRegistrationVignettes] = useState<
    RegistrationVignetteRow[]
  >([]);
  const saveRegistrationInProgressRef = useRef(false);

  useEffect(() => {
    checkUser();
  }, []);

  useEffect(() => {
    return () => {
      if (regFrontPreview) URL.revokeObjectURL(regFrontPreview);
    };
  }, [regFrontPreview]);

  useEffect(() => {
    return () => {
      if (regBackPreview) URL.revokeObjectURL(regBackPreview);
    };
  }, [regBackPreview]);

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
      setRole(null);
      setVehicles([]);
      return;
    }

    setCompanyId(membership.company_id);
    setRole(membership.role);
    loadVehicles(membership.company_id);
  }

  async function loadVehicles(currentCompanyId: string = companyId) {
    if (!currentCompanyId) return;

    setLoading(true);
    setLoadError("");

    const { data, error } = await supabase
      .from("vehicles")
      .select("*")
      .eq("company_id", currentCompanyId)
      .order("znacka", { ascending: true });

    if (error) {
      setLoadError(t("vehicles.errors.loadVehiclesFailed", { message: error.message }));
      setLoading(false);
      return;
    }

    const rows = (data as VehicleRow[]) || [];
    setVehicles(rows);

    // Miniatúra do registra. Jeden dotaz pre všetky vozidlá naraz —
    // fotka je len vizuálna pomôcka, nesmie stáť N dotazov.
    const ids = rows.map((row) => row.id);
    if (ids.length > 0) {
      const { data: photos } = await supabase
        .from("vehicle_photos")
        .select("vehicle_id, storage_path, created_at")
        .in("vehicle_id", ids)
        .eq("company_id", currentCompanyId)
        .order("created_at", { ascending: false });

      const map: Record<string, string> = {};
      for (const photo of (photos as { vehicle_id: string; storage_path: string }[]) || []) {
        if (!map[photo.vehicle_id]) {
          map[photo.vehicle_id] = supabase.storage
            .from("vehicle-photos")
            .getPublicUrl(photo.storage_path).data.publicUrl;
        }
      }
      setPhotosByVehicle(map);
    } else {
      setPhotosByVehicle({});
    }

    setLoading(false);
  }

  function clearRegistrationResult() {
    setRegistrationError("");
    setRegistrationFields(null);
    setRegistrationDuplicateVehicle(null);
    setRegistrationVignettes([]);
  }

  function clearRegistrationImages() {
    setRegFrontFile(null);
    setRegFrontPreview(null);
    setRegBackFile(null);
    setRegBackPreview(null);
    clearRegistrationResult();
  }

  async function handleRegistrationFileChange(
    side: "front" | "back",
    event: React.ChangeEvent<HTMLInputElement>
  ) {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) return;

    const setPreparing =
      side === "front" ? setIsPreparingRegFront : setIsPreparingRegBack;
    setPreparing(true);
    clearRegistrationResult();

    try {
      const compressedFile = await compressImage(file, 0, t);
      const previewUrl = URL.createObjectURL(compressedFile);

      if (side === "front") {
        setRegFrontFile(compressedFile);
        setRegFrontPreview(previewUrl);
      } else {
        setRegBackFile(compressedFile);
        setRegBackPreview(previewUrl);
      }
    } catch (fileError) {
      setRegistrationError(
        fileError instanceof Error
          ? fileError.message
          : t("inbox.errors.photoProcessFailed")
      );
    } finally {
      setPreparing(false);
    }
  }

  function removeRegistrationImage(side: "front" | "back") {
    if (side === "front") {
      setRegFrontFile(null);
      setRegFrontPreview(null);
    } else {
      setRegBackFile(null);
      setRegBackPreview(null);
    }

    clearRegistrationResult();
  }

  function updateRegistrationField(key: string, value: string) {
    setRegistrationFields((prev) => ({ ...(prev || {}), [key]: value }));
  }

  function addRegistrationVignetteRow() {
    setRegistrationVignettes((prev) => [
      ...prev,
      { country_code: "", valid_until: "", countryMode: "list" },
    ]);
  }

  function updateRegistrationVignetteRow(
    index: number,
    key: "country_code" | "valid_until",
    value: string
  ) {
    setRegistrationVignettes((prev) =>
      prev.map((row, i) => (i === index ? { ...row, [key]: value } : row))
    );
  }

  // Select nastaví buď priamo krajinu zo zoznamu, alebo (pri
  // VIGNETTE_OTHER_COUNTRY_OPTION) prepne daný riadok na voľný ISO alpha-2
  // vstup — rovnaký vzor ako v sekcii "Diaľničné známky" v detaile vozidla.
  function handleRegistrationVignetteCountrySelect(
    index: number,
    value: string
  ) {
    setRegistrationVignettes((prev) =>
      prev.map((row, i) =>
        i === index
          ? value === VIGNETTE_OTHER_COUNTRY_OPTION
            ? { ...row, country_code: "", countryMode: "custom" }
            : { ...row, country_code: value, countryMode: "list" }
          : row
      )
    );
  }

  function handleRegistrationVignetteCustomCountryInput(
    index: number,
    value: string
  ) {
    updateRegistrationVignetteRow(
      index,
      "country_code",
      value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2)
    );
  }

  function removeRegistrationVignetteRow(index: number) {
    setRegistrationVignettes((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleProcessRegistration() {
    if (!regFrontFile) {
      setRegistrationError(t("inbox.errors.addFrontFirst"));
      return;
    }

    if (legalHold) {
      setRegistrationError(t("common.legalHoldMessage"));
      return;
    }

    setIsProcessingRegistration(true);
    setRegistrationError("");

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        throw new Error(t("inbox.errors.aiLoginRequired"));
      }

      const membership = await getMyActiveMembership();

      if (!membership) {
        throw new Error(t("inbox.errors.notLoggedIn"));
      }

      const formData = new FormData();
      formData.append("front", regFrontFile);

      if (regBackFile) {
        formData.append("back", regBackFile);
      }

      const response = await fetch(apiUrl("/api/scan-vehicle-registration"), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          [REQUEST_LOCALE_HEADER]: locale,
        },
        body: formData,
      });
      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || t("inbox.errors.registrationAiFailed"));
      }

      const extracted = data.data as Record<string, string | null>;
      const normalizedSpz = normalizeSpz(extracted.spz);
      const normalizedFields: Record<string, string> = {};

      Object.entries(extracted).forEach(([key, value]) => {
        normalizedFields[key] = value ?? "";
      });
      normalizedFields.spz = normalizedSpz || "";

      setRegistrationFields(normalizedFields);

      const duplicate = await findDuplicateVehicle(
        companyId,
        extracted.vin,
        normalizedSpz
      );
      setRegistrationDuplicateVehicle(duplicate);
    } catch (processingError: unknown) {
      setRegistrationError(
        processingError instanceof Error
          ? processingError.message
          : t("inbox.errors.registrationAiFailedGeneric")
      );
    } finally {
      setIsProcessingRegistration(false);
    }
  }

  function registrationVehiclePayload(userIdForPayload: string) {
    const f = registrationFields || {};

    return {
      user_id: userIdForPayload,
      spz: normalizeSpz(f.spz),
      vin: f.vin || null,
      znacka: f.znacka || null,
      model: f.model || null,
      rok_vyroby: f.rokVyroby ? Number(f.rokVyroby) : null,
      palivo: f.palivo || null,
      objem: f.objemMotora ? Number(f.objemMotora) : null,
      vykon: f.vykon || null,
      farba: f.farba || null,
      hmotnost: f.prevadzkovaHmotnost
        ? Number(String(f.prevadzkovaHmotnost).replace(" kg", ""))
        : null,
      pocet_miest: f.pocetMiest ? Number(f.pocetMiest) : null,
      datum_prvej_evidencie: f.datumPrvejEvidencie || null,
    };
  }

  async function saveRegistrationDocument() {
    if (!registrationFields || saveRegistrationInProgressRef.current) return;

    if (legalHold) {
      setRegistrationError(t("common.legalHoldMessage"));
      return;
    }

    // Riadok s vyplnenou iba jednou z dvoch hodnôt (krajina bez dátumu
    // alebo naopak) by inak ticho zmizol pri uložení — radšej používateľa
    // upozorniť, než mlčky zahodiť polovicu jeho vstupu. Úplne prázdny
    // riadok (obe hodnoty prázdne) je v poriadku, iba sa neskôr preskočí.
    const hasIncompleteVignetteRow = registrationVignettes.some(
      (row) => Boolean(row.country_code) !== Boolean(row.valid_until)
    );

    if (hasIncompleteVignetteRow) {
      setRegistrationError(t("inbox.errors.vignetteRowIncomplete"));
      return;
    }

    // Riadok v custom režime ("Iná krajina") s vyplneným, ale neplatným
    // ISO alpha-2 kódom — rovnaká kontrola ako v detaile vozidla,
    // server-side CHECK ostáva konečná autorita.
    const hasInvalidVignetteCountryCode = registrationVignettes.some(
      (row) =>
        row.countryMode === "custom" &&
        row.country_code &&
        !isValidVignetteCountryCode(row.country_code)
    );

    if (hasInvalidVignetteCountryCode) {
      setRegistrationError(t("vehicles.vignettes.invalidCountryCode"));
      return;
    }

    const isNewVehicle = !registrationDuplicateVehicle;

    if (isNewVehicle) {
      const latestVehicleUsage = await refreshPlanUsage();

      if (latestVehicleUsage?.isLimited) {
        setRegistrationError(t("common.planLimitMessage"));
        return;
      }
    }

    saveRegistrationInProgressRef.current = true;
    setIsSavingRegistration(true);
    setRegistrationError("");

    let uploadedFrontPath: string | null = null;
    let uploadedBackPath: string | null = null;
    let documentInserted = false;
    let vehicleWritten = false;
    let documentId: string | null = null;

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        throw new Error(t("inbox.errors.notLoggedIn"));
      }

      const membership = await getMyActiveMembership();

      if (!membership) {
        throw new Error(t("inbox.errors.notLoggedIn"));
      }

      documentId = crypto.randomUUID();

      const frontUniqueName = `${Date.now()}-${crypto.randomUUID()}.webp`;
      const frontPath = `${session.user.id}/${documentId}/${frontUniqueName}`;

      const { error: frontUploadError } = await supabase.storage
        .from("ai-inbox-documents")
        .upload(frontPath, regFrontFile as File, {
          contentType: (regFrontFile as File).type || "image/webp",
          cacheControl: "3600",
          upsert: false,
        });

      if (frontUploadError) {
        throw new Error(
          t("inbox.errors.frontSaveFailed", { message: frontUploadError.message })
        );
      }

      uploadedFrontPath = frontPath;

      let backPath: string | null = null;

      if (regBackFile) {
        const backUniqueName = `${Date.now()}-${crypto.randomUUID()}.webp`;
        backPath = `${session.user.id}/${documentId}/${backUniqueName}`;

        const { error: backUploadError } = await supabase.storage
          .from("ai-inbox-documents")
          .upload(backPath, regBackFile, {
            contentType: regBackFile.type || "image/webp",
            cacheControl: "3600",
            upsert: false,
          });

        if (backUploadError) {
          throw new Error(
            t("inbox.errors.backSaveFailed", { message: backUploadError.message })
          );
        }

        uploadedBackPath = backPath;
      }

      // Vozidlo — AŽ TERAZ, po výslovnom potvrdení používateľom. Ak bolo
      // nájdené existujúce vozidlo (VIN/ŠPZ), aktualizujeme ho namiesto
      // vytvorenia duplicity; inak vzniká nové vozidlo.
      let vehicleId: string;

      if (registrationDuplicateVehicle) {
        const { data: updated, error: updateError } = await supabase
          .from("vehicles")
          .update(registrationVehiclePayload(session.user.id))
          .eq("id", registrationDuplicateVehicle.id)
          .eq("company_id", membership.company_id)
          .select("id")
          .single();

        if (updateError) throw updateError;

        vehicleId = updated.id;
      } else {
        const { data: inserted, error: insertVehicleError } = await supabase
          .from("vehicles")
          .insert(registrationVehiclePayload(session.user.id))
          .select("id")
          .single();

        if (insertVehicleError) throw insertVehicleError;

        vehicleId = inserted.id;
      }

      vehicleWritten = true;

      const { error: docInsertError } = await supabase
        .from("documents")
        .insert({
          id: documentId,
          user_id: session.user.id,
          storage_bucket: "ai-inbox-documents",
          storage_path: frontPath,
          original_filename: regFrontFile?.name || null,
          mime_type: regFrontFile?.type || null,
          file_size: regFrontFile?.size ?? null,
          document_type: "vehicle_registration",
          status: "confirmed",
          ai_raw_output: {
            documentType: "vehicle_registration",
            fields: registrationFields,
          },
          extracted_fields: registrationFields,
          field_confidence: [],
          note: null,
        });

      if (docInsertError) throw docInsertError;

      documentInserted = true;

      if (backPath) {
        const { error: attachmentError } = await supabase
          .from("document_attachments")
          .insert({
            user_id: session.user.id,
            document_id: documentId,
            storage_bucket: "ai-inbox-documents",
            storage_path: backPath,
            original_filename: regBackFile?.name || null,
            mime_type: regBackFile?.type || null,
            file_size: regBackFile?.size ?? null,
            attachment_type: "vehicle_registration_back",
          });

        if (attachmentError) {
          console.error(
            "Zadnú stranu sa nepodarilo priradiť k dokumentu:",
            attachmentError
          );
        }
      }

      // esblu_finalize_vehicle_document() — rovnaké atomické RPC ako pri PZP
      // v Inbox: upsertne primary document_links riadok A ZÁROVEŇ nastaví
      // documents.archived_from_inbox_at, takže TP po úspešnom uložení
      // vozidla už NIE JE súčasťou Inbox listingu — jeden canonical
      // documents riadok, teraz dostupný z detailu vozidla. Vozidlo aj
      // samotný dokument sú v tomto bode už bezpečne uložené (vehicleWritten
      // && documentInserted) — zlyhanie tohto volania preto NIKDY nestratí
      // vozidlo ani dokument, iba TP dočasne ostane viditeľné aj v Inboxe
      // (bezpečný, opraviteľný stav, nie strata dát).
      const { error: finalizeError } = await supabase.rpc(
        "esblu_finalize_vehicle_document",
        {
          p_document_id: documentId,
          p_vehicle_id: vehicleId,
        }
      );

      if (finalizeError) {
        console.error(
          "Priradenie technického preukazu k vozidlu sa nepodarilo dokončiť:",
          finalizeError
        );
      }

      const { error: logError } = await supabase
        .from("document_review_log")
        .insert({
          document_id: documentId,
          document_ref: documentId,
          user_id: session.user.id,
          action: "created",
        });

      if (logError) {
        console.error(
          "Záznam do document_review_log sa nepodarilo uložiť:",
          logError
        );
      }

      // Diaľničné známky zadané v review formulári — ukladajú sa AŽ TERAZ,
      // keď je vehicleId isté a vozidlo aj dokument sú už bezpečne uložené.
      // Upsert na (vehicle_id, country_code) — pri obnove existujúcej
      // krajiny sa iba aktualizuje valid_until, presne rovnaký model ako
      // pri ručnom pridávaní/úprave známky v detaile vozidla (žiadny
      // paralelný dátový model). AI tento údaj neextrahuje —
      // registrationVignettes obsahuje výhradne ručne zadané riadky.
      // Neúplné riadky boli odmietnuté vyššie ešte pred uploadom; úplne
      // prázdny zoznam flow jednoducho nijako neovplyvní (voliteľné pole).
      const vignetteRowsToSave = registrationVignettes.filter(
        (row) => row.country_code && row.valid_until
      );

      let vignetteSaveFailed = false;

      if (vignetteRowsToSave.length > 0) {
        const { error: vignetteError } = await supabase
          .from("vehicle_vignettes")
          .upsert(
            vignetteRowsToSave.map((row) => ({
              vehicle_id: vehicleId,
              country_code: row.country_code,
              valid_until: row.valid_until,
              updated_at: new Date().toISOString(),
            })),
            { onConflict: "vehicle_id,country_code" }
          );

        if (vignetteError) {
          vignetteSaveFailed = true;
          console.error(
            "Diaľničné známky sa nepodarilo uložiť k vozidlu:",
            vignetteError
          );
        }
      }

      const wasUpdate = Boolean(registrationDuplicateVehicle);

      clearRegistrationImages();
      setShowRegistrationFlow(false);
      await Promise.all([loadVehicles(), refreshPlanUsage()]);

      const successMessage = wasUpdate
        ? t("inbox.errors.vehicleUpdatedWithRegistration")
        : t("inbox.errors.vehicleCreatedWithRegistration");

      alert(
        vignetteSaveFailed
          ? `${successMessage} ${t("inbox.errors.vignetteSaveFailedAfterVehicle")}`
          : successMessage
      );
    } catch (saveError: unknown) {
      if (uploadedFrontPath && !documentInserted) {
        const pathsToRemove = uploadedBackPath
          ? [uploadedFrontPath, uploadedBackPath]
          : [uploadedFrontPath];

        const { error: cleanupError } = await supabase.storage
          .from("ai-inbox-documents")
          .remove(pathsToRemove);

        if (cleanupError) {
          console.error(
            "Uloženie zlyhalo a osirotené fotografie sa nepodarilo odstrániť:",
            cleanupError
          );
        }
      }

      const message =
        saveError instanceof Error ? saveError.message : t("inbox.errors.saveFailed");

      if (isPlanLimitReachedError(saveError, "vehicles")) {
        setRegistrationError(t("common.planLimitMessage"));
        await refreshPlanUsage();
      } else if (vehicleWritten && !documentInserted) {
        // Vozidlo sa už uložilo, ale fotografie technického preukazu sa
        // nepodarilo priradiť — nehlásiť tichý úspech, jasne to označiť a
        // nechať používateľa dokument nahrať znova (vozidlo v module
        // Vozidlá pritom zostáva bezpečne použiteľné).
        setRegistrationError(
          t("inbox.errors.vehicleSavedButPhotosFailed", { message })
        );
        await Promise.all([loadVehicles(), refreshPlanUsage()]);
      } else {
        setRegistrationError(message);
      }
    } finally {
      saveRegistrationInProgressRef.current = false;
      setIsSavingRegistration(false);
    }
  }

  async function uploadVehiclePhotosFromList(
    event: React.ChangeEvent<HTMLInputElement>
  ) {
    const files = Array.from(event.target.files || []);
    event.target.value = "";

    if (files.length === 0) return;

    if (!photoTargetVehicleId) {
      setPhotoUploadFeedback({
        type: "error",
        text: t("vehicles.gallery.selectVehicleFirst"),
      });
      return;
    }

    if (!userId) {
      setPhotoUploadFeedback({
        type: "error",
        text: t("inbox.errors.notLoggedIn"),
      });
      return;
    }

    if (legalHold) {
      setPhotoUploadFeedback({ type: "error", text: t("common.legalHoldMessage") });
      return;
    }

    setIsUploadingVehiclePhotos(true);
    setPhotoUploadFeedback(null);

    let failedCount = 0;

    try {
      for (const originalFile of files) {
        try {
          const compressedFile = await compressVehiclePhoto(originalFile, t);
          const filePath = `${userId}/${photoTargetVehicleId}/${Date.now()}-${crypto.randomUUID()}-${compressedFile.name}`;

          const { error: uploadError } = await supabase.storage
            .from("vehicle-photos")
            .upload(filePath, compressedFile, {
              cacheControl: "3600",
              upsert: false,
              contentType: compressedFile.type,
            });

          if (uploadError) throw uploadError;

          const { error: dbError } = await supabase
            .from("vehicle_photos")
            .insert({
              user_id: userId,
              vehicle_id: photoTargetVehicleId,
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

      const successCount = files.length - failedCount;

      if (failedCount === 0) {
        setPhotoUploadFeedback({
          type: "success",
          text: tCount("vehicles.gallery.photosSavedCount", successCount),
        });
      } else {
        setPhotoUploadFeedback({
          type: "error",
          text: t("vehicles.errors.photosUploadFailedCount", {
            failedCount,
            total: files.length,
          }),
        });
      }
    } finally {
      setIsUploadingVehiclePhotos(false);
    }
  }

  function updateVehicle(key: string, value: string) {
    setVehicle((prev: any) => ({
      ...prev,
      [key]: value,
    }));
  }

  function vehiclePayload() {
    return {
      user_id: userId,
      spz: normalizeSpz(vehicle.spz),
      vin: vehicle.vin || null,
      znacka: vehicle.znacka || null,
      model: vehicle.model || null,
      rok_vyroby: vehicle.rokVyroby ? Number(vehicle.rokVyroby) : null,
      palivo: vehicle.palivo || null,
      objem: vehicle.objemMotora ? Number(vehicle.objemMotora) : null,
      vykon: vehicle.vykon || null,
      farba: vehicle.farba || null,
      hmotnost: vehicle.hmotnost
        ? Number(String(vehicle.hmotnost).replace(" kg", ""))
        : null,
      pocet_miest: vehicle.pocetMiest ? Number(vehicle.pocetMiest) : null,
      datum_prvej_evidencie: vehicle.datumPrvejEvidencie || null,
      stk: vehicle.stk || null,
      ek: vehicle.ek || null,
    };
  }

  async function handleSaveVehicle() {
    if (!vehicle || saveInProgressRef.current) return;

    if (!userId) {
      alert(t("inbox.errors.notLoggedIn"));
      return;
    }

    // Obranná kontrola pred samotným INSERTom (nad rámec toho, že tlačidlo
    // je pri legalHold už disabled) — používateľ nemá vyplniť celý
    // formulár a až pri uložení naraziť na ESBLU_COMPANY_DPA_NOT_ACCEPTED
    // z DB triggera. Netýka sa editácie existujúceho vozidla.
    if (!editingId && legalHold) {
      alert(t("common.legalHoldMessage"));
      return;
    }

    saveInProgressRef.current = true;
    setIsSaving(true);

    try {
      if (editingId) {
        const { error } = await supabase
          .from("vehicles")
          .update(vehiclePayload())
          .eq("id", editingId)
          .eq("company_id", companyId);

        if (error) throw error;

        alert(t("vehicles.messages.vehicleUpdated"));
        setEditingId(null);
        setVehicle(null);
        await loadVehicles();
        return;
      }

      const latestUsage = await refreshPlanUsage();

      if (latestUsage?.isLimited) {
        alert(t("common.planLimitMessage"));
        return;
      }

      const { error } = await supabase.from("vehicles").insert(vehiclePayload());

      if (error) throw error;

      alert(t("vehicles.messages.vehicleSaved"));
      setVehicle(null);
      await Promise.all([loadVehicles(), refreshPlanUsage()]);
    } catch (saveError: unknown) {
      if (isPlanLimitReachedError(saveError, "vehicles")) {
        alert(t("common.planLimitMessage"));
        await refreshPlanUsage();
      } else {
        const message =
          saveError instanceof Error
            ? saveError.message
            : t("vehicles.errors.unknownError");
        alert(
          editingId
            ? t("vehicles.errors.vehicleUpdateFailedPrefix", { message })
            : t("vehicles.errors.vehicleSaveFailedPrefix", { message })
        );
      }
    } finally {
      saveInProgressRef.current = false;
      setIsSaving(false);
    }
  }

  function handleEdit(car: any) {
    setEditingId(car.id);

    setVehicle({
      spz: car.spz || "",
      vin: car.vin || "",
      znacka: car.znacka || "",
      model: car.model || "",
      rokVyroby: car.rok_vyroby || "",
      palivo: car.palivo || "",
      objemMotora: car.objem || "",
      vykon: car.vykon || "",
      farba: car.farba || "",
      hmotnost: car.hmotnost || "",
      pocetMiest: car.pocet_miest || "",
      datumPrvejEvidencie: car.datum_prvej_evidencie || "",
      stk: car.stk || "",
      ek: car.ek || "",
    });

    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function handleDeleteVehicle(id: string) {
    const confirmed = confirm(t("vehicles.list.confirmDeleteVehicle"));
    if (!confirmed) return;

    // Cesty fotografií vozidla načítame PRED zmazaním vozidla — DB riadky
    // vehicle_photos sa zmažú automaticky (FK ON DELETE CASCADE), ale
    // súbory v Storage treba odstrániť samostatne, aby po vozidle
    // nezostali osirotené fotografie v bucket-e vehicle-photos.
    const { data: photosToClean } = await supabase
      .from("vehicle_photos")
      .select("storage_path")
      .eq("vehicle_id", id)
      .eq("company_id", companyId);

    // PZP/technický preukaz priradené k tomuto vozidlu (document_links,
    // pozri esblu_finalize_vehicle_document a
    // 20260820090000_add_documents_vehicle_archive.sql) načítame PRED
    // zmazaním vozidla z rovnakého dôvodu ako fotografie vyššie —
    // document_links.vehicle_id má ON DELETE CASCADE, takže po zmazaní
    // vozidla už nebude možné zistiť, ktoré dokumenty boli naň naviazané.
    // Samotný dokument (public.documents) sa NIKDY nemaže spolu s vozidlom
    // — iba stráca vlastníka, takže ho po zmazaní vozidla vrátime späť do
    // bežného Inbox listingu (archived_from_inbox_at = null), aby nezostal
    // "zavesený" bez akéhokoľvek miesta, kde by bol viditeľný.
    const { data: linkedPzpTpDocs } = await supabase
      .from("document_links")
      .select("document_id, documents!inner(document_type)")
      .eq("vehicle_id", id)
      .eq("company_id", companyId)
      .in("documents.document_type", ["insurance", "vehicle_registration"]);

    const { error } = await supabase
      .from("vehicles")
      .delete()
      .eq("id", id)
      .eq("company_id", companyId);

    if (error) {
      alert(t("vehicles.errors.vehicleDeleteFailedPrefix", { message: error.message }));
      return;
    }

    const documentIdsToUnarchive = (linkedPzpTpDocs || [])
      .map((row) => row.document_id)
      .filter((docId): docId is string => Boolean(docId));

    if (documentIdsToUnarchive.length > 0) {
      // Vozidlo zmazať smie iba owner/admin (vehicles_delete_owner_admin) —
      // teda aj tento plain UPDATE na documents (bežne owner/admin only,
      // documents_update_owner_admin) je tu vždy v súlade s RLS, keďže sme
      // sa sem dostali iba vďaka tomu, že volajúci už owner/admin je.
      const { error: unarchiveError } = await supabase
        .from("documents")
        .update({ archived_from_inbox_at: null })
        .in("id", documentIdsToUnarchive)
        .eq("company_id", companyId);

      if (unarchiveError) {
        console.error(
          "Dokumenty zmazaného vozidla sa nepodarilo vrátiť do Inboxu:",
          unarchiveError
        );
      }
    }

    const paths = (photosToClean || [])
      .map((p) => p.storage_path)
      .filter((p): p is string => Boolean(p));

    if (paths.length > 0) {
      const { error: storageError } = await supabase.storage
        .from("vehicle-photos")
        .remove(paths);

      if (storageError) {
        console.error(
          "Vozidlo bolo vymazané, ale fotografie sa nepodarilo odstrániť zo Storage:",
          storageError
        );
      }
    }

    await Promise.all([loadVehicles(), refreshPlanUsage()]);
  }

  function cancelEdit() {
    setEditingId(null);
    setVehicle(null);
  }

  // ---------------------------------------------------------------------------
  // Odvodené zobrazenie fleet registra
  // ---------------------------------------------------------------------------
  const fuels = vehicleFuels(vehicles);

  const visibleVehicles = vehicles.filter((car) => {
    if (!matchesVehicleQuery(car, search)) return false;
    if (fuelFilter !== "all" && (car.palivo ?? "") !== fuelFilter) return false;
    if (inspectionFilter === "attention" && vehicleAttention(car) === null) return false;
    if (inspectionFilter === "missing" && car.stk && car.ek) return false;
    return true;
  });

  const attentionCount = vehicles.filter((car) => vehicleAttention(car) !== null).length;
  const missingInspectionCount = vehicles.filter((car) => !car.stk || !car.ek).length;

  /**
   * Jedna kontrola (STK/EK) ako štítok. Prázdny dátum sa NEOZNAČÍ ako
   * v poriadku — "nevieme" a "platné" sú dva rôzne stavy.
   */
  function inspectionCell(label: string, date: string | null) {
    const state = inspectionState(date);

    if (!date) {
      return (
        <span className="inline-flex items-center gap-1 rounded-doc-sm border border-dashed border-doc-border px-2 py-0.5 text-xs text-muted-esblu">
          {label}: {t("common.misc.notFilled")}
        </span>
      );
    }

    if (state.severity === "overdue") {
      return <StatusBadge kind="overdue" label={`${label} ${formatDate(date, locale)}`} />;
    }
    if (state.severity) {
      return <StatusBadge kind="needs_review" label={`${label} ${formatDate(date, locale)}`} />;
    }
    return (
      <span className="inline-flex items-center gap-1 rounded-doc-sm border border-doc-border px-2 py-0.5 text-xs tabular-nums text-secondary">
        {label}: {formatDate(date, locale)}
      </span>
    );
  }

  return (
    <PageShell wide moduleContext="vehicles">
      <BackLink href="/" label={t("inbox.backToMenu")} className="mb-6" />

      <PageHeader
        eyebrow={
          <span className="inline-flex items-center gap-2">
            <CarIcon size={18} />
            {t("nav.vehicles")}
          </span>
        }
        title={t("vehicles.register.title")}
        meta={t("vehicles.list.subtitle")}
        aside={
          canOperate(role) && !showRegistrationFlow && !vehicle ? (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setShowRegistrationFlow(true)}
                disabled={isNewVehicleBlocked}
                className={`${docButtonPrimary} gap-2`}
              >
                <ScanIcon size={16} />
                {t("vehicles.list.scanRegistrationCta")}
              </button>
              <button
                type="button"
                onClick={() => setVehicle({})}
                disabled={isNewVehicleBlocked}
                className={`${docButtonSecondary} gap-2`}
              >
                <PlusIcon size={16} />
                {t("vehicles.list.addManuallyCta")}
              </button>
            </div>
          ) : undefined
        }
      />

      {!planUsageLoading && isPlanLimited && (
        <PlanLimitNotice
          resource="vehicles"
          usage={planUsage}
          limit={planLimit}
          className="mt-4"
        />
      )}

      {legalHold && canOperate(role) && (
        <div className="mt-4">
          <Notice tone="warning">{t("common.legalHoldMessage")}</Notice>
        </div>
      )}

      {/* Technický preukaz (TP) — skenovanie AI, presunuté z Inbox (bod 2
          zadania). Zdieľa presne rovnaké handlery/stav/uloženie ako predtým
          v Inbox, iba UI vstupný bod je teraz tu na hlavnej obrazovke
          Vozidlá namiesto samostatnej sekcie v Inboxe. */}
      {canOperate(role) && showRegistrationFlow && (
        <div className="mt-6 rounded-doc border border-doc-border bg-doc-surface p-4 sm:p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-primary">
                {t("inbox.registration.sectionTitle")}
              </h2>
              <p className="mt-2 text-sm text-secondary">
                {t("inbox.registration.sectionDescription")}
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setShowRegistrationFlow(false);
                clearRegistrationImages();
              }}
              className="shrink-0 rounded-xl bg-surface-2 px-4 py-2 text-sm font-semibold text-secondary hover:bg-surface-hover"
            >
              {t("common.buttons.cancel")}
            </button>
          </div>

          <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
            <section className="rounded-doc border border-doc-border bg-surface-2 p-4">
              <h3 className="text-sm font-semibold">{t("inbox.registration.frontTitle")}</h3>
              <p className="mt-1 text-sm text-secondary">
                {t("inbox.registration.frontRequired")}
              </p>

              <UploadActions
                className="mt-4"
                cameraLabel={isPreparingRegFront ? t("inbox.registration.preparing") : t("inbox.registration.takePhoto")}
                galleryLabel={t("inbox.registration.chooseFromGallery")}
                disabled={isProcessingRegistration || isPreparingRegFront || legalHold}
                onSelect={(event) => handleRegistrationFileChange("front", event)}
              />

              {regFrontPreview ? (
                <div className="mt-4">
                  <img
                    src={regFrontPreview}
                    alt={t("inbox.registration.frontAlt")}
                    className="h-64 w-full rounded-doc border border-doc-border bg-doc-surface object-contain"
                  />
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                    <p className="text-xs text-muted-esblu">
                      {t("inbox.registration.replaceHint")}
                    </p>
                    <button
                      type="button"
                      onClick={() => removeRegistrationImage("front")}
                      disabled={isProcessingRegistration}
                      className={`${docButtonDanger} px-2.5 text-xs`}
                    >
                      {t("inbox.registration.remove")}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mt-4 rounded-doc border border-dashed border-doc-border p-8 text-center text-sm text-muted-esblu">
                  {t("inbox.registration.frontNotSelected")}
                </div>
              )}
            </section>

            <section className="rounded-doc border border-doc-border bg-surface-2 p-4">
              <h3 className="text-sm font-semibold">{t("inbox.registration.backTitle")}</h3>
              <p className="mt-1 text-sm text-secondary">
                {t("inbox.registration.backOptional")}
              </p>

              <UploadActions
                className="mt-4"
                cameraLabel={isPreparingRegBack ? t("inbox.registration.preparing") : t("inbox.registration.takePhoto")}
                galleryLabel={t("inbox.registration.chooseFromGallery")}
                disabled={isProcessingRegistration || isPreparingRegBack || legalHold}
                onSelect={(event) => handleRegistrationFileChange("back", event)}
              />

              {regBackPreview ? (
                <div className="mt-4">
                  <img
                    src={regBackPreview}
                    alt={t("inbox.registration.backAlt")}
                    className="h-64 w-full rounded-doc border border-doc-border bg-doc-surface object-contain"
                  />
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                    <p className="text-xs text-muted-esblu">
                      {t("inbox.registration.replaceHint")}
                    </p>
                    <button
                      type="button"
                      onClick={() => removeRegistrationImage("back")}
                      disabled={isProcessingRegistration}
                      className={`${docButtonDanger} px-2.5 text-xs`}
                    >
                      {t("inbox.registration.remove")}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mt-4 rounded-doc border border-dashed border-doc-border p-8 text-center text-sm text-muted-esblu">
                  {t("inbox.registration.backNotSelected")}
                </div>
              )}
            </section>
          </div>

          <button
            type="button"
            onClick={handleProcessRegistration}
            disabled={
              !regFrontFile ||
              isProcessingRegistration ||
              isPreparingRegFront ||
              isPreparingRegBack ||
              legalHold
            }
            className={`mt-5 ${docButtonPrimary}`}
          >
            {isProcessingRegistration
              ? t("inbox.registration.loadingData")
              : t("inbox.registration.loadDataWithAi")}
          </button>

          {registrationError && (
            <p className="mt-4 rounded-doc border border-danger/30 bg-danger-soft p-4 text-sm font-medium text-danger">
              {registrationError}
            </p>
          )}

          {registrationFields && (
            <div className="mt-5 space-y-4 rounded-doc border border-doc-border bg-surface-2 p-4">
              {registrationDuplicateVehicle ? (
                <p className="rounded-doc-sm border border-warning/30 bg-warning-soft px-4 py-3 text-sm font-medium text-warning">
                  {t("inbox.registration.duplicateFoundPrefix")}
                  {registrationDuplicateVehicle.spz || t("inbox.noPlate")}
                  {t("inbox.registration.duplicateFoundSuffix")}
                </p>
              ) : (
                <p className="badge-success rounded-xl p-3 text-sm font-medium">
                  {t("inbox.registration.noDuplicateFound")}
                </p>
              )}

              <h3 className="text-sm font-semibold text-primary">
                {t("inbox.registration.reviewTitle")}
              </h3>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {[
                  ["spz", t("inbox.fields.spz")],
                  ["vin", t("inbox.fields.vin")],
                  ["znacka", t("inbox.fields.znacka")],
                  ["model", t("inbox.fields.model")],
                  ["rokVyroby", t("inbox.fields.rokVyroby")],
                  ["datumPrvejEvidencie", t("inbox.fields.datumPrvejEvidencie")],
                  ["palivo", t("inbox.fields.palivo")],
                  ["objemMotora", t("inbox.fields.objemMotora")],
                  ["vykon", t("inbox.fields.vykon")],
                  ["farba", t("inbox.fields.farba")],
                  ["prevadzkovaHmotnost", t("inbox.fields.prevadzkovaHmotnost")],
                  ["pocetMiest", t("inbox.fields.pocetMiest")],
                  ["kategoriaVozidla", t("inbox.fields.kategoriaVozidla")],
                  ["druhVozidla", t("inbox.fields.druhVozidla")],
                  [
                    "najvacsiaPripustnaCelkovaHmotnost",
                    t("inbox.fields.najvacsiaPripustnaCelkovaHmotnost"),
                  ],
                  ["cisloTechnickehoPreukazu", t("inbox.fields.cisloTechnickehoPreukazu")],
                ].map(([key, label]) => (
                  <label key={key} className="block">
                    <span className={docLabel}>
                      {label}
                    </span>
                    <input
                      className="mt-1 w-full rounded-xl border border-subtle bg-surface-1 p-3 outline-none"
                      value={registrationFields[key] ?? ""}
                      onChange={(e) =>
                        updateRegistrationField(key, e.target.value)
                      }
                    />
                  </label>
                ))}
              </div>

              {/* Diaľničné známky — ručné, voliteľné, predvolene prázdne
                  (AI ich z technického preukazu neextrahuje, štandardne ho
                  ani neobsahuje). Podporuje viac riadkov naraz (jeden na
                  krajinu) — presne rovnaký country/valid_until model ako
                  sekcia "Diaľničné známky" v detaile vozidla, uložený AŽ pri
                  potvrdení vytvorenia/aktualizácie vozidla nižšie. */}
              <div className="mt-2 rounded-doc border border-doc-border bg-doc-surface p-4">
                <h4 className="text-sm font-bold text-primary">
                  {t("inbox.registration.vignettesSectionTitle")}
                </h4>
                <p className="mt-1 text-xs text-muted-esblu">
                  {t("inbox.registration.vignettesSectionDescription")}
                </p>

                {registrationVignettes.length > 0 && (
                  <div className="mt-4 space-y-3">
                    {registrationVignettes.map((row, index) => (
                      <div
                        key={index}
                        className="grid grid-cols-1 gap-3 rounded-doc-sm border border-doc-border bg-doc-surface p-3 md:grid-cols-[1fr_1fr_auto]"
                      >
                        <label className="block">
                          <span className="text-xs font-medium text-secondary">
                            {t("vehicles.vignettes.country")}
                          </span>
                          <select
                            className="mt-1 w-full rounded-xl border border-subtle bg-surface-1 p-3 outline-none"
                            value={
                              row.countryMode === "custom"
                                ? VIGNETTE_OTHER_COUNTRY_OPTION
                                : row.country_code
                            }
                            onChange={(e) =>
                              handleRegistrationVignetteCountrySelect(
                                index,
                                e.target.value
                              )
                            }
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

                          {row.countryMode === "custom" && (
                            <input
                              className="mt-2 w-full rounded-xl border border-subtle bg-surface-1 p-3 uppercase outline-none"
                              maxLength={2}
                              placeholder={t(
                                "vehicles.vignettes.otherCountryCodePlaceholder"
                              )}
                              value={row.country_code}
                              onChange={(e) =>
                                handleRegistrationVignetteCustomCountryInput(
                                  index,
                                  e.target.value
                                )
                              }
                            />
                          )}
                        </label>

                        <label className="block">
                          <span className="text-xs font-medium text-secondary">
                            {t("vehicles.vignettes.validUntil")}
                          </span>
                          <input
                            type="date"
                            className="mt-1 w-full rounded-xl border border-subtle bg-surface-1 p-3 outline-none"
                            value={row.valid_until}
                            onChange={(e) =>
                              updateRegistrationVignetteRow(
                                index,
                                "valid_until",
                                e.target.value
                              )
                            }
                          />
                        </label>

                        <button
                          type="button"
                          onClick={() => removeRegistrationVignetteRow(index)}
                          className="self-end rounded-xl bg-surface-1 px-4 py-3 text-xs font-bold text-secondary hover:bg-surface-hover md:self-center"
                        >
                          {t("vehicles.vignettes.remove")}
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <button
                  type="button"
                  onClick={addRegistrationVignetteRow}
                  className="mt-4 rounded-xl border border-subtle bg-surface-2 px-4 py-2 text-sm font-semibold text-secondary hover:bg-surface-hover"
                >
                  {t("vehicles.vignettes.addAnother")}
                </button>
              </div>

              <button
                type="button"
                onClick={saveRegistrationDocument}
                disabled={
                  isSavingRegistration ||
                  legalHold ||
                  (!registrationDuplicateVehicle &&
                    (planUsageLoading || isPlanLimited))
                }
                className={`w-full ${docButtonPrimary}`}
              >
                {isSavingRegistration
                  ? t("common.buttons.saving")
                  : registrationDuplicateVehicle
                    ? t("inbox.registration.updateVehicle")
                    : t("inbox.registration.createVehicle")}
              </button>

              {!registrationDuplicateVehicle &&
                !planUsageLoading &&
                isPlanLimited && (
                  <p className="rounded-doc-sm border border-danger/30 bg-danger-soft p-3 text-sm font-medium text-danger">
                    {t("common.planLimitMessage")}
                  </p>
                )}
            </div>
          )}
        </div>
      )}

      {/* Pridávanie fotografií smie aj employee (rovnaké oprávnenie ako
          SELECT/INSERT na vehicle_photos) — samotné vozidlá (vytváranie/
          úprava/mazanie v tomto module) ostávajú employeeovi naďalej
          nedostupné, toto sa ich netýka. */}
      {role && (
        <div className="mt-6">
          <SectionPanel
            title={t("vehicles.gallery.addPhotosTitle")}
            description={t("vehicles.gallery.addPhotosDescription")}
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="min-w-0 sm:flex-1">
                <label className="sr-only" htmlFor="photo-target-vehicle">
                  {t("inbox.chooseVehiclePlaceholder")}
                </label>
                <select
                  id="photo-target-vehicle"
                  value={photoTargetVehicleId}
                  onChange={(e) => setPhotoTargetVehicleId(e.target.value)}
                  className={docField}
                >
                  <option value="">{t("inbox.chooseVehiclePlaceholder")}</option>
                  {vehicles.map((car) => (
                    <option key={car.id} value={car.id}>
                      {car.spz || t("inbox.noPlateCapitalized")}
                      {car.znacka ? ` — ${car.znacka} ${car.model || ""}` : ""}
                    </option>
                  ))}
                </select>
              </div>

              <UploadActions
                className="shrink-0"
                multiple
                cameraLabel={t("inbox.registration.takePhoto")}
                galleryLabel={t("machines.detail.galleryButton")}
                disabled={isUploadingVehiclePhotos || !photoTargetVehicleId || legalHold}
                onSelect={uploadVehiclePhotosFromList}
              />
            </div>

            {isUploadingVehiclePhotos && (
              <p className="mt-3 text-sm text-secondary">{t("inbox.uploading")}</p>
            )}

            {vehicles.length === 0 && (
              <p className="mt-3 text-sm text-muted-esblu">
                {t("vehicles.list.noneYetShort")}
              </p>
            )}

            {photoUploadFeedback && (
              <div className="mt-3">
                <Notice tone={photoUploadFeedback.type === "success" ? "info" : "critical"}>
                  {photoUploadFeedback.text}
                </Notice>
              </div>
            )}
          </SectionPanel>
        </div>
      )}

      {canOperate(role) && vehicle && (
        <div className="mt-6 space-y-4">
          <SectionPanel
            title={
              editingId
                ? t("vehicles.forms.editVehicleTitle")
                : t("vehicles.forms.reviewVehicleTitle")
            }
          >
            {/* Zoskupené podľa toho, ako sa vozidlo v evidencii popisuje:
                čím sa identifikuje -> aké má parametre -> kedy mu končia
                kontroly. Plochá mriežka 14 polí nedávala poradie zmysel. */}
            <p className={docLabel}>{t("vehicles.forms.groupIdentification")}</p>
            <div className="grid gap-4 sm:grid-cols-2">
              {(
                [
                  [t("inbox.fields.spz"), "spz"],
                  [t("inbox.fields.vin"), "vin"],
                  [t("inbox.fields.znacka"), "znacka"],
                  [t("inbox.fields.model"), "model"],
                  [t("inbox.fields.rokVyroby"), "rokVyroby"],
                  [t("inbox.fields.datumPrvejEvidencie"), "datumPrvejEvidencie"],
                ] as [string, string][]
              ).map(([label, key]) => (
                <div key={key}>
                  <label className={docLabel} htmlFor={`vehicle-${key}`}>
                    {label}
                  </label>
                  <input
                    id={`vehicle-${key}`}
                    className={docField}
                    value={vehicle?.[key] || ""}
                    onChange={(e) => updateVehicle(key, e.target.value)}
                  />
                </div>
              ))}
            </div>

            <p className={`${docLabel} mt-5`}>{t("vehicles.forms.groupTechnical")}</p>
            <div className="grid gap-4 sm:grid-cols-2">
              {(
                [
                  [t("inbox.fields.palivo"), "palivo"],
                  [t("inbox.fields.objemMotora"), "objemMotora"],
                  [t("inbox.fields.vykon"), "vykon"],
                  [t("inbox.fields.farba"), "farba"],
                  [t("vehicles.fields.hmotnost"), "hmotnost"],
                  [t("inbox.fields.pocetMiest"), "pocetMiest"],
                ] as [string, string][]
              ).map(([label, key]) => (
                <div key={key}>
                  <label className={docLabel} htmlFor={`vehicle-${key}`}>
                    {label}
                  </label>
                  <input
                    id={`vehicle-${key}`}
                    className={docField}
                    value={vehicle?.[key] || ""}
                    onChange={(e) => updateVehicle(key, e.target.value)}
                  />
                </div>
              ))}
            </div>

            <p className={`${docLabel} mt-5`}>{t("vehicles.forms.groupInspections")}</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={docLabel} htmlFor="vehicle-stk">
                  {t("vehicles.fields.stkValidUntil")}
                </label>
                <input
                  id="vehicle-stk"
                  type="date"
                  className={docField}
                  value={vehicle.stk || ""}
                  onChange={(e) => updateVehicle("stk", e.target.value)}
                />
              </div>

              <div>
                <label className={docLabel} htmlFor="vehicle-ek">
                  {t("vehicles.fields.ekValidUntil")}
                </label>
                <input
                  id="vehicle-ek"
                  type="date"
                  className={docField}
                  value={vehicle.ek || ""}
                  onChange={(e) => updateVehicle("ek", e.target.value)}
                />
              </div>
            </div>

            <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
              <button type="button" onClick={cancelEdit} className={docButtonSecondary}>
                {t("vehicles.forms.cancelEdit")}
              </button>
              <button
                type="button"
                onClick={handleSaveVehicle}
                disabled={isSaving}
                className={docButtonPrimary}
              >
                {isSaving
                  ? t("common.buttons.saving")
                  : editingId
                    ? t("vehicles.forms.saveChanges")
                    : t("vehicles.forms.saveVehicle")}
              </button>
            </div>
          </SectionPanel>
        </div>
      )}

      <div className="mt-8">
        <h2 className="mb-3 text-lg font-semibold text-primary">
          {t("vehicles.list.savedVehiclesTitle")}
        </h2>

        <RegisterToolbar
          filtersLabel={t("common.register.filters")}
          filtersCloseLabel={t("common.register.filtersClose")}
          activeFilterCount={
            (fuelFilter !== "all" ? 1 : 0) + (inspectionFilter !== "all" ? 1 : 0)
          }
          search={
            <SearchField
              label={t("vehicles.register.searchLabel")}
              placeholder={t("vehicles.register.searchPlaceholder")}
              value={search}
              onChange={setSearch}
            />
          }
          filters={
            <div className="space-y-2">
              <FilterChips
                label={t("vehicles.register.inspectionFilterLabel")}
                active={inspectionFilter}
                onSelect={(key) => setInspectionFilter(key as InspectionFilter)}
                options={[
                  { key: "all", label: t("common.register.all"), count: vehicles.length },
                  {
                    key: "attention",
                    label: t("vehicles.register.needsAttention"),
                    count: attentionCount,
                  },
                  {
                    key: "missing",
                    label: t("vehicles.register.missingInspection"),
                    count: missingInspectionCount,
                  },
                ]}
              />
              {fuels.length > 0 && (
                <FilterChips
                  label={t("inbox.fields.palivo")}
                  active={fuelFilter}
                  onSelect={setFuelFilter}
                  options={[
                    { key: "all", label: t("vehicles.register.allFuels") },
                    ...fuels.map((fuel) => ({ key: fuel, label: fuel })),
                  ]}
                />
              )}
            </div>
          }
        />

        <div className="mt-4">
          {loading ? (
            <LoadingRows label={t("common.buttons.loading")} />
          ) : loadError ? (
            <Notice tone="critical">{loadError}</Notice>
          ) : vehicles.length === 0 ? (
            <EmptyState
              title={t("vehicles.list.noneYet")}
              action={
                canOperate(role) ? (
                  <button
                    type="button"
                    onClick={() => setVehicle({})}
                    disabled={isNewVehicleBlocked}
                    className={`${docButtonPrimary} gap-2`}
                  >
                    <PlusIcon size={16} />
                    {t("vehicles.list.addManuallyCta")}
                  </button>
                ) : undefined
              }
            />
          ) : visibleVehicles.length === 0 ? (
            <EmptyState title={t("common.register.noMatches")} />
          ) : (
            <>
              <RegisterHeader columns={VEHICLE_COLUMNS}>
                <span>{t("vehicles.register.colVehicle")}</span>
                <span>{t("inbox.fields.vin")}</span>
                <span>{t("vehicles.register.colEngine")}</span>
                <span>{t("vehicles.register.colInspections")}</span>
              </RegisterHeader>

              <ul className="mt-2 space-y-1.5">
                {visibleVehicles.map((car) => (
                  <DataRow
                    key={car.id}
                    href={vehicleDetailHref(car.id)}
                    columns={VEHICLE_COLUMNS}
                    ariaLabel={`${car.spz} · ${vehicleTitle(car, t("dashboard.noName"))}`}
                    trailing={
                      isOwnerOrAdmin(role) ? (
                        <>
                          <button
                            type="button"
                            onClick={() => handleEdit(car)}
                            aria-label={`${t("common.buttons.edit")}: ${car.spz}`}
                            className={`${docButtonSecondary} px-2.5 text-xs`}
                          >
                            {t("common.buttons.edit")}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteVehicle(car.id)}
                            aria-label={`${t("common.buttons.delete")}: ${car.spz}`}
                            className={`${docButtonDanger} px-2.5 text-xs`}
                          >
                            {t("common.buttons.delete")}
                          </button>
                        </>
                      ) : undefined
                    }
                  >
                    {/* 1 ŠPZ + značka/model — ŠPZ je to, čím vodič vozidlo
                        pomenúva, preto vedie riadok. */}
                    <div className="flex min-w-0 items-center gap-3">
                      {photosByVehicle[car.id] ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={photosByVehicle[car.id]}
                          alt=""
                          className="h-10 w-10 shrink-0 rounded-doc-sm border border-doc-border object-cover"
                        />
                      ) : (
                        <span
                          aria-hidden="true"
                          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-doc-sm border border-doc-border bg-surface-2 text-muted-esblu"
                        >
                          <CarIcon size={18} />
                        </span>
                      )}
                      <div className="min-w-0">
                        <PlateBadge plate={car.spz || t("inbox.noPlate")} size="sm" />
                        <p className="mt-1 truncate text-sm text-secondary">
                          {[car.znacka, car.model].filter(Boolean).join(" ") || "—"}
                          {car.rok_vyroby ? ` · ${car.rok_vyroby}` : ""}
                        </p>
                      </div>
                    </div>

                    {/* 2 VIN */}
                    <p className="mt-1.5 truncate font-mono text-sm text-muted-esblu sm:mt-0">
                      {car.vin || "—"}
                    </p>

                    {/* 3 palivo + výkon */}
                    <div className="mt-1.5 min-w-0 sm:mt-0">
                      <p className="truncate text-sm text-secondary">{car.palivo || "—"}</p>
                      {car.vykon && (
                        <p className="mt-0.5 text-sm tabular-nums text-muted-esblu">
                          {car.vykon} kW
                        </p>
                      )}
                    </div>

                    {/* 4 STK + EK — stav nesie text aj farba, nikdy len farba */}
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 sm:mt-0">
                      {inspectionCell(t("vehicles.fields.stk"), car.stk)}
                      {inspectionCell(t("vehicles.fields.ek"), car.ek)}
                    </div>
                  </DataRow>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </PageShell>
  );
}
