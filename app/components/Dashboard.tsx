"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { getCompanyProfile, getMyActiveMembership } from "@/lib/company";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import ModuleCard, { type ModuleAccent } from "./ModuleCard";
import InboxDocumentIcon from "./icons/InboxDocumentIcon";
import type { VehicleVignette } from "@/lib/vehicle-vignettes";
import { vehicleDetailHref } from "@/lib/entity-links";
import { buildLegacyDashboardAlerts } from "@/lib/deadlines";
import { apiUrl } from "@/lib/api-url";
import { REQUEST_LOCALE_HEADER } from "@/lib/i18n/request-locale";
import { MAX_RECORDING_SECONDS } from "@/lib/voice-config";
import type { IntentResult } from "@/lib/intents/types";

function getGreeting(t: (key: string) => string) {
  const hour = new Date().getHours();

  if (hour >= 5 && hour < 12) return t("dashboard.greetingMorning");
  if (hour >= 12 && hour < 18) return t("dashboard.greetingAfternoon");
  if (hour >= 18 && hour < 22) return t("dashboard.greetingEvening");

  return t("dashboard.greetingNight");
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
  const [search, setSearch] = useState("");
  // Intent Engine (app/api/assistant/intent) — samostatný stav od
  // existujúceho plain-substring searchResults nižšie, aby sa pri
  // nerozpoznanom texte appka bezo zmeny vrátila na pôvodné správanie
  // (zadanie: "Search UX preferujúci centrálne pole" — JEDNO pole, dve
  // vrstvy výsledkov, žiadna duplicitná UI).
  const [intentResult, setIntentResult] = useState<IntentResult | null>(null);
  const [intentLoading, setIntentLoading] = useState(false);
  // Hlasové vyhľadávanie (zadanie, sekcia B/C) — TENKÁ vstupná vrstva NAD
  // existujúcim Intent Enginom vyššie: mikrofón iba naplní `search` presne
  // tak, ako keby používateľ text napísal (spustí ten istý debounced efekt
  // nižšie), nikdy nevolá vlastný parser/handler. "processing" = záznam sa
  // odosiela na prepis (app/api/assistant/transcribe), nie na Intent
  // Engine — tam sa transkript posiela až AKO OBYČAJNÝ TEXT.
  const [voiceState, setVoiceState] = useState<"idle" | "recording" | "processing" | "error">(
    "idle"
  );
  const [voiceError, setVoiceError] = useState<string | null>(null);
  // Naposledy vložený prepis — zobrazí sa ako krátka "Prepis: …" poznámka
  // (bod C zadania: "zobraz prepis po spracovaní"), zmizne hneď, ako
  // používateľ pole ručne upraví (pozri onChange pri <input> nižšie).
  const [voiceTranscript, setVoiceTranscript] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // RUNTIME BUG FIX (max recording duration audit): ID aktuálne prebiehajúcej
  // nahrávky. Každé volanie startVoiceRecording() si vytvorí VLASTNÉ ID a
  // uzavrie ho v closure svojho 20 s časovača aj svojho getUserMedia
  // pokračovania. Predtým, ak by (napr. rýchly dvojklik na mikrofón, kým
  // prehliadač ešte čakal na povolenie mikrofónu) vznikli dve prekrývajúce
  // sa nahrávky, druhá by potichu PREPÍSALA recordingTimeoutRef/
  // mediaRecorderRef prvej — časovač prvej nahrávky by tak "osirel" a mohol
  // by neskôr chybne ukončiť aktuálnu (aj krátku) nahrávku ako "príliš
  // dlhú". Kontrola ID namiesto spoliehania sa na to, že clearTimeout()
  // vždy prebehne na správnom mieste, zaručuje, že STARÝ časovač/callback
  // NIKDY nezasiahne NOVŠIU nahrávku, aj keby nejaký clearTimeout() volanie
  // niekde chýbalo.
  const recordingSessionIdRef = useRef(0);
  // Čisto diagnostický (bod 7 zadania) — ukladá DÔVOD posledného ukončenia
  // nahrávky pre bezpečné console.log ladenie, nikdy sa nepoužíva na
  // rozhodovanie o stave.
  const lastStopReasonRef = useRef<"manual" | "timeout" | "cancel" | "unmount" | null>(null);
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
      // Bez aktívneho membershipu niet "firmy", ktorej branding by sa dal
      // načítať (esblu_get_company_profile by aj tak nič nevrátila) —
      // ostáva dnešný generický fallback ("ESBLU", žiadne logo).
      return;
    }

    loadData(membership.company_id);
    loadCompanyProfile();
  }

  async function logout() {
    await supabase.auth.signOut();
    router.push("/login");
  }

  // Firemný názov + logo pre AKTÍVNEHO ČLENA firmy (owner/admin/employee
  // rovnako) — nie z vlastného, väčšinou prázdneho settings riadku
  // prihláseného používateľa. Pozri lib/company.ts a
  // supabase/migrations/20260814180000_add_company_profile_rpc.sql /
  // 20260814190000_fix_company_profile_rpc.sql.
  //
  // Bezpečnostná poistka proti regresii (pridané po nahlásenej chybe, kde
  // fallback ESBLU videl aj owner): ak RPC z akéhokoľvek dôvodu (napr.
  // migrácia ešte nie je aplikovaná na danom prostredí) nevráti žiadny
  // profil, skús ako druhý krok priamo vlastný settings riadok
  // prihláseného používateľa — presne to, čo appka robila PRED zavedením
  // esblu_get_company_profile(). Pre ownera/admina, ktorí majú firemné
  // údaje uložené vo svojom vlastnom riadku, sa tým hlavička obnoví aj bez
  // funkčného RPC. Pre employee je vlastný riadok bežne prázdny, takže sa
  // tu nič neprezradí — v tom prípade jednoducho ostane fallback.
  async function loadCompanyProfile() {
    let profile = await getCompanyProfile();

    if (!profile?.company_name && !profile?.logo_path) {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (session) {
        const { data: ownSettings } = await supabase
          .from("settings")
          .select("company_name, logo_path")
          .eq("user_id", session.user.id)
          .maybeSingle();

        if (ownSettings?.company_name || ownSettings?.logo_path) {
          profile = ownSettings;
        }
      }
    }

    if (profile?.company_name) {
      setCompanyName(profile.company_name);
    }

    if (profile?.logo_path) {
      const { data: logoData } = supabase.storage
        .from("company-logos")
        .getPublicUrl(profile.logo_path);

      setCompanyLogoUrl(logoData.publicUrl);
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
            href: `/vozidla/${v.id}`,
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
            href: `/stroje/${m.id}`,
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
            href: `/sklad/${i.id}`,
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
          body: JSON.stringify({ text: trimmed }),
        });

        const data = await response.json();

        if (cancelled) return;

        if (response.ok && data.success && data.recognized) {
          setIntentResult(data.result as IntentResult);
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
  }, [search, locale]);

  // Bezpečné zastavenie mikrofónu pri odmountovaní komponentu (napr. odchod
  // zo stránky počas nahrávania) — nikdy nenecháva otvorený audio stream na
  // pozadí (bod D zadania: žiadne "visiace" nahrávanie).
  useEffect(() => {
    return () => {
      recordingSessionIdRef.current += 1;
      lastStopReasonRef.current = "unmount";
      if (recordingTimeoutRef.current) clearTimeout(recordingTimeoutRef.current);
      recordingTimeoutRef.current = null;
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.stream.getTracks().forEach((track) => track.stop());
        recorder.stop();
      }
    };
  }, []);

  // -----------------------------------------------------------------------------
  // Hlasové vyhľadávanie (zadanie, sekcia B/C/D/E/G) — READ-ONLY, prvá
  // verzia: VOICE → audio → prepis (server) → PRESNE TEN ISTÝ text ako pri
  // písaní → ten istý debounced Intent Engine efekt vyššie. Žiadny nový
  // parser, žiadny nový handler, žiadne automatické spúšťanie akcie bez
  // spoľahlivého prepisu.
  //
  // Web API (getUserMedia/MediaRecorder) — funguje rovnako na desktop webe
  // aj mobile browseri; v Android Capacitor WebView appke (mobile/) funguje
  // BEZO ZMENY vďaka tomu, že mobile/app/* sú čisté re-exporty root app/*
  // (pozri mobile/tsconfig.json `"@/*": ["../*"]`) — jediná potrebná
  // natívna zmena je android.permission.RECORD_AUDIO v AndroidManifest.xml
  // (Capacitor WebView beží nad lokálnym https://localhost schémou, takže
  // getUserMedia už dnes beží v bezpečnom kontexte bez ďalšej konfigurácie
  // — pozri report, sekcia E).
  // -----------------------------------------------------------------------------

  function stopMediaRecorderTracks(recorder: MediaRecorder) {
    recorder.stream.getTracks().forEach((track) => track.stop());
  }

  // Spoločné vyčistenie refs pre KAŽDÉ ukončenie nahrávky (manuálny stop,
  // cancel, timeout, unmount) — jedno miesto namiesto duplicitnej logiky na
  // 4 rôznych miestach, aby sa nemohlo stať, že niektorá cesta vynechá
  // clearTimeout()/vynulovanie refs (bod zadania: "či sa duration nemeria
  // chybne cez stale state", "či sa 'too long' flag neuchováva medzi
  // nahrávkami").
  function resetVoiceRecordingRefs(reason: "manual" | "timeout" | "cancel") {
    lastStopReasonRef.current = reason;
    // Zvýšenie ID okamžite zneplatní AKÝKOĽVEK inak naplánovaný 20s
    // časovač patriaci tejto (teraz končiacej) nahrávke — aj v
    // hypotetickom prípade, že by nižšie clearTimeout() z nejakého dôvodu
    // nezasiahol správny timer.
    recordingSessionIdRef.current += 1;
    if (recordingTimeoutRef.current) {
      clearTimeout(recordingTimeoutRef.current);
      recordingTimeoutRef.current = null;
    }
    audioChunksRef.current = [];
    mediaRecorderRef.current = null;
  }

  async function startVoiceRecording() {
    setVoiceError(null);
    setVoiceTranscript(null);

    if (
      typeof window === "undefined" ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      setVoiceState("error");
      setVoiceError(t("search.voice.errors.notSupported"));
      return;
    }

    // RUNTIME BUG FIX (max recording duration audit): ak by tu z nejakého
    // dôvodu ešte "visela" predchádzajúca nahrávka/časovač (napr. rýchly
    // dvojklik na mikrofón, kým prehliadač ešte čakal na povolenie
    // mikrofónu pre PRVÝ klik), táto nová nahrávka ju najprv čisto ukončí
    // — inak by starý 20s časovač mohol neskôr omylom ukončiť TÚTO
    // (aj krátku) nahrávku ako "príliš dlhú".
    if (mediaRecorderRef.current || recordingTimeoutRef.current) {
      resetVoiceRecordingRefs("cancel");
    }

    // Každá nahrávka dostane VLASTNÉ ID — 20s časovač aj pokračovanie po
    // getUserMedia si ho uzavrú v closure a pred akoukoľvek zmenou stavu
    // overia, že toto ID je STÁLE aktuálne (nespolieha sa na React state,
    // ktorý môže byť v momente async pokračovania už stale — bod zadania).
    const sessionId = ++recordingSessionIdRef.current;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Medzičasom (kým prehliadač čakal na povolenie mikrofónu) mohol
      // používateľ túto nahrávku stihnúť zrušiť alebo spustiť inú novšiu —
      // ak toto ID už nie je aktuálne, táto oneskorená vetva sa potichu
      // vzdá namiesto toho, aby prevzala kontrolu nad stavom novšej
      // nahrávky.
      if (recordingSessionIdRef.current !== sessionId) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      const preferredMimeType = ["audio/webm", "audio/mp4", "audio/ogg"].find(
        (type) =>
          typeof MediaRecorder.isTypeSupported === "function" &&
          MediaRecorder.isTypeSupported(type)
      );
      const recorder = preferredMimeType
        ? new MediaRecorder(stream, { mimeType: preferredMimeType })
        : new MediaRecorder(stream);

      audioChunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setVoiceState("recording");

      // Klientska poistka pre max dĺžku nahrávky (bod D zadania) — po
      // uplynutí limitu appka záznam ZAHODÍ (neposiela na prepis) a ukáže
      // jasnú chybu, namiesto tichého odoslania orezanej nahrávky.
      recordingTimeoutRef.current = setTimeout(() => {
        // Poistka proti "osirelému" časovaču: ak medzitým prebehol
        // manuálny stop/cancel (čo VŽDY zvýši recordingSessionIdRef cez
        // resetVoiceRecordingRefs) alebo dokonca začala celkom NOVÁ
        // nahrávka, toto ID už nie je aktuálne — starý časovač sa NESMIE
        // dotknúť aktuálneho stavu.
        if (recordingSessionIdRef.current !== sessionId) {
          console.log("[voice] osirelý 20s časovač ignorovaný (nahrávka už skončila inak)");
          return;
        }
        console.log("[voice] 20s limit dosiahnutý, nahrávka sa zahadzuje");
        handleRecordingTooLong();
      }, MAX_RECORDING_SECONDS * 1000);
    } catch (error) {
      if (recordingSessionIdRef.current === sessionId) {
        console.error("Nahrávanie hlasu zlyhalo:", error);
        setVoiceState("error");
        setVoiceError(t("search.voice.errors.micNotAllowed"));
      }
    }
  }

  function handleRecordingTooLong() {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.onstop = () => stopMediaRecorderTracks(recorder);
      recorder.stop();
    }
    resetVoiceRecordingRefs("timeout");
    setVoiceState("error");
    setVoiceError(t("search.voice.errors.recordingTooLong"));
  }

  function cancelVoiceRecording() {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      // Zrušenie zámerne NEPOSIELA žiadny transkript — iba zastaví
      // nahrávanie a zahodí zvuk (bod C zadania: "umožni stop/cancel").
      recorder.onstop = () => stopMediaRecorderTracks(recorder);
      recorder.stop();
    }
    resetVoiceRecordingRefs("cancel");
    setVoiceState("idle");
  }

  async function stopVoiceRecording() {
    // Timer sa ruší HNEĎ na začiatku, PRED čímkoľvek iným — a session ID sa
    // zvyšuje zároveň, takže aj v hypotetickom prípade, že by clearTimeout()
    // z nejakého dôvodu nestihol/nezasiahol správny timer, samotný 20s
    // callback nižšie (pozri startVoiceRecording) by sa aj tak sám odmietol
    // spustiť, lebo by už nesedelo jeho zachytené ID.
    lastStopReasonRef.current = "manual";
    recordingSessionIdRef.current += 1;
    if (recordingTimeoutRef.current) {
      clearTimeout(recordingTimeoutRef.current);
      recordingTimeoutRef.current = null;
    }
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return;

    setVoiceState("processing");

    // RUNTIME BUG FIX: celý zvyšok tejto funkcie (predtým iba časť od
    // fetch nižšie) je teraz v try/catch. Predtým, ak `recorder.stop()`
    // alebo čakanie na "stop" event zlyhalo/vyhodilo výnimku, appka
    // zostala navždy "zamrznutá" v stave "processing" — search pole sa
    // nenaplnilo A ZÁROVEŇ sa nezobrazila žiadna chyba, presne ako v
    // nahlásenom produkčnom bugu.
    try {
      // Na časti reálnych mobilných prehliadačov (najmä staršie
      // Android WebView) sa stáva, že MediaRecorder po stop() nikdy
      // nevyšle "stop" event (napr. keď OS medzitým ukončí audio
      // stream na pozadí). Bez časového limitu by appka na tento
      // event čakala navždy. Ak limit vyprší, pokračuje sa s chunkami,
      // ktoré už prišli cez ondataavailable (recorder.stop() finálny
      // dataavailable vyžiada ešte pred vypršaním tohto limitu).
      const stopped = new Promise<void>((resolve) => {
        recorder.addEventListener("stop", () => resolve(), { once: true });
      });
      recorder.stop();
      await Promise.race([
        stopped,
        new Promise<void>((resolve) => setTimeout(resolve, 4000)),
      ]);
      stopMediaRecorderTracks(recorder);

      const mimeType = recorder.mimeType || "audio/webm";
      const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
      audioChunksRef.current = [];
      mediaRecorderRef.current = null;

      // Bezpečný diagnostický log (zadanie, bod 7) — VÝHRADNE metadáta
      // nahrávky, NIKDY obsah audia/prepisu.
      console.log("[voice] nahrávka ukončená:", {
        stopReason: lastStopReasonRef.current,
        mimeType: recorder.mimeType,
        blobSize: audioBlob.size,
        blobType: audioBlob.type,
      });

      if (audioBlob.size === 0) {
        setVoiceState("error");
        setVoiceError(t("search.voice.errors.noAudio"));
        return;
      }

      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        setVoiceState("error");
        setVoiceError(t("search.voice.errors.transcriptionFailed"));
        return;
      }

      const extension = mimeType.includes("mp4")
        ? "mp4"
        : mimeType.includes("ogg")
          ? "ogg"
          : mimeType.includes("wav")
            ? "wav"
            : "webm";
      const voiceFormData = new FormData();
      voiceFormData.append("audio", audioBlob, `voice-command.${extension}`);

      const response = await fetch(apiUrl("/api/assistant/transcribe"), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          [REQUEST_LOCALE_HEADER]: locale,
        },
        body: voiceFormData,
      });

      // `.json()` môže zlyhať, ak server vráti neočakávané telo (napr.
      // platformová HTML chybová stránka pri 5xx) — bez `.catch` by táto
      // výnimka predtým unikla mimo vonkajší try/catch a appka by opäť
      // ostala ticho "zamrznutá".
      const data = await response.json().catch(() => null);

      console.log("[voice] odpoveď prepisu:", {
        status: response.status,
        success: data?.success,
        errorCode: data?.success ? undefined : data?.error,
      });

      if (!response.ok || !data?.success || typeof data.text !== "string" || !data.text) {
        setVoiceState("error");
        setVoiceError(
          typeof data?.error === "string"
            ? data.error
            : t("search.voice.errors.transcriptionFailed")
        );
        return;
      }

      // Transkript sa vloží do PRESNE TOHO ISTÉHO textového poľa ako pri
      // písaní (zadanie, sekcia G) — spustí ten istý debounced Intent
      // Engine efekt vyššie, žiadna samostatná hlasová logika.
      setSearch(data.text);
      setVoiceTranscript(data.text);
      setVoiceState("idle");
    } catch (error) {
      console.error("Prepis hlasu zlyhal:", error);
      setVoiceState("error");
      setVoiceError(t("search.voice.errors.transcriptionFailed"));
    }
  }

  function handleMicButtonClick() {
    if (voiceState === "recording") {
      stopVoiceRecording();
    } else if (voiceState === "idle" || voiceState === "error") {
      startVoiceRecording();
    }
  }

  // ZVÄČŠENIE IKON (KOREKCIA v5): imageZoom kompenzuje vnútorný priehľadný
  // okraj rastrových produktových fotiek (van/excavator/warehouse), aby po
  // novej výraznejšej Inbox SVG ikone pôsobili moduly vizuálne vyvážene —
  // pozri komentár pri ModuleCard. Hodnoty sú kalibrované na základe
  // zmeranej polohy motívu v jednotlivých .png (percento auditu, nie
  // odhad): van ~72 %/61 % vyplnenia rámu → miernejší zoom (1.2), excavator
  // ~43 %/64 % → 1.6, warehouse ~45 %/49 % → 1.7 (najviac priehľadného
  // okraja, preto najväčší dopočet). Každá hodnota ostáva bezpečne pod
  // hranicou, pri ktorej by orez orezal samotný motív (min. nameraný okraj
  // motívu vs. skutočne použitý orez má rezervu min. ~3 percentuálne
  // body). Nastavenia (settings.png) a Inbox (SVG icon) imageZoom nemajú —
  // ich vzhľad je nezmenený.
  const modules: {
    title: string;
    subtitle: string;
    stat?: string;
    href: string;
    image?: string;
    imageZoom?: number;
    icon?: ReactNode;
    accent: ModuleAccent;
  }[] = [
    {
      title: t("nav.inbox"),
      subtitle: t("dashboard.moduleInboxSubtitle"),
      href: "/ai-evidencia",
      icon: <InboxDocumentIcon size={56} className="h-11 w-11 sm:h-14 sm:w-14" />,
      accent: "cyan",
    },
    {
      title: t("nav.vehicles"),
      subtitle: t("dashboard.moduleVehiclesSubtitle"),
      stat: String(vehicles.length),
      href: "/vozidla",
      image: "/images/van.png",
      imageZoom: 1.2,
      accent: "blue",
    },
    {
      title: t("nav.machines"),
      subtitle: t("dashboard.moduleMachinesSubtitle"),
      stat: String(machines.length),
      href: "/stroje",
      image: "/images/excavator.png",
      imageZoom: 1.6,
      accent: "orange",
    },
    {
      title: t("nav.inventory"),
      subtitle: t("dashboard.moduleInventorySubtitle"),
      stat: String(items.length),
      href: "/sklad",
      image: "/images/warehouse.png",
      imageZoom: 1.7,
      accent: "teal",
    },
    {
      title: t("nav.settings"),
      subtitle: t("dashboard.moduleSettingsSubtitle"),
      href: "/nastavenia",
      image: "/images/settings.png",
      accent: "blue",
    },
  ];

  // Spoločný zoznam navigačných položiek pre desktop sidebar AJ mobilné
  // výsuvné menu (jeden zdroj pravdy, žiadna duplicita odkazov/ciest).
  const navItems: {
    href: string;
    label: string;
    image?: string;
    icon?: ReactNode;
    badge?: number;
  }[] = [
    { href: "/ai-evidencia", label: t("nav.inbox"), icon: <InboxDocumentIcon size={20} /> },
    { href: "/vozidla", label: t("nav.vehicles"), image: "/images/van.png" },
    { href: "/stroje", label: t("nav.machines"), image: "/images/excavator.png" },
    { href: "/sklad", label: t("nav.inventory"), image: "/images/warehouse.png" },
    { href: "/nastavenia", label: t("nav.settings"), image: "/images/settings.png" },
  ];

  // Kompaktný panel pre rozpoznaný Intent Engine výsledok (zadanie, bod 13:
  // "Ak intent znamená navigáciu → naviguj [na klik, nie automaticky pri
  // písaní]. Ak ide o odpoveď → zobraz compact result panel. Ak je
  // nejednoznačné → výber. Ak permission denied → jasná bezpečná chyba.").
  // Vracia null, ak niet čo zobraziť — volajúci potom padne na existujúci
  // plain-substring searchResults panel bezo zmeny.
  function renderIntentResult() {
    if (!intentResult) return null;

    const cardClass =
      "surface-card-hover block rounded-2xl border border-subtle bg-surface-1/60 p-4 transition";
    const boxClass =
      "rounded-2xl border border-subtle bg-surface-1/60 p-4 text-sm text-secondary";

    switch (intentResult.kind) {
      case "navigate":
        return (
          <Link href={intentResult.entity.href} className={cardClass}>
            <p className="text-xs font-bold uppercase tracking-wide text-accent-cyan">
              {t("search.ui.openAction")}
            </p>
            <p className="mt-1 text-base font-bold text-primary">
              {intentResult.entity.label}
            </p>
          </Link>
        );

      case "answer":
        return (
          <div className={boxClass}>
            <p className="text-sm font-medium text-primary">{intentResult.text}</p>
            {intentResult.entity && (
              <Link
                href={intentResult.entity.href}
                className="mt-2 inline-block text-xs font-bold uppercase tracking-wide text-accent-cyan"
              >
                {intentResult.entity.label} →
              </Link>
            )}
          </div>
        );

      case "report":
        return (
          <div className="rounded-2xl border border-subtle bg-surface-1/60 p-4">
            <Link
              href={intentResult.entity.href}
              className="text-xs font-bold uppercase tracking-wide text-accent-cyan"
            >
              {intentResult.entity.label} →
            </Link>
            <div className="mt-3 space-y-4">
              {intentResult.sections.map((section) => (
                <div key={section.title}>
                  <p className="text-xs font-bold uppercase tracking-wide text-muted-esblu">
                    {section.title}
                  </p>
                  <div className="mt-1.5 space-y-1">
                    {section.rows.map((row) => (
                      <div key={row.label} className="flex items-center justify-between gap-3 text-sm">
                        <span className="text-secondary">{row.label}</span>
                        <span className="font-semibold text-primary">{row.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );

      case "list":
        return (
          <div className="space-y-2.5">
            <p className="text-xs font-bold uppercase tracking-wide text-muted-esblu">
              {intentResult.title}
            </p>
            {intentResult.items.map((item) => (
              <Link key={item.id} href={item.href} className={cardClass}>
                <p className="text-base font-bold text-primary">{item.label}</p>
              </Link>
            ))}
          </div>
        );

      case "deadline_list":
        if (intentResult.items.length === 0) {
          return <p className={boxClass}>{t("search.ui.noDeadlines")}</p>;
        }
        return (
          <div className="space-y-2.5">
            <p className="text-xs font-bold uppercase tracking-wide text-muted-esblu">
              {intentResult.title}
            </p>
            {intentResult.items.map((item, index) => (
              <Link key={`${item.entity.id}-${index}`} href={item.entity.href} className={cardClass}>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-primary">
                      {item.entity.label}
                    </p>
                    <p className="text-xs text-secondary">
                      {item.typeLabel} — {item.dueDateLabel}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full bg-amber-400/12 px-2.5 py-1 text-[11px] font-bold text-amber-400">
                    {item.severityLabel}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        );

      case "document_list":
        return (
          <div className="space-y-2.5">
            <p className="text-xs font-bold uppercase tracking-wide text-muted-esblu">
              {intentResult.title}
            </p>
            {intentResult.items.map((item, index) => (
              <Link key={`${item.href}-${index}`} href={item.href} className={cardClass}>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-primary">{item.label}</p>
                    <p className="text-xs text-secondary">
                      {item.typeLabel}
                      {item.dateLabel ? ` — ${item.dateLabel}` : ""}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full bg-accent-cyan/12 px-2.5 py-1 text-[11px] font-bold text-accent-cyan">
                    {item.linkLabel}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        );

      case "disambiguate":
        return (
          <div className="space-y-2.5">
            <p className="text-xs font-bold uppercase tracking-wide text-muted-esblu">
              {t("search.ui.multipleMatches")}
            </p>
            {intentResult.candidates.map((candidate) => (
              <Link key={candidate.id} href={candidate.href} className={cardClass}>
                <p className="text-base font-bold text-primary">{candidate.label}</p>
              </Link>
            ))}
          </div>
        );

      case "not_found":
      case "error":
        return <p className={boxClass}>{intentResult.text}</p>;

      default:
        return null;
    }
  }

  return (
    <main className="app-shell-bg relative min-h-screen">
      <div className="relative flex min-h-screen flex-col lg:flex-row">
        {/* Desktop sidebar — KOREKCIA (dashboard v2): užší, plochý a tmavší
            (bez glass/blur efektu), aby nedominoval obrazovke a nepôsobil
            ako klasický enterprise admin panel. */}
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-subtle bg-page-bg-elevated px-5 py-6 lg:flex">
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
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-accent-cyan to-accent-blue shadow-lg">
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

          <nav className="mt-8 flex-1 space-y-1">
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
            className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-semibold text-secondary transition hover:bg-surface-hover hover:text-primary"
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
                className="btn-secondary flex items-center justify-center gap-2 py-3 text-sm"
              >
                <LogoutIcon />
                {t("common.buttons.logout")}
              </button>
            </div>
          </div>
        )}

        <section className="w-full flex-1 px-4 pb-10 pt-5 sm:px-6 lg:px-10 lg:py-12">
          {/* Mobilný horný pruh — brand + hamburger (nahrádza predchádzajúci
              priamy odkaz na Nastavenia). */}
          <div className="flex items-center justify-between gap-4 lg:hidden">
            <div className="flex min-w-0 items-center gap-2.5">
              {companyLogoUrl ? (
                <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full border border-subtle bg-surface-1">
                  <img
                    src={companyLogoUrl}
                    alt={`Logo ${companyName}`}
                    className="h-full w-full object-contain"
                  />
                </div>
              ) : (
                <span className="text-xl">👤</span>
              )}

              <p className="truncate text-sm font-semibold text-secondary">
                {companyName}
              </p>
            </div>

            <button
              type="button"
              aria-label={t("dashboard.openMenu")}
              onClick={() => setMenuOpen(true)}
              className="surface-card surface-card-hover flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-secondary transition"
            >
              <HamburgerIcon />
            </button>
          </div>

          <h2 className="mt-5 text-3xl font-black tracking-tight text-primary lg:mt-0 lg:text-[2.75rem]">
            {greeting}
          </h2>

          {/* Search — KOREKCIA v3: jednoduchá tmavá pilulka priamo na pozadí
              namiesto ďalšej "surface-card" krabice, menej rámov na
              obrazovke. */}
          <div className="mt-6 flex items-center gap-3 rounded-2xl border border-subtle bg-surface-1/60 px-4 py-3.5 lg:mt-9">
            <SearchIcon />
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setVoiceTranscript(null);
              }}
              placeholder={t("dashboard.searchPlaceholder")}
              className="w-full min-w-0 bg-transparent text-base text-primary outline-none placeholder:text-muted-esblu"
            />
            {voiceState === "recording" && (
              <button
                type="button"
                onClick={cancelVoiceRecording}
                className="shrink-0 text-xs font-bold uppercase tracking-wide text-muted-esblu hover:text-primary"
              >
                {t("search.voice.ui.cancel")}
              </button>
            )}
            <button
              type="button"
              aria-label={
                voiceState === "recording"
                  ? t("search.voice.ui.stop")
                  : t("search.voice.ui.startRecording")
              }
              onClick={handleMicButtonClick}
              disabled={voiceState === "processing"}
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition disabled:opacity-50 ${
                voiceState === "recording"
                  ? "bg-red-500/15 text-red-400"
                  : "text-muted-esblu hover:text-primary"
              }`}
            >
              <MicrophoneIcon />
            </button>
          </div>

          {voiceState === "recording" && (
            <p className="mt-2 flex items-center gap-2 text-xs font-semibold text-red-400">
              <span className="h-2 w-2 animate-pulse rounded-full bg-red-400" />
              {t("search.voice.ui.recording")}
            </p>
          )}
          {voiceState === "processing" && (
            <p className="mt-2 text-xs font-medium text-muted-esblu">
              {t("search.voice.ui.processing")}
            </p>
          )}
          {voiceState === "error" && voiceError && (
            <p className="mt-2 text-xs font-medium text-red-400">
              {voiceError}
              {/* "Skúste hovoriť znova" nemá zmysel pri principiálnej
                  nepodpore zariadenia (notSupported) — appka ho preto
                  pripája len pri chybách, kde opakovanie reálne pomôže. */}
              {voiceError !== t("search.voice.errors.notSupported")
                ? ` ${t("search.voice.errors.tryAgain")}`
                : ""}
            </p>
          )}
          {voiceState === "idle" && voiceTranscript && search === voiceTranscript && (
            <p className="mt-2 text-[11px] text-muted-esblu">
              {t("search.voice.ui.transcript")}: „{voiceTranscript}“
            </p>
          )}

          {query && (
            <div className="mt-3 space-y-2.5">
              {/* Intent Engine panel — beží NAD existujúcim substring
                  zoznamom nižšie (žiadne "loading" prekrytie existujúcich
                  výsledkov), ale keď má POUŽITEĽNÝ výsledok (nie
                  not_found/error), legacy panel pod ním sa vôbec
                  nevyrenderuje — pozri `hasUsableIntentResult` vyššie —
                  aby appka nikdy súčasne netvrdila "našlo sa" aj "nič sa
                  nenašlo". */}
              {hasUsableIntentResult ? (
                renderIntentResult()
              ) : query.length >= 2 && intentLoading ? (
                <p className="text-xs font-medium text-muted-esblu">
                  {t("search.ui.loading")}
                </p>
              ) : null}

              {!hasUsableIntentResult &&
                (searchResults.length === 0 ? (
                  <p className="rounded-2xl border border-subtle bg-surface-1/60 p-4 text-sm text-secondary">
                    {t("dashboard.noResults")}
                  </p>
                ) : (
                  searchResults.map((result, index) => (
                    <Link
                      key={index}
                      href={result.href}
                      className="surface-card-hover block rounded-2xl border border-subtle bg-surface-1/60 p-4 transition"
                    >
                      <p className="text-xs font-bold uppercase tracking-wide text-accent-cyan">
                        {result.type}
                      </p>
                      <p className="mt-1 text-base font-bold text-primary">
                        {result.title}
                      </p>
                      <p className="text-sm text-secondary">{result.subtitle}</p>
                    </Link>
                  ))
                ))}
            </div>
          )}

          <div className="mt-9 grid grid-cols-2 gap-3 lg:mt-12 lg:grid-cols-4 lg:gap-4">
            {modules
              .filter((module) => module.title !== t("nav.settings"))
              .map((module) => (
                <ModuleCard
                  key={module.href}
                  href={module.href}
                  title={module.title}
                  subtitle={module.subtitle}
                  stat={module.stat}
                  image={module.image}
                  imageZoom={module.imageZoom}
                  icon={module.icon}
                  accent={module.accent}
                />
              ))}
          </div>

          {/* STK/EK panel — KOREKCIA v3: tmavý status panel s malými
              riadkami (ikona + text + drobný badge vpravo), farba je iba
              akcent na ikone/badge, nie výplň celej položky.
              ZMENA (Intent Engine + automatické upozornenia, bod 9A):
              "žiadny prázdny box, ak nič nehrozí" — panel sa teraz
              renderuje IBA keď existuje aspoň 1 aktívne upozornenie;
              predtým sa vždy zobrazoval aj s "0"/"žiadne upozornenia". */}
          {alerts.length > 0 && (
            <div className="surface-card mt-6 p-5 sm:p-6 lg:mt-8 lg:p-8">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h3 className="text-lg font-bold text-primary sm:text-xl">
                    {t("dashboard.stkEkTitle")}
                  </h3>
                  <p className="mt-1 text-xs text-muted-esblu">
                    {t("dashboard.stkEkDescription")}
                  </p>
                </div>

                <span className="shrink-0 rounded-full px-2.5 py-1 text-xs font-bold badge-danger">
                  {alerts.length}
                </span>
              </div>

              <div className="mt-4 divide-y divide-[color:var(--color-border-subtle)]">
                {alerts.map((alert, index) => {
                  const isOverdue = alert.level === "red";

                  return (
                    <Link
                      key={index}
                      href={vehicleDetailHref(alert.vehicleId)}
                      className="flex items-center gap-3 rounded-lg py-3 -mx-2 px-2 transition cursor-pointer hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan"
                    >
                      <span
                        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                          isOverdue
                            ? "bg-red-400/12 text-red-400"
                            : "bg-amber-400/12 text-amber-400"
                        }`}
                        aria-hidden="true"
                      >
                        !
                      </span>

                      <p className="min-w-0 flex-1 truncate text-sm font-medium text-primary">
                        {alert.message}
                      </p>

                      <span
                        className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold ${
                          isOverdue
                            ? "bg-red-400/12 text-red-400"
                            : "bg-amber-400/12 text-amber-400"
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
      className={`flex items-center gap-3 rounded-lg border-l-2 py-2.5 pr-3 text-sm font-semibold transition ${
        active
          ? "border-accent-cyan pl-[10px] text-accent-cyan"
          : "border-transparent pl-[10px] text-secondary hover:border-border-strong hover:text-primary"
      }`}
    >
      <div
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
          active ? "bg-accent-cyan/12" : "bg-surface-2"
        }`}
      >
        {icon ??
          (image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={image}
              alt=""
              aria-hidden="true"
              className="h-6 w-6 object-contain"
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
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-secondary">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}

function MicrophoneIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <path d="M12 19v3" />
      <path d="M8 22h8" />
    </svg>
  );
}
