"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { flushMediaDeletions } from "@/lib/storage/media-deletion";
import { signMediaUrl } from "@/lib/storage/signed-media";
import {
  canOperate,
  getCompanyProfile,
  getMyActiveMembership,
  hasFinanceView,
} from "@/lib/company";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import InboxDocumentIcon from "./icons/InboxDocumentIcon";
import BusinessPartnersIcon from "./icons/BusinessPartnersIcon";
import InvoicesIcon from "./icons/InvoicesIcon";
import SettingsIcon from "./icons/SettingsIcon";
import type { VehicleVignette } from "@/lib/vehicle-vignettes";
import { inventoryItemDetailHref, machineDetailHref, vehicleDetailHref } from "@/lib/entity-links";
import { isAppRouteAvailable } from "@/lib/app-routes";
import { IS_MOBILE_BUILD } from "@/lib/build-target";
import { buildLegacyDashboardAlerts } from "@/lib/deadlines";
import { apiUrl } from "@/lib/api-url";
import { REQUEST_LOCALE_HEADER } from "@/lib/i18n/request-locale";
import type { IntentResult } from "@/lib/intents/types";
import { useVoiceSession } from "@/hooks/use-voice-session";
import { VoiceSessionControl, voiceSessionStatusText } from "@/app/components/voice/VoiceSessionControl";
import { decideVoiceReplyForPreview } from "@/lib/voice/command-safety";
import { ASSISTANT_TIMEOUTS, failureMessageKey, fetchJsonWithTimeout } from "@/lib/voice/assistant-http";
import { IntentResultView, QuickReplies } from "@/app/components/voice/IntentResultView";
import { VoiceReplyToggle } from "@/app/components/voice/VoiceReplyToggle";
import { cancelSpeech } from "@/lib/voice/speech";
import { spokenTextFor } from "@/lib/voice/spoken-text";
import { todayLocalDate } from "@/lib/local-date";
import { CarIcon, FolderIcon, MachineIcon, PackageIcon } from "@/app/components/icons/AppIcons";
import { ModuleCylinder, type CylinderCardView } from "@/app/components/dashboard/ModuleCylinder";
import { buildDashboardModules, type DashboardModuleKey } from "@/lib/dashboard/modules";
import { parseCylinderVariant, type CylinderVariantName } from "@/lib/dashboard/cylinder";
import { useCompanyEntitlements } from "@/hooks/use-company-entitlements";
import { useMediaQuery, useSearchParamValue } from "@/hooks/use-media-query";
import { downloadDocumentPackage, PackageDownloadError } from "@/lib/document-package-client";
import { describePackageError, describePackageOutcome } from "@/app/components/folders/package-messages";
import { signOutOnThisDevice } from "@/lib/sign-out";
import { AppLink } from "@/app/components/AppLink";

function getGreeting(t: (key: string) => string) {
  const hour = new Date().getHours();

  if (hour >= 5 && hour < 12) return t("dashboard.greetingMorning");
  if (hour >= 12 && hour < 18) return t("dashboard.greetingAfternoon");
  if (hour >= 18 && hour < 22) return t("dashboard.greetingEvening");

  return t("dashboard.greetingNight");
}

const OPERATIONAL_HREFS = ["/vozidla", "/stroje", "/sklad"];
const FINANCE_HREFS = ["/obchodni-partneri", "/faktury", "/priecinky"];

/**
 * Jedno pravidlo viditeľnosti modulu pre dlaždice aj navigáciu.
 *
 * Doteraz sa filter písal dvakrát a iba pre financie. Účtovník potrebuje
 * opačný smer — vidí doklady, nevidí majetok — takže obe osi patria na
 * jedno miesto, inak sa časom rozídu.
 */
function isModuleVisible(
  href: string,
  financeAccess: boolean,
  operationalAccess: boolean
): boolean {
  // Mobile M0: modul, ktorý v tomto builde neexistuje (mobilná appka zatiaľ
  // nemá faktúry, partnerov ani priečinky), sa nezobrazí vôbec — žiadna
  // dlaždica ani položka menu, ktorá by viedla na prázdnu stránku. Na webe
  // je každá routa dostupná, správanie sa nemení.
  if (!isAppRouteAvailable(href)) return false;
  if (FINANCE_HREFS.includes(href)) return financeAccess;
  if (OPERATIONAL_HREFS.includes(href)) return operationalAccess;
  return true;
}

export default function Dashboard() {
  const router = useRouter();
  const { locale, t } = useLocale();

  const [vehicles, setVehicles] = useState<any[]>([]);
  const [machines, setMachines] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  // Diaľničné známky (vehicle_vignettes) — jedno vozidlo môže mať viac
  // riadkov (jeden na krajinu), pozri migráciu 20260823090000. Načítané
  // raz pre celú firmu (rovnaký vzor ako vehicles/machines/items vyššie) a
  // v buildLegacyDashboardAlerts() (lib/deadlines.ts) priradené k vozidlu
  // cez vehicle_id.
  const [vignettes, setVignettes] = useState<VehicleVignette[]>([]);
  const [companyName, setCompanyName] = useState("ESBLU");
  const [companyLogoUrl, setCompanyLogoUrl] = useState("");
  // Finance Access Hardening — "Obchodní partneri" dlaždica/nav odkaz sa
  // zobrazí iba ownerovi alebo členovi s explicitným finance view/manage
  // oprávnením (pozri lib/company.ts hasFinanceView). Toto je iba UI
  // vrstva — skutočné vynútenie je RLS (esblu_my_finance_view()) na
  // strane DB, takže priame otvorenie URL bez oprávnenia aj tak nič
  // nezobrazí.
  const [financeAccess, setFinanceAccess] = useState(false);
  // Prevádzkový rozsah — účtovník nemá stroje, sklad ani vozidlá ako modul.
  const [operationalAccess, setOperationalAccess] = useState(false);
  const [search, setSearch] = useState("");
  // Intent Engine (app/api/assistant/intent) — samostatný stav od
  // existujúceho plain-substring searchResults nižšie, aby sa pri
  // nerozpoznanom texte appka bezo zmeny vrátila na pôvodné správanie
  // (zadanie: "Search UX preferujúci centrálne pole" — JEDNO pole, dve
  // vrstvy výsledkov, žiadna duplicitná UI).
  const [intentResult, setIntentResult] = useState<IntentResult | null>(null);
  const currentIntentResult = intentResult;
  // Náhľad čakajúci na potvrdenie — pre hlasové „Áno" (ref: číta ho callback nahrávania).
  const pendingPreviewRef = useRef<IntentResult | null>(null);
  const confirmInFlightRef = useRef(false);
  // Posledný výsledok pre kontext prepisu reči (čítané v callbacku nahrávania).
  const intentResultRef = useRef<IntentResult | null>(null);
  // Veta už vybavená hlasovou reláciou — debounced efekt hľadania ju
  // nesmie poslať druhýkrát (pole hľadania iba zobrazuje prepis).
  const voiceHandledTextRef = useRef<string | null>(null);
  // Rozpracovaná otázka asistenta („Ku ktorému stroju?") — zapečatený token
  // servera. V ref, nie v poli hľadania: zápis prepisu do poľa ju nezmaže.
  const pendingClarificationRef = useRef<string | null>(null);
  // Dialóg faktúry („Vytvor faktúru pre Tester1" → „Čo má byť na faktúre?").
  // Stav drží server podľa tohto identifikátora. Posiela sa IBA s hlasovým
  // prepisom — písaný text sa vyhodnocuje počas písania a rozpísané slovo
  // by sa inak zapísalo ako odpoveď do faktúry.
  const invoiceConversationIdRef = useRef<string>(newDashboardConversationId());
  const voiceTranscriptRef = useRef<string>("");
  useEffect(() => {
    pendingPreviewRef.current = intentResult?.kind === "action_preview" ? intentResult : null;
    intentResultRef.current = intentResult;
  }, [intentResult]);
  const [intentLoading, setIntentLoading] = useState(false);
  // Action Engine (doplnenie zadania, bod 6/23) — potvrdzovací tok pre WRITE
  // intenty (EXPORT_DOCUMENTS/CREATE_DOCUMENT_CATEGORY/RENAME_DOCUMENT_CATEGORY/
  // ASSIGN_DOCUMENTS_TO_CATEGORY). `intentResult` samo osebe nesie
  // `action_preview`/`action_result` (pozri renderIntentResult nižšie) —
  // toto je iba "prebieha potvrdenie" flag pre disabled stav tlačidiel počas
  // volania (export/EXPORT_DOCUMENTS je klientske, ostatné idú na
  // /api/assistant/action/execute).
  const [actionSubmitting, setActionSubmitting] = useState(false);
  // Priečinok, s ktorým sa v tomto rozhovore naposledy pracovalo — aby
  // „daj tam bločky za august" vedelo, kam je „tam". Posiela sa iba jeho
  // UUID; server ho overí pod RLS a bez neho sa radšej spýta. Nástenka
  // pritom NIKDY nemá „tento doklad" — výber dokladov sa odtiaľto neposiela.
  const [recentFolderId, setRecentFolderId] = useState<string | null>(null);
  // Hlasové vyhľadávanie (zadanie, sekcia B/C) — TENKÁ vstupná vrstva NAD
  // existujúcim Intent Enginom vyššie: mikrofón iba naplní `search` presne
  // tak, ako keby používateľ text napísal (spustí ten istý debounced efekt
  // nižšie), nikdy nevolá vlastný parser/handler. "processing" = záznam sa
  // odosiela na prepis (app/api/assistant/transcribe), nie na Intent
  // Engine — tam sa transkript posiela až AKO OBYČAJNÝ TEXT.
  // Naposledy vložený prepis — zobrazí sa ako krátka "Prepis: …" poznámka
  // (bod C zadania: "zobraz prepis po spracovaní"), zmizne hneď, ako
  // používateľ pole ručne upraví (pozri onChange pri <input> nižšie).
  const [voiceTranscript, setVoiceTranscript] = useState<string | null>(null);
  // KOREKCIA (dashboard v2): mobil už nemá permanentný sidebar ani priamy
  // odkaz na Nastavenia namiesto menu — hamburger teraz otvára skutočné
  // výsuvné menu s rovnakou navigáciou ako desktop sidebar. Čisto UI stav,
  // nič dátové/business.
  const [menuOpen, setMenuOpen] = useState(false);
  const greeting = getGreeting(t);
  useEffect(() => {
    checkUser();
  }, []);

  async function checkUser() {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session) {
      router.push("/login");
      return;
    }

    const membership = await getMyActiveMembership();

    if (!membership) {
      setVehicles([]);
      setMachines([]);
      setItems([]);
      setVignettes([]);
      setFinanceAccess(false);
      setOperationalAccess(false);
      // Bez aktívneho membershipu niet "firmy", ktorej branding by sa dal
      // načítať (esblu_get_company_profile by aj tak nič nevrátila) —
      // ostáva dnešný generický fallback ("ESBLU", žiadne logo).
      return;
    }

    setFinanceAccess(hasFinanceView(membership));
    setOperationalAccess(canOperate(membership.role));
    loadData(membership.company_id);
    loadCompanyProfile();
  }

  async function logout() {
    // Toto zariadenie po odhlásení nesmie ďalej dostávať upozornenia
    // (signOutOnThisDevice: push odregistrácia + lokálne artefakty + signOut).
    await signOutOnThisDevice();
    router.push("/login");
  }

  // Firemný názov + logo pre AKTÍVNEHO ČLENA firmy (owner/admin/employee
  // rovnako) — z jediného living source-of-truth, public.company_billing_
  // profile (Fáza 1B). Pozri lib/company.ts a
  // supabase/migrations/20260916120000_add_company_billing_profile_and_
  // business_partners.sql.
  //
  // OPRAVA (Fáza 1B, 16.9.2026): predošlý fallback na VLASTNÝ settings
  // riadok prihláseného používateľa bol odstránený. company_billing_profile
  // je teraz jediný živý zdroj brandingu — settings.company_name/logo_path
  // sú legacy a appka ich už nikdy nečíta (zadanie bod 5: "presne jeden
  // živý source-of-truth", "žiadny dual-write"). Fallback bol pôvodne
  // poistkou pre prechodný stav "RPC ešte nevidí dáta" — po tejto migrácii
  // (backfill + bootstrap insert) má KAŽDÁ firma garantovane presne jeden
  // company_billing_profile riadok, takže RPC vždy vráti profil (aj keď s
  // prázdnymi poľami) a settings fallback už nie je potrebný.
  async function loadCompanyProfile() {
    // Dokončenie prípadných nedokončených mazaní súborov firmy (fronta,
    // lib/storage/media-deletion.ts). Bez prístupu server nič nevráti.
    void flushMediaDeletions(supabase).catch(() => undefined);

    const profile = await getCompanyProfile();

    if (profile?.company_name) {
      setCompanyName(profile.company_name);
    }

    if (profile?.logo_path) {
      // Súkromný bucket: krátkodobá podpísaná URL (lib/storage/signed-media.ts).
      setCompanyLogoUrl(await signMediaUrl("company-logos", profile.logo_path));
    } else {
      setCompanyLogoUrl("");
    }
  }

  async function loadData(currentCompanyId: string) {
    const { data: vehicleData } = await supabase
      .from("vehicles")
      .select("*")
      .eq("company_id", currentCompanyId);

    const { data: machineData } = await supabase
      .from("machines")
      .select("*")
      .eq("company_id", currentCompanyId);

    const { data: itemData } = await supabase
      .from("inventory_items")
      .select("*")
      .eq("company_id", currentCompanyId);

    const { data: vignetteData } = await supabase
      .from("vehicle_vignettes")
      .select("*")
      .eq("company_id", currentCompanyId);

    setVehicles(vehicleData || []);
    setMachines(machineData || []);
    setItems(itemData || []);
    setVignettes(vignetteData || []);
  }

  // Upozornenia na STK/EK/diaľničné známky — logika je teraz v zdieľanom
  // lib/deadlines.ts (buildLegacyDashboardAlerts), NIE inline v tejto
  // komponente. Tento wrapper existuje iba preto, aby zostal presne
  // rovnaký `alerts` tvar/farby/texty, aké Dashboard vždy zobrazoval
  // (level "red"/"orange", rovnaké i18n kľúče dashboard.alertOverdue /
  // dashboard.alertDueSoon) — nulová vizuálna regresia. next_service_date
  // (nové v tejto úlohe) sa do TOHOTO panelu zámerne nepremieta, pozri
  // komentár priamo v buildLegacyDashboardAlerts().
  const alerts = buildLegacyDashboardAlerts(vehicles, vignettes, locale);
  const query = search.toLowerCase().trim();

  // Bug (produkčný smoke test 2026-09-14): keď Intent Engine úspešne
  // odpovie (napr. "Kedy končí STK AA123BB" → kind "answer"), pod jeho
  // odpoveďou sa súčasne zobrazoval aj legacy "Nič sa nenašlo" z
  // nezávislého plain-substring searchResults nižšie — kontradiktórne UX.
  // `not_found`/`error` NIE sú "použiteľný výsledok" (Intent Engine sám
  // hovorí "nenašlo sa"/chyba) — v týchto prípadoch zámerne padáme na
  // legacy vyhľadávanie presne ako predtým (bod 2 opravy), takže legacy
  // substring zhoda (ak nejaká existuje) má stále šancu niečo nájsť.
  // Hlasový prepis ide VÝHRADNE cez asistenta. Podreťazcové hľadanie
  // nástenky („Nájdené dokumenty") je iba pre písaný text — celá vyslovená
  // veta ako hľadaný výraz by vrátila náhodné doklady.
  const isVoiceQuery = voiceTranscript !== null && search === voiceTranscript;

  const hasUsableIntentResult =
    query.length >= 2 &&
    !!intentResult &&
    intentResult.kind !== "not_found" &&
    intentResult.kind !== "error";

  const searchResults = query
    ? [
        ...vehicles
          .filter((v) =>
            `${v.znacka} ${v.model} ${v.spz} ${v.vin}`
              .toLowerCase()
              .includes(query)
          )
          .map((v) => ({
            type: t("dashboard.resultTypeVehicle"),
            title:
              `${v.znacka || ""} ${v.model || ""}`.trim() ||
              t("dashboard.vehicleFallbackName"),
            subtitle: `${v.spz || t("dashboard.noPlate")} | ${
              v.vin || t("dashboard.noVin")
            }`,
            href: vehicleDetailHref(v.id),
          })),

        ...machines
          .filter((m) =>
            `${m.name} ${m.category} ${m.manufacturer} ${m.model} ${m.serial_number}`
              .toLowerCase()
              .includes(query)
          )
          .map((m) => ({
            type: t("dashboard.resultTypeMachine"),
            title: m.name || t("dashboard.noName"),
            subtitle: `${m.category || t("dashboard.noCategory")} | ${
              m.serial_number || t("dashboard.noSerialNumber")
            }`,
            href: machineDetailHref(m.id),
          })),

        ...items
          .filter((i) =>
            `${i.name} ${i.category} ${i.location} ${i.notes}`
              .toLowerCase()
              .includes(query)
          )
          .map((i) => ({
            type: t("dashboard.resultTypeInventory"),
            title: i.name || t("dashboard.noName"),
            subtitle: `${i.quantity || 0} ${i.unit || ""} | ${
              i.location || t("dashboard.noLocation")
            }`,
            href: inventoryItemDetailHref(i.id),
          })),
      ]
    : [];

  // Intent Engine (app/api/assistant/intent) — beží NAD tým istým `search`
  // poľom ako existujúci plain-substring searchResults vyššie (zadanie,
  // bod 13: "jedno centrálne pole"), ale ako samostatná, debounced vrstva.
  // Pri nerozpoznanom texte (recognized: false) appka jednoducho ukáže
  // pôvodné searchResults bezo zmeny — toto rozšírenie preto nemôže
  // regresovať existujúce substring vyhľadávanie, iba ho DOPĹŇA o
  // rozpoznané príkazy/otázky (STK, dokumenty, report, termíny...).
  useEffect(() => {
    const trimmed = search.trim();

    // Krátky/prázdny text: panel sa už aj tak skryje na render-time podľa
    // `query.length >= 2` nižšie (žiadne synchronné setState priamo v tele
    // efektu pri early-return — react-hooks/set-state-in-effect), takže tu
    // stačí jednoducho nenaplánovať fetch.
    if (trimmed.length < 2) {
      return;
    }
    // Hlasová relácia túto vetu už poslala (a výsledok zobrazila).
    if (voiceHandledTextRef.current !== null && trimmed === voiceHandledTextRef.current.trim()) {
      return;
    }

    let cancelled = false;

    const timer = setTimeout(async () => {
      // `setIntentLoading(true)` je zámerne až TU (v callbacku setTimeout),
      // nie synchrónne v tele efektu — react-hooks/set-state-in-effect;
      // navyše správne UX-y: počas 400ms debounce sa loading indikátor
      // nemihne pri rýchlom písaní.
      if (!cancelled) setIntentLoading(true);

      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();

        if (!session) {
          if (!cancelled) setIntentLoading(false);
          return;
        }

        const response = await fetch(apiUrl("/api/assistant/intent"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
            [REQUEST_LOCALE_HEADER]: locale,
          },
          // Kalendárny deň prehliadača — rovnako ako v hlasovom launcheri.
          // Dashboard dnes doklad nezakladá, ale posiela sa na ten istý
          // endpoint; keby to tu chýbalo, správal by sa o polnoci inak než
          // launcher a rozdiel by sa hľadal ťažko.
          body: JSON.stringify({
            text: trimmed,
            localDate: todayLocalDate(),
            // Nástenka = globálny kontext: žiadny otvorený doklad ani výber.
            moduleContext: "dashboard",
            ...(recentFolderId ? { folderContext: { folderId: recentFolderId } } : {}),
            ...(pendingClarificationRef.current ? { pendingClarification: pendingClarificationRef.current } : {}),
            ...(trimmed === voiceTranscriptRef.current.trim() ? { conversationId: invoiceConversationIdRef.current } : {}),
          }),
        });

        const data = await response.json();

        if (cancelled) return;
        // Nová otázka = nový token; vykonaný nový príkaz alebo zrušenie ho zahodí.
        pendingClarificationRef.current = typeof data?.pendingClarification === "string" ? data.pendingClarification : null;

        const isVoiceTranscript = trimmed === voiceTranscriptRef.current.trim();
        if (response.ok && data.success && data.recognized) {
          const recognized = data.result as IntentResult;
          setIntentResult(recognized);
          if (recognized.kind === "navigate" && recognized.entity.type === "folder") {
            setRecentFolderId(recognized.entity.id);
          }
        } else if (isVoiceTranscript && response.ok && data?.success && data.result?.kind === "not_found") {
          // Hlasová veta, ktorej server nerozumel: jeho konkrétna veta
          // („Tomuto príkazu som nerozumel.") namiesto „Nič sa nenašlo." —
          // podreťazcové hľadanie celej vyslovenej vety nemá zmysel.
          setIntentResult(data.result as IntentResult);
        } else if (isVoiceTranscript && response.status === 400 && typeof data?.error === "string" && data.error) {
          // Odmietnuté pred spracovaním (napr. príliš dlhý prepis) — presná príčina.
          setIntentResult({ kind: "error", text: data.error });
        } else if (isVoiceTranscript) {
          // Hlas NIKDY nepadá do podreťazcového hľadania nástenky.
          setIntentResult({ kind: "error", text: t("search.errors.commandNotUnderstood") });
        } else {
          setIntentResult(null);
        }
      } catch (error) {
        // Sieťová/serverová chyba pri rozpoznávaní príkazu NIKDY nesmie
        // rozbiť existujúce substring vyhľadávanie nižšie — appka iba
        // potichu nezobrazí rozpoznaný-príkaz panel a spolieha sa na
        // searchResults ako doteraz.
        console.error("Intent Engine dopyt zlyhal:", error);
        if (!cancelled) setIntentResult(null);
      } finally {
        if (!cancelled) setIntentLoading(false);
      }
    }, 400);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // recentFolderId sa zámerne nesleduje: zmena kontextu nemá znova
    // spustiť rozpoznanie toho istého textu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, locale]);

  // ---------------------------------------------------------------------------
  // SÚVISLÝ HLASOVÝ REŽIM (Nástenka = globálne ovládanie hlasom).
  //
  // Jedno ťuknutie na mikrofón → Esblu počúva, odpovie nahlas a po dohovorení
  // počúva znova — bez ďalšieho ťuknutia. Veta ide na TEN ISTÝ endpoint s
  // tým istým dialógom (conversationId + zapečatená otázka) ako doteraz;
  // pole hľadania iba zobrazuje prepis. Písanie do poľa reláciu ukončí
  // (ručný režim) a nikdy ju nespustí.
  // ---------------------------------------------------------------------------
  async function askAssistantByVoice(text: string): Promise<{ spoken: string | null; endSession?: boolean }> {
    const trimmed = text.trim();
    voiceHandledTextRef.current = trimmed;
    voiceTranscriptRef.current = trimmed;
    setSearch(trimmed);
    setVoiceTranscript(trimmed);
    setIntentLoading(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) return { spoken: t("search.voice.states.denied"), endSession: true };
      const http = await fetchJsonWithTimeout<{
        success?: boolean;
        recognized?: boolean;
        result?: IntentResult;
        error?: string;
        pendingClarification?: string;
      }>(
        apiUrl("/api/assistant/intent"),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
            [REQUEST_LOCALE_HEADER]: locale,
          },
          body: JSON.stringify({
            text: trimmed,
            localDate: todayLocalDate(),
            moduleContext: "dashboard",
            conversationId: invoiceConversationIdRef.current,
            ...(recentFolderId ? { folderContext: { folderId: recentFolderId } } : {}),
            ...(pendingClarificationRef.current ? { pendingClarification: pendingClarificationRef.current } : {}),
          }),
        },
        { timeoutMs: ASSISTANT_TIMEOUTS.intentMs }
      );
      // Sieť / limit / offline / 5xx nie sú odpoveď — relácia povie „Spojenie
      // zlyhalo" a nič sa automaticky neopakuje.
      if (!http.ok && ["offline", "timeout", "network", "server", "invalid_response", "rate_limited", "cancelled"].includes(http.kind)) {
        throw new Error(`intent_${http.kind}`);
      }
      const data = (http.data ?? null) as {
        success?: boolean;
        recognized?: boolean;
        result?: IntentResult;
        error?: string;
        pendingClarification?: string;
      } | null;
      pendingClarificationRef.current = typeof data?.pendingClarification === "string" ? data.pendingClarification : null;
      if (!http.ok && http.kind === "unauthenticated") return { spoken: t("search.voice.errors.sessionExpired"), endSession: true };
      let result: IntentResult;
      if (http.ok && data?.success && data.result) {
        result = data.result;
        if (data.recognized && result.kind === "navigate" && result.entity.type === "folder") setRecentFolderId(result.entity.id);
      } else if (!http.ok && http.kind === "forbidden") {
        // OPRAVA: 403 predtým padalo do „nerozumel som".
        result = { kind: "error", text: t("search.voice.states.denied") };
      } else if (!http.ok && http.kind === "bad_request" && typeof data?.error === "string" && data.error) {
        result = { kind: "error", text: data.error };
      } else {
        result = { kind: "error", text: t("search.errors.commandNotUnderstood") };
      }
      setIntentResult(result);
      // Každé hlasové kolo niečo povie (aj výsledok, ktorý je iba odkazom).
      return {
        spoken:
          spokenTextFor(result, { confirmPrompt: t("search.voice.session.confirmPrompt"), found: t("search.voice.session.found") }) ??
          t("search.voice.states.complete"),
      };
    } finally {
      setIntentLoading(false);
    }
  }

  async function handleVoiceUtterance(text: string): Promise<{ spoken: string | null; endSession?: boolean }> {
    // Hlasové „Áno" pri zobrazenom náhľade = ťuknutie na Potvrdiť (ten istý
    // jednorazový podpísaný confirmationId). Nejasná krátka veta → otázka
    // znova, nikdy tichý súhlas (lib/voice/voice-session.ts).
    const pending = pendingPreviewRef.current;
    if (pending && pending.kind === "action_preview") {
      const decision = decideVoiceReplyForPreview(text, pending);
      // Nevratná akcia: iba ťuknutím (lib/voice/command-safety.ts).
      if (decision === "tap_required") {
        setVoiceTranscript(text);
        return { spoken: t("search.voice.session.tapToConfirm") };
      }
      if (decision === "confirm") {
        pendingPreviewRef.current = null;
        setVoiceTranscript(text);
        const executed = await handleActionConfirm(pending);
        return { spoken: spokenTextFor(executed) ?? t("search.voice.states.complete") };
      }
      if (decision === "cancel") {
        pendingPreviewRef.current = null;
        setVoiceTranscript(text);
        handleActionCancel();
        return { spoken: t("search.voice.session.cancelled") };
      }
      if (decision === "ask_again") return { spoken: t("search.voice.session.confirmAgain") };
    }
    return askAssistantByVoice(text);
  }

  const voice = useVoiceSession({
    // Otázka dialógu na nástenke je vždy otázka faktúry (iný dialóg tu nie je).
    getTranscriptionContext: () => (intentResultRef.current?.kind === "clarify" ? "invoice" : null),
    onUtterance: handleVoiceUtterance,
  });
  const voiceStatusText = voiceSessionStatusText(t, voice.session);

  // Tlačidlo „Áno" / „Nie" — tá istá cesta ako vyslovená odpoveď (asistent
  // s dialógom a zapečatenou otázkou), nie podreťazcové hľadanie.
  function sendQuickReply(text: string) {
    // Počas hlasovej relácie tlačidlo pokračuje hlasom (odpoveď zaznie a
    // Esblu počúva ďalej); inak je to obyčajná písaná odpoveď.
    if (voice.active) {
      voice.manualTurn(text);
      return;
    }
    cancelSpeech();
    voiceTranscriptRef.current = text;
    setSearch(text);
    setVoiceTranscript(text);
  }

  // ---------------------------------------------------------------------------
  // DASHBOARD v3 (2026-10-11): nekonečný valec modulov.
  //
  // Moduly = existujúce routy + existujúca viditeľnosť (finance/operational,
  // mobilné routy) + EXISTUJÚCE nároky firmy (esblu_get_my_company_entitlements).
  // Poradie: dostupné → zamknuté. Žiadny nový stav predplatného sa tu
  // nevymýšľa; pri nenačítaných nárokoch sa zámok nezobrazí (lib/dashboard/modules.ts).
  // ---------------------------------------------------------------------------
  const entitlements = useCompanyEntitlements();
  // Experiment B: ?cylinder=spatial (iba vizuálny token, žiadna iná logika).
  const cylinderVariant: CylinderVariantName = parseCylinderVariant(useSearchParamValue("cylinder"));
  const largeDashboard = useMediaQuery("(min-width: 1024px)");
  const [alertsOpen, setAlertsOpen] = useState(false);

  const dashboardModules = buildDashboardModules({
    isVisible: (href) => isModuleVisible(href, financeAccess, operationalAccess),
    entitlements: entitlements.loading ? null : entitlements.snapshot,
    counts: { vehicles: vehicles.length, machines: machines.length, inventory: items.length },
    alerts: { vehicles: alerts.length },
  });

  const MODULE_TITLES: Record<DashboardModuleKey, string> = {
    inbox: t("nav.inbox"),
    invoices: t("nav.invoices"),
    vehicles: t("nav.vehicles"),
    machines: t("nav.machines"),
    inventory: t("nav.inventory"),
    partners: t("nav.businessPartners"),
  };
  const COUNT_UNITS: Partial<Record<DashboardModuleKey, string>> = {
    vehicles: t("dashboard.moduleVehiclesSubtitle"),
    machines: t("dashboard.moduleMachinesSubtitle"),
    inventory: t("dashboard.moduleInventorySubtitle"),
  };

  const cylinderModules: CylinderCardView[] = dashboardModules.map((module) => ({
    ...module,
    title: MODULE_TITLES[module.key],
    description: t(`dashboard.cylinder.desc.${module.key}`),
    countLabel: module.count !== undefined && COUNT_UNITS[module.key] ? `${module.count} ${COUNT_UNITS[module.key]}` : null,
    alertsLabel: module.alerts ? t("dashboard.cylinder.alerts", { count: module.alerts }) : null,
    lockedLabel:
      module.access.state === "locked"
        ? t(module.access.reason === "TRIAL_EXPIRED" ? "dashboard.cylinder.lockedTrial" : "dashboard.cylinder.locked")
        : null,
    illustration: `/images/modules/${module.key}.svg`,
  }));

  // Spoločný zoznam navigačných položiek pre desktop sidebar AJ mobilné
  // výsuvné menu (jeden zdroj pravdy, žiadna duplicita odkazov/ciest).
  const navItems: {
    href: string;
    label: string;
    image?: string;
    icon?: ReactNode;
    badge?: number;
  }[] = [
    { href: "/ai-evidencia", label: t("nav.inbox"), icon: <InboxDocumentIcon size={18} /> },
    { href: "/vozidla", label: t("nav.vehicles"), icon: <CarIcon size={18} /> },
    { href: "/stroje", label: t("nav.machines"), icon: <MachineIcon size={18} /> },
    { href: "/sklad", label: t("nav.inventory"), icon: <PackageIcon size={18} /> },
    {
      href: "/obchodni-partneri",
      label: t("nav.businessPartners"),
      icon: <BusinessPartnersIcon size={18} />,
    },
    {
      href: "/faktury",
      label: t("nav.invoices"),
      icon: <InvoicesIcon size={18} />,
    },
    {
      href: "/priecinky",
      label: t("folders.navLabel"),
      icon: <FolderIcon size={18} />,
    },
    { href: "/nastavenia", label: t("nav.settings"), icon: <SettingsIcon size={18} /> },
    // Finance Access Hardening — rovnaký filter ako pri "modules" vyššie.
  ].filter((item) => isModuleVisible(item.href, financeAccess, operationalAccess));

  // Action Engine — [Zrušiť]: jednoduchý no-op, appka nič nezapísala do DB
  // (a pri EXPORT_DOCUMENTS ani nič nestiahla) — panel sa iba skryje, `search`
  // ostáva bezo zmeny (bod 5/23 zadania: "Cancel = no-op").
  function handleActionCancel() {
    setIntentResult(null);
  }

  // Action Engine — [Potvrdiť]/[Vytvoriť]/[Premenovať]/[Priradiť]/[Exportovať].
  // EXPORT_DOCUMENTS je VÝNIMKA: nevolá /api/assistant/action/execute vôbec
  // (export nezapisuje nič do DB) — priamo spustí existujúci klientsky
  // ExcelJS export flow z `exportPayload`, ktorý server už pripravil v
  // preview kroku (pozri komentár pri IntentResult#exportPayload v
  // lib/intents/types.ts). Ostatné 3 write intenty idú na samostatný
  // endpoint — HARDENED (bezpečnostné review): appka posiela VÝHRADNE
  // `confirmationId` (opaque referenciu na server-side uložený preview),
  // NIKDY znova `args` — server si kanonické filtre/count sám nanovo
  // načíta z assistant_action_confirmations, appka ich tu už nemá k
  // dispozícii (typ `action_preview` pole `args` už neobsahuje).
  async function handleActionConfirm(target?: IntentResult): Promise<IntentResult | null> {
    const intentResult = target ?? currentIntentResult;
    if (!intentResult || intentResult.kind !== "action_preview") return null;
    // Dvojité potvrdenie (ťuknutie + hlasové „áno") → iba jedno odoslanie.
    if (confirmInFlightRef.current) return null;
    confirmInFlightRef.current = true;
    setActionSubmitting(true);
    // Výsledok sa vráti aj volajúcemu — hlasová relácia ho povie nahlas.
    let final: IntentResult | null = null;
    const settle = (value: IntentResult) => {
      final = value;
      setIntentResult(value);
    };

    try {
      // Stiahnutie priečinka / dokladov: ten istý overený tok ako tlačidlo
      // „Stiahnuť priečinok". Server znova overí oprávnenie a každý doklad;
      // „Stiahnuté" sa zapíše až po prijatí celých bajtov.
      if (
        (intentResult.action === "FOLDER_EXPORT" || intentResult.action === "DOCUMENTS_EXPORT") &&
        intentResult.packageRequest
      ) {
        try {
          const outcome = await downloadDocumentPackage(intentResult.packageRequest, locale);
          const message = describePackageOutcome(t, outcome);
          settle({ kind: "action_result", success: true, text: message.text });
        } catch (error) {
          settle({
            kind: "action_result",
            success: false,
            text: describePackageError(t, error instanceof PackageDownloadError ? error : null),
          });
        }
        return final;
      }

      if (intentResult.action === "EXPORT_DOCUMENTS") {
        const payload = intentResult.exportPayload;
        const hasAnything =
          !!payload &&
          (payload.inboxDocuments.some((group) => group.records.length > 0) ||
            payload.evidenceRecords.length > 0);

        if (!hasAnything) {
          settle({
            kind: "action_result",
            success: false,
            text: t("search.actions.export.noDocuments"),
          });
          return final;
        }

        const [{ exportAiInboxFolderToExcel }, { exportAiEvidenceToExcel }] = await Promise.all([
          import("@/lib/export-ai-inbox-documents-excel"),
          import("@/lib/export-ai-evidence-excel"),
        ]);

        let exportedCount = 0;
        for (const group of payload!.inboxDocuments) {
          if (group.records.length === 0) continue;
          const result = await exportAiInboxFolderToExcel(group.kind, group.records, t);
          exportedCount += result.exportedCount;
        }
        if (payload!.evidenceRecords.length > 0) {
          const result = await exportAiEvidenceToExcel(payload!.evidenceRecords, locale, t);
          exportedCount += result.exportedCount;
        }

        settle({
          kind: "action_result",
          success: true,
          text: t("search.actions.export.done", { count: exportedCount }),
        });
        return final;
      }

      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        settle({ kind: "action_result", success: false, text: t("search.errors.generic") });
        return final;
      }

      const http = await fetchJsonWithTimeout<{ success?: boolean; result?: IntentResult }>(
        apiUrl("/api/assistant/action/execute"),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
            [REQUEST_LOCALE_HEADER]: locale,
          },
          body: JSON.stringify({ confirmationId: intentResult.confirmationId }),
        },
        { timeoutMs: ASSISTANT_TIMEOUTS.executeMs }
      );

      if (http.ok && http.data?.success && http.data.result) {
        const executed = http.data.result;
        settle(executed);
        if (executed.kind === "action_result" && executed.folder) setRecentFolderId(executed.folder.id);
      } else {
        // Konkrétna príčina (vypršané potvrdenie, bez oprávnenia, nejasný
        // výsledok po výpadku spojenia) — nikdy predstieraný úspech.
        const key = http.ok ? "search.errors.generic" : failureMessageKey(http.kind, "execute");
        settle({ kind: "action_result", success: false, text: t(key) });
      }
    } catch (error) {
      // Rovnaký fail-closed princíp ako pri Intent Engine dopyte vyššie —
      // appka pri sieťovej/neočakávanej chybe NIKDY nepredstiera úspech.
      console.error("Action Engine potvrdenie zlyhalo:", error instanceof Error ? error.message : "unknown");
      settle({ kind: "action_result", success: false, text: t("search.errors.generic") });
    } finally {
      confirmInFlightRef.current = false;
      setActionSubmitting(false);
    }
    return final;
  }

  // Kompaktný panel pre rozpoznaný Intent Engine výsledok (zadanie, bod 13:
  // "Ak intent znamená navigáciu → naviguj [na klik, nie automaticky pri
  // písaní]. Ak ide o odpoveď → zobraz compact result panel. Ak je
  // nejednoznačné → výber. Ak permission denied → jasná bezpečná chyba.").
  // Vracia null, ak niet čo zobraziť — volajúci potom padne na existujúci
  // plain-substring searchResults panel bezo zmeny.

  return (
    <main className="app-shell-bg relative">
      <div className="relative flex flex-col lg:min-h-screen lg:flex-row">
        {/* Desktop sidebar — KOREKCIA (dashboard v2): užší, plochý a tmavší
            (bez glass/blur efektu), aby nedominoval obrazovke a nepôsobil
            ako klasický enterprise admin panel. */}
        <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-subtle bg-page-bg-elevated px-3 py-5 lg:flex">
          <div className="flex items-center gap-2.5">
            {companyLogoUrl ? (
              <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-subtle bg-surface-1">
                <img
                  src={companyLogoUrl}
                  alt={`Logo ${companyName}`}
                  className="h-full w-full object-contain"
                />
              </div>
            ) : (
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-brand-sky to-brand-500">
                <div className="h-4 w-4 rotate-45 rounded-md border-[3px] border-[#051221]" />
              </div>
            )}

            <div className="min-w-0">
              <h1 className="truncate text-base font-black tracking-tight text-primary">
                {companyName}
              </h1>
              <p className="truncate text-[11px] font-medium text-muted-esblu">
                {t("dashboard.tagline")}
              </p>
            </div>
          </div>

          <nav className="mt-6 flex-1 space-y-0.5">
            <SideLink active href="/" label={t("nav.overview")} icon={<MenuIcon />} />
            {navItems.map((item) => (
              <SideLink
                key={item.href}
                href={item.href}
                label={item.label}
                image={item.image}
                icon={item.icon}
                badge={item.badge}
              />
            ))}
          </nav>

          <button
            onClick={logout}
            className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-medium text-secondary transition hover:bg-surface-hover hover:text-primary"
          >
            <LogoutIcon />
            {t("common.buttons.logout")}
          </button>
        </aside>

        {/* Mobilné výsuvné menu — KOREKCIA (dashboard v2): žiadny
            permanentný sidebar na mobile, iba hamburger, ktorý otvorí
            skutočné menu s rovnakou navigáciou ako desktop sidebar. */}
        {menuOpen && (
          <div className="fixed inset-0 z-40 lg:hidden">
            <button
              type="button"
              aria-label={t("dashboard.closeMenu")}
              onClick={() => setMenuOpen(false)}
              className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm"
            />
            <div className="absolute inset-y-0 right-0 flex w-[78%] max-w-xs flex-col border-l border-subtle bg-page-bg-elevated p-5">
              <div className="flex items-center justify-between">
                <span className="text-sm font-bold text-primary">
                  {t("dashboard.menuTitle")}
                </span>
                <button
                  type="button"
                  aria-label={t("dashboard.closeMenu")}
                  onClick={() => setMenuOpen(false)}
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-2 text-secondary"
                >
                  ✕
                </button>
              </div>

              <nav className="mt-6 flex-1 space-y-1.5">
                <SideLink
                  active
                  href="/"
                  label={t("nav.overview")}
                  icon={<MenuIcon />}
                  onNavigate={() => setMenuOpen(false)}
                />
                {navItems.map((item) => (
                  <SideLink
                    key={item.href}
                    href={item.href}
                    label={item.label}
                    image={item.image}
                    icon={item.icon}
                    badge={item.badge}
                    onNavigate={() => setMenuOpen(false)}
                  />
                ))}
              </nav>

              <button
                onClick={logout}
                className="ui-btn ui-btn-secondary w-full"
              >
                <LogoutIcon />
                {t("common.buttons.logout")}
              </button>
            </div>
          </div>
        )}

        {/* DASHBOARD v3: obrazovka bez scrollu — hlavička + hľadanie + valec
            vyplnia presne výšku medzi hornou hranou a spodnou lištou.
            OPRAVA 2026-10-11 (Android: neviditeľné karty): sekcia NESMIE mať
            na mobile `flex-1` — v stĺpcovom flex rodičovi s neurčitou výškou
            flex-basis 0% prebije `height`, sekcia sa zmrští na obsah a plocha
            valca (iba absolútne karty) má 0 px → overflow:hidden orezal všetko.
            Výška je v .dash-screen (100vh fallback + 100dvh, app/globals.css). */}
        <section
          className="dash-screen flex w-full min-w-0 flex-none flex-col overflow-hidden px-4 pb-2 sm:px-6 lg:flex-1 lg:px-8 lg:pb-6"
          style={{ paddingTop: "calc(var(--esblu-safe-top, 0px) + 12px)" }}
        >
          {/* Hlavička: firma (sekundárne) + pozdrav, logo firmy alebo Esblu znak. */}
          <div className="flex shrink-0 items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5">
              {companyLogoUrl ? (
                <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-subtle bg-surface-1">
                  <img
                    src={companyLogoUrl}
                    alt={`Logo ${companyName}`}
                    className="h-full w-full object-contain"
                  />
                </div>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src="/icons/icon-192.png" alt="" aria-hidden="true" className="h-9 w-9 shrink-0 rounded-lg" />
              )}

              <div className="min-w-0">
                <p className="truncate text-[11px] font-medium leading-4 text-muted-esblu">{companyName}</p>
                <h2 className="truncate text-[15px] font-semibold leading-5 text-primary lg:text-lg">{greeting}</h2>
              </div>
            </div>

            {/* Mobile M1: v natívnej appke je navigácia v spodnej lište
                (MobileTabBar) — druhé menu (hamburger) by ju duplikovalo. */}
            {!IS_MOBILE_BUILD && (
              <button
                type="button"
                aria-label={t("dashboard.openMenu")}
                onClick={() => setMenuOpen(true)}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-doc border border-subtle bg-surface-1 text-secondary transition hover:bg-surface-hover hover:text-primary lg:hidden"
              >
                <HamburgerIcon />
              </button>
            )}
          </div>

          {/* Search — KOREKCIA v3: jednoduchá tmavá pilulka priamo na pozadí
              namiesto ďalšej "surface-card" krabice, menej rámov na
              obrazovke. */}
          <div className="mt-3 flex min-h-10 shrink-0 items-center gap-2 rounded-doc border border-subtle bg-surface-1/80 py-1 pl-3 pr-1 transition focus-within:border-brand-400 lg:mt-4 lg:max-w-2xl">
            <SearchIcon />
            <input
              value={search}
              onChange={(e) => {
                // Písanie = ručný režim: hlasová relácia sa ukončí.
                if (voice.active) voice.stop("manual");
                voiceHandledTextRef.current = null;
                setSearch(e.target.value);
                setVoiceTranscript(null);
              }}
              placeholder={t("dashboard.searchPlaceholder")}
              className="w-full min-w-0 bg-transparent text-sm text-primary outline-none placeholder:text-muted-esblu"
            />
            <VoiceSessionControl
              variant="icon"
              session={voice.session}
              onTap={voice.tap}
              onStop={() => voice.stop("user")}
              canOpenSettings={voice.canOpenSettings}
              onOpenSettings={voice.openSettings}
            />
          </div>

          {voiceStatusText && (
            <p aria-live="polite" className={`mt-2 flex items-center gap-2 text-xs font-semibold ${voice.session.status === "listening" ? "text-danger" : "text-muted-esblu"}`}>
              {voice.session.status === "listening" && <span className="h-2 w-2 animate-pulse rounded-full bg-danger" />}
              {voiceStatusText}
            </p>
          )}
          {voiceTranscript && search === voiceTranscript && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <p className="text-[11px] text-muted-esblu">
                {t("search.voice.ui.transcript")}: „{voiceTranscript}“
              </p>
              <VoiceReplyToggle />
            </div>
          )}

          {query && (
            <div className="mt-3 min-h-0 flex-1 space-y-2.5 overflow-y-auto pb-4">
              {/* Intent Engine panel — beží NAD existujúcim substring
                  zoznamom nižšie (žiadne "loading" prekrytie existujúcich
                  výsledkov), ale keď má POUŽITEĽNÝ výsledok (nie
                  not_found/error), legacy panel pod ním sa vôbec
                  nevyrenderuje — pozri `hasUsableIntentResult` vyššie —
                  aby appka nikdy súčasne netvrdila "našlo sa" aj "nič sa
                  nenašlo". */}
              {hasUsableIntentResult && intentResult?.kind === "clarify" ? (
                // Otázka dialógu faktúry. Odpovedá sa hlasom (mikrofón vyššie);
                // kandidáti sú iba na prečítanie — výber vyhodnocuje server.
                <div className="rounded-doc border border-subtle bg-surface-1 p-3 text-sm text-primary">
                  <p className="font-medium">{intentResult.question}</p>
                  {intentResult.choices && intentResult.choices.length > 0 && (
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-secondary">
                      {intentResult.choices.map((choice) => (
                        <li key={choice.value}>{choice.label}</li>
                      ))}
                    </ul>
                  )}
                  <QuickReplies replies={intentResult.quickReplies} onQuickReply={sendQuickReply} />
                </div>
              ) : hasUsableIntentResult ? (
                <IntentResultView
                  intentResult={intentResult}
                  actionSubmitting={actionSubmitting}
                  onConfirm={() => {
                    // Ťuknutie = ručný zásah; relácia skončí (mikrofón nepočúva popri zápise).
                    if (voice.active) voice.stop("manual");
                    void handleActionConfirm();
                  }}
                  onCancel={() => {
                    if (voice.active) voice.stop("manual");
                    handleActionCancel();
                  }}
                  onQuickReply={sendQuickReply}
                />
              ) : query.length >= 2 && intentLoading ? (
                <p className="text-xs font-medium text-muted-esblu">
                  {t("search.ui.loading")}
                </p>
              ) : null}

              {!hasUsableIntentResult && isVoiceQuery ? (
                // Hlas: iba veta asistenta (alebo počas spracovania nič).
                intentResult && (intentResult.kind === "not_found" || intentResult.kind === "error") ? (
                  <p className="rounded-doc border border-subtle bg-surface-1 p-3 text-sm text-secondary">
                    {intentResult.text}
                  </p>
                ) : null
              ) : !hasUsableIntentResult &&
                (searchResults.length === 0 ? (
                  <p className="rounded-doc border border-subtle bg-surface-1 p-3 text-sm text-secondary">
                    {/* Konkrétna veta asistenta („Stroj „Aman“ sa nenašiel.",
                        odmietnutie) má prednosť pred všeobecným „Nič sa
                        nenašlo." — inak používateľ nevie, čo sa stalo. */}
                    {intentResult && (intentResult.kind === "not_found" || intentResult.kind === "error") && query.length >= 2
                      ? intentResult.text
                      : t("dashboard.noResults")}
                  </p>
                ) : (
                  searchResults.map((result, index) => (
                    <AppLink
                      key={index}
                      href={result.href}
                      className="surface-card-hover block rounded-doc border border-subtle bg-surface-1 px-3.5 py-2.5 transition"
                    >
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-brand-300">
                        {result.type}
                      </p>
                      <p className="mt-0.5 text-sm font-semibold text-primary">
                        {result.title}
                      </p>
                      <p className="text-sm text-secondary">{result.subtitle}</p>
                    </AppLink>
                  ))
                ))}
            </div>
          )}

          {!query && (
            <div className="mt-2 flex min-h-0 flex-1 gap-6 lg:mt-4">
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                {/* Termíny STK/EK/známky: na telefóne kompaktný pruh nad valcom
                    (rozbalí zoznam), na desktope bočný panel. Iba ak niečo hrozí. */}
                {alerts.length > 0 && (
                  <div className="mb-1 shrink-0 lg:hidden">
                    <button
                      type="button"
                      onClick={() => setAlertsOpen((open) => !open)}
                      aria-expanded={alertsOpen}
                      className="flex min-h-9 w-full items-center gap-2 rounded-doc border border-warning/25 bg-warning-soft px-3 text-left text-[13px] font-medium text-warning"
                    >
                      <span aria-hidden="true" className="flex h-5 w-5 items-center justify-center rounded-full bg-warning/20 text-[11px] font-bold">!</span>
                      <span className="min-w-0 flex-1 truncate">{t("dashboard.stkEkTitle")} · {alerts.length}</span>
                      <span className="text-xs">{alertsOpen ? t("dashboard.cylinder.hideAll") : t("dashboard.cylinder.showAll")}</span>
                    </button>
                    {alertsOpen && (
                      <div className="mt-1 max-h-40 overflow-y-auto rounded-doc border border-subtle bg-surface-1 px-3 py-1">
              <div className="divide-y divide-[color:var(--color-divider)]">
                {alerts.map((alert, index) => {
                  const isOverdue = alert.level === "red";

                  return (
                    <Link
                      key={index}
                      href={vehicleDetailHref(alert.vehicleId)}
                      className="flex items-center gap-3 rounded-lg py-2 -mx-2 px-2 transition cursor-pointer hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                    >
                      <span
                        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                          isOverdue
                            ? "bg-danger-soft text-danger"
                            : "bg-warning-soft text-warning"
                        }`}
                        aria-hidden="true"
                      >
                        !
                      </span>

                      <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-primary">
                        {alert.message}
                      </p>

                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                          isOverdue
                            ? "bg-danger-soft text-danger"
                            : "bg-warning-soft text-warning"
                        }`}
                      >
                        {alert.type}
                      </span>
                    </Link>
                  );
                })}
              </div>
                      </div>
                    )}
                  </div>
                )}

                <ModuleCylinder
                  modules={cylinderModules}
                  variant={cylinderVariant}
                  large={largeDashboard}
                  onNavigate={(href) => router.push(href)}
                  onLockedAction={() => router.push("/kontakt")}
                  labels={{
                    region: t("dashboard.cylinder.regionLabel"),
                    previous: t("dashboard.cylinder.previous"),
                    next: t("dashboard.cylinder.next"),
                    position: (index, count) => t("dashboard.cylinder.position", { index, count }),
                    slide: (name, index, count) => t("dashboard.cylinder.slideLabel", { name, index, count }),
                    open: t("dashboard.cylinder.open"),
                    lockedBadge: t("dashboard.cylinder.lockedBadge"),
                    requestActivation: t("dashboard.cylinder.requestActivation"),
                    lockedHint: t("dashboard.cylinder.lockedHint"),
                    hint: t("dashboard.cylinder.hint"),
                  }}
                />
              </div>

              {alerts.length > 0 && (
                <aside className="hidden w-80 shrink-0 flex-col overflow-hidden lg:flex" aria-label={t("dashboard.stkEkTitle")}>
                  <div className="surface-card flex min-h-0 flex-col p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <h3 className="text-[15px] font-semibold text-primary">{t("dashboard.stkEkTitle")}</h3>
                        <p className="mt-0.5 text-xs text-muted-esblu">{t("dashboard.stkEkDescription")}</p>
                      </div>
                      <span className="shrink-0 rounded-full px-2 py-0.5 text-xs font-bold badge-danger">{alerts.length}</span>
                    </div>
                    <div className="mt-2 min-h-0 overflow-y-auto">
              <div className="divide-y divide-[color:var(--color-divider)]">
                {alerts.map((alert, index) => {
                  const isOverdue = alert.level === "red";

                  return (
                    <Link
                      key={index}
                      href={vehicleDetailHref(alert.vehicleId)}
                      className="flex items-center gap-3 rounded-lg py-2 -mx-2 px-2 transition cursor-pointer hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                    >
                      <span
                        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                          isOverdue
                            ? "bg-danger-soft text-danger"
                            : "bg-warning-soft text-warning"
                        }`}
                        aria-hidden="true"
                      >
                        !
                      </span>

                      <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-primary">
                        {alert.message}
                      </p>

                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                          isOverdue
                            ? "bg-danger-soft text-danger"
                            : "bg-warning-soft text-warning"
                        }`}
                      >
                        {alert.type}
                      </span>
                    </Link>
                  );
                })}
              </div>
                    </div>
                  </div>
                </aside>
              )}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function SideLink({
  href,
  label,
  image,
  icon,
  badge,
  active = false,
  onNavigate,
}: {
  href: string;
  label: string;
  image?: string;
  icon?: ReactNode;
  badge?: number;
  active?: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      className={`flex items-center gap-2.5 rounded-lg border-l-2 py-1.5 pr-3 text-[13px] font-medium transition ${
        active
          ? "border-brand-400 pl-[10px] text-brand-300"
          : "border-transparent pl-[10px] text-secondary hover:border-border-strong hover:text-primary"
      }`}
    >
      <div
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${
          active ? "bg-brand-500/15" : "bg-surface-2"
        }`}
      >
        {icon ??
          (image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={image}
              alt=""
              aria-hidden="true"
              className="h-5 w-5 object-contain"
            />
          ) : null)}
      </div>

      <span className="min-w-0 flex-1 truncate">{label}</span>

      {!!badge && badge > 0 && (
        <span className="badge-danger shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold">
          {badge}
        </span>
      )}
    </Link>
  );
}

function IconBase({
  children,
  size = 22,
}: {
  children: ReactNode;
  size?: number;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

function MenuIcon() {
  return (
    <IconBase size={20}>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </IconBase>
  );
}

function HamburgerIcon() {
  return (
    <IconBase size={20}>
      <path d="M4 6h16" />
      <path d="M4 12h16" />
      <path d="M4 18h16" />
    </IconBase>
  );
}

function LogoutIcon() {
  return (
    <IconBase size={20}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </IconBase>
  );
}

function SearchIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-muted-esblu" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}

/** Identifikátor dialógu (32 hex znakov — tvar overuje server aj databáza). */
function newDashboardConversationId(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
