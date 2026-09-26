"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { getMyActiveMembership } from "@/lib/company";
import { getMyUnreadCounts } from "@/lib/chat";
import ChatConversationList from "./ChatConversationList";
import ChatMessageView from "./ChatMessageView";
import ChatBubbleIcon from "../icons/ChatBubbleIcon";

// =============================================================================
// Esblu — Globálny plávajúci chat widget
// =============================================================================
// Namontovaný RAZ v app/layout.tsx (jediné miesto v appke, ktoré obaľuje
// VŠETKY stránky — moduly Esblu inak nemajú spoločný layout/sidebar, pozri
// audit v komentári nad <FloatingChatWidget /> v app/layout.tsx). Vďaka tomu
// je dostupný na každej prihlásenej stránke bez duplicitného mountovania.
//
// Panel NIKDY nenaviguje (žiadny router.push/Link na /chat) — celá
// konverzácia beží ako lokálny React stav vo vnútri tohto komponentu, takže
// zatvorenie panelu necháva používateľa presne na stránke, kde bol.
// ChatConversationList aj ChatMessageView sú TIE ISTÉ komponenty ako na
// /chat/[conversationId] (žiadna duplicitná chat logika) — ChatMessageView
// je od začiatku čisto prop-driven (žiadny router/Link vo vnútri), takže sa
// dá použiť bez zmeny; ChatConversationList dostal nový voliteľný prop
// `onSelectConversation`, ktorý ho prepne z Link/router navigácie na
// callback-based výber (pozri komentár v ChatConversationList.tsx).
//
// Poloha bublinky (drag & drop) sa ukladá do localStorage a pri každom
// načítaní/zmene veľkosti okna sa preloží (clamp) tak, aby nikdy nemohla
// skončiť mimo viditeľnej plochy.
// =============================================================================

const BUBBLE_SIZE = 56;
const MARGIN = 16;
const POSITION_STORAGE_KEY = "esblu.chat.bubble.position.v1";
const MOBILE_BREAKPOINT = 640;
const DRAG_THRESHOLD = 5;

// Rovnaký zoznam ako CompanyDpaGate/LegalAcceptanceGate (nezávislá kópia,
// zámerne — pozri odôvodnenie priamo v CompanyDpaGate.tsx) + navyše /chat
// samotné (na plnej /chat stránke je celý chat už na obrazovke, plávajúca
// bublina by bola redundantná/mätúca duplicita rovnakého UI).
const SKIP_PATH_PREFIXES = [
  "/login",
  "/invite",
  "/onboarding",
  "/reset-hesla",
  "/ochrana-osobnych-udajov",
  "/podmienky-pouzivania",
  "/cookies",
  "/dpa",
  "/subprocessors",
  "/kontakt",
  "/cennik",
  "/chat",
];

type Position = { x: number; y: number };

function clampPosition(x: number, y: number): Position {
  if (typeof window === "undefined") return { x, y };

  const maxX = Math.max(MARGIN, window.innerWidth - BUBBLE_SIZE - MARGIN);
  const maxY = Math.max(MARGIN, window.innerHeight - BUBBLE_SIZE - MARGIN);

  return {
    x: Math.min(Math.max(x, MARGIN), maxX),
    y: Math.min(Math.max(y, MARGIN), maxY),
  };
}

function defaultPosition(): Position {
  if (typeof window === "undefined") return { x: MARGIN, y: MARGIN };

  // Pravý dolný roh, s malou extra rezervou dole pre mobilné system bary /
  // home indicator (bez env(safe-area-inset-*) v JS — jednoduchá statická
  // rezerva, panel samotný navyše používa env() priamo v CSS nižšie).
  return clampPosition(
    window.innerWidth - BUBBLE_SIZE - MARGIN,
    window.innerHeight - BUBBLE_SIZE - MARGIN - 12
  );
}

export default function FloatingChatWidget() {
  const pathname = usePathname();
  const { t } = useLocale();

  const skip = SKIP_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname?.startsWith(prefix + "/")
  );

  const [mounted, setMounted] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [myUserId, setMyUserId] = useState<string | null>(null);

  const [position, setPosition] = useState<Position>({ x: MARGIN, y: MARGIN });
  const [open, setOpen] = useState(false);
  const [selectedConversationId, setSelectedConversationId] = useState<
    string | null
  >(null);
  const [unreadTotal, setUnreadTotal] = useState(0);
  const [isMobile, setIsMobile] = useState(false);

  const buttonRef = useRef<HTMLButtonElement>(null);
  const dragState = useRef<{
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    moved: boolean;
  } | null>(null);

  // ---------------------------------------------------------------------
  // Autorizácia: presne rovnaký vzor ako CompanyDpaGate — session +
  // aktívny company membership. Bez oboch sa komponent vôbec nerenderuje
  // (žiadna bublina na verejných/neprihlásených stránkach).
  // ---------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;

    async function checkAuth() {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        if (!cancelled) {
          setAuthorized(false);
          setMyUserId(null);
        }
        return;
      }

      const membership = await getMyActiveMembership();

      if (!cancelled) {
        setAuthorized(!!membership);
        setMyUserId(session.user.id);
      }
    }

    checkAuth();

    const { data: authListener } = supabase.auth.onAuthStateChange(() => {
      checkAuth();
    });

    return () => {
      cancelled = true;
      authListener.subscription.unsubscribe();
    };
  }, []);

  // ---------------------------------------------------------------------
  // Poloha bublinky: načítanie z localStorage + clamp na aktuálny viewport
  // pri mounte, a re-clamp pri zmene veľkosti okna (otočenie mobilu a pod).
  // ---------------------------------------------------------------------
  useEffect(() => {
    // "Prepni na klientský render až po mounte" (SSR/hydratácia — poloha
    // závisí od window/localStorage) — rovnaký, inde v appke už tolerovaný
    // vzor ako checkUser()/loadAll() v ChatConversationList.tsx (pozri
    // komentár tam k react-hooks/set-state-in-effect nekonzistentnosti).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);

    let initial: Position | null = null;
    try {
      const raw = window.localStorage.getItem(POSITION_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (typeof parsed?.x === "number" && typeof parsed?.y === "number") {
          initial = clampPosition(parsed.x, parsed.y);
        }
      }
    } catch {
      // localStorage nedostupné/poškodené — použi default, nič nekritické.
    }

    setPosition(initial || defaultPosition());
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);

    function handleResize() {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
      setPosition((current) => clampPosition(current.x, current.y));
    }

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // Ulož polohu pri každej zmene (aj počas ťahania — malé, neškodné
  // množstvo zápisov, zjednodušuje logiku a vylučuje zastarané closures).
  useEffect(() => {
    if (!mounted) return;
    try {
      window.localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify(position));
    } catch {
      // Neblokujúce — ak localStorage zlyhá, poloha sa jednoducho neuloží.
    }
  }, [mounted, position]);

  // ---------------------------------------------------------------------
  // Unread badge — jedno počiatočné načítanie + realtime bump, rovnaký
  // vzor ako pôvodne v ChatConversationList (teraz navyše globálne, funguje
  // nezávisle od toho, ktorá appková stránka je práve otvorená).
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (!authorized) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setUnreadTotal(0);
      return;
    }

    let cancelled = false;

    async function loadUnread() {
      try {
        const rows = await getMyUnreadCounts();
        if (!cancelled) {
          setUnreadTotal(rows.reduce((sum, row) => sum + row.unread_count, 0));
        }
      } catch {
        // Best-effort — badge jednoducho ostane na poslednej známej hodnote.
      }
    }

    loadUnread();

    return () => {
      cancelled = true;
    };
  }, [authorized, open]);

  useEffect(() => {
    if (!authorized || !myUserId) return;

    const channel = supabase
      .channel(`chat-widget-unread-${myUserId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "chat_messages" },
        (payload) => {
          const message = payload.new as {
            conversation_id: string;
            author_id: string | null;
          };

          if (message.author_id === myUserId) return;
          // Ak je panel otvorený PRESNE na tejto konverzácii, ChatMessageView
          // ju priebežne označuje ako prečítanú — nezvyšuj badge.
          if (open && selectedConversationId === message.conversation_id) return;

          setUnreadTotal((current) => current + 1);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [authorized, myUserId, open, selectedConversationId]);

  // ---------------------------------------------------------------------
  // Drag & drop (pointer events — funguje pre myš aj dotyk). Malý pohybový
  // prah rozlišuje "klik" (otvor/zavri panel) od skutočného ťahania.
  // ---------------------------------------------------------------------
  function handlePointerDown(event: React.PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 && event.pointerType === "mouse") return;

    buttonRef.current?.setPointerCapture(event.pointerId);
    dragState.current = {
      startX: event.clientX,
      startY: event.clientY,
      origX: position.x,
      origY: position.y,
      moved: false,
    };
  }

  function handlePointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    const state = dragState.current;
    if (!state) return;

    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;

    if (!state.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;

    state.moved = true;
    setPosition(clampPosition(state.origX + dx, state.origY + dy));
  }

  function handlePointerUp(event: React.PointerEvent<HTMLButtonElement>) {
    const state = dragState.current;
    dragState.current = null;

    try {
      buttonRef.current?.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture už mohol byť uvoľnený (napr. pri zrušenom geste).
    }

    if (!state) return;

    if (!state.moved) {
      setOpen((current) => !current);
    }
  }

  // Pomenovaná funkcia namiesto inline `() => setOpen(false)` — potrebná
  // ako stabilná referencia posielaná ako `onClose` do MobilePanel/
  // DesktopPanel, odkiaľ sa ďalej prehnáva do ChatMessageView ako
  // `onInternalNavigate` (zavretie panelu pri kliku na entity-referenciu,
  // pozri PanelBody nižšie a ChatEntityReferenceCard.handleClick()).
  function closePanel() {
    setOpen(false);
  }

  if (!mounted || skip || !authorized) return null;

  // Panel sa ukotvuje k rohu, ku ktorému je bublinka aktuálne bližšie —
  // vždy plne v rámci viewportu (clamp nižšie), nikdy nezasahuje mimo
  // obrazovku. Na mobile ide o samostatný, jednoduchší bottom-sheet layout
  // (pozri return nižšie) bez tejto kotviacej logiky.
  const anchorRight =
    typeof window !== "undefined"
      ? position.x + BUBBLE_SIZE / 2 > window.innerWidth / 2
      : true;
  const anchorBottom =
    typeof window !== "undefined"
      ? position.y + BUBBLE_SIZE / 2 > window.innerHeight / 2
      : true;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={open ? t("chat.closePanel") : t("chat.openPanel")}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        style={{
          position: "fixed",
          left: position.x,
          top: position.y,
          width: BUBBLE_SIZE,
          height: BUBBLE_SIZE,
          touchAction: "none",
          zIndex: 70,
        }}
        className="flex items-center justify-center rounded-full bg-accent-cyan text-[#051221] shadow-2xl transition active:scale-95"
      >
        <ChatBubbleIcon />
        {unreadTotal > 0 && (
          <span
            aria-hidden="true"
            className="badge-danger absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] font-bold"
          >
            {unreadTotal > 99 ? "99+" : unreadTotal}
          </span>
        )}
      </button>

      {open &&
        (isMobile ? (
          <MobilePanel
            onClose={closePanel}
            selectedConversationId={selectedConversationId}
            onSelectConversation={setSelectedConversationId}
            onBack={() => setSelectedConversationId(null)}
            t={t}
          />
        ) : (
          <DesktopPanel
            anchorRight={anchorRight}
            anchorBottom={anchorBottom}
            bubblePosition={position}
            onClose={closePanel}
            selectedConversationId={selectedConversationId}
            onSelectConversation={setSelectedConversationId}
            onBack={() => setSelectedConversationId(null)}
            t={t}
          />
        ))}
    </>
  );
}

// -----------------------------------------------------------------------------
// Desktop panel — kompaktná karta ukotvená k rohu najbližšiemu k bublinke,
// plne clampnutá vnútri viewportu.
// -----------------------------------------------------------------------------
function DesktopPanel({
  anchorRight,
  anchorBottom,
  bubblePosition,
  onClose,
  selectedConversationId,
  onSelectConversation,
  onBack,
  t,
}: {
  anchorRight: boolean;
  anchorBottom: boolean;
  bubblePosition: Position;
  onClose: () => void;
  selectedConversationId: string | null;
  onSelectConversation: (id: string) => void;
  onBack: () => void;
  t: (key: string) => string;
}) {
  const width = 380;
  const height = 560;
  const gap = 12;

  const style: React.CSSProperties = {
    position: "fixed",
    width,
    height,
    zIndex: 70,
  };

  if (anchorRight) {
    style.right = Math.max(
      MARGIN,
      window.innerWidth - (bubblePosition.x + BUBBLE_SIZE)
    );
  } else {
    style.left = Math.max(MARGIN, bubblePosition.x);
  }

  if (anchorBottom) {
    style.bottom = Math.max(
      MARGIN,
      window.innerHeight - bubblePosition.y + gap
    );
  } else {
    style.top = Math.max(MARGIN, bubblePosition.y + BUBBLE_SIZE + gap);
  }

  // Finálny clamp — ak by aj takto ukotvený panel presahoval opačnú hranu
  // (napr. veľmi úzke okno), zmenši ho tak, aby vždy zostal celý viditeľný.
  style.maxWidth = `calc(100vw - ${MARGIN * 2}px)`;
  style.maxHeight = `calc(100vh - ${MARGIN * 2}px)`;

  return (
    <div
      style={style}
      className="surface-card flex flex-col overflow-hidden rounded-2xl border border-subtle shadow-2xl"
    >
      <PanelHeader
        showBack={!!selectedConversationId}
        onBack={onBack}
        onClose={onClose}
        t={t}
      />
      <PanelBody
        selectedConversationId={selectedConversationId}
        onSelectConversation={onSelectConversation}
        onClose={onClose}
      />
    </div>
  );
}

// -----------------------------------------------------------------------------
// Mobil/PWA — jednoduchý bottom-sheet cez takmer celú výšku obrazovky,
// s env(safe-area-inset-bottom) rezervou, aby neprekážal systémovým
// gestám/home indicatoru.
// -----------------------------------------------------------------------------
function MobilePanel({
  onClose,
  selectedConversationId,
  onSelectConversation,
  onBack,
  t,
}: {
  onClose: () => void;
  selectedConversationId: string | null;
  onSelectConversation: (id: string) => void;
  onBack: () => void;
  t: (key: string) => string;
}) {
  return (
    <div
      className="fixed inset-0 z-[70] flex flex-col justify-end bg-slate-950/60 backdrop-blur-sm"
      onClick={(event) => {
        // Zatvorí panel iba pri kliku priamo na backdrop (target ===
        // currentTarget), nie pri kliku na čokoľvek v podstrome panelu.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        // MOBILE CHAT LAYOUT BUG fix (2026-08-30): `max-h-[85vh]` samo osebe
        // NEdáva tomuto flex-col kontajneru definitívnu výšku — iba hornú
        // hranicu pre inak content-driven (shrink-to-fit) výšku. Kým sa
        // obsah (header + správy + composer) zmestil pod 85vh, fungovalo to
        // "náhodou" správne; po pridaní dosť správ (najmä vyššej bubliny s
        // obrázkovou prílohou) prirodzená výška obsahu presiahla strop,
        // orezalo sa to cez overflow-hidden ZDOLA (posledná správa +
        // composer zmizli pod okraj) — a keďže ChatMessageView vnútri
        // spolieha na `h-full` (potrebuje DEFINITÍVNU výšku rodiča, aby
        // svoja `min-h-0 flex-1 overflow-y-auto` oblasť správ vedela
        // skutočne interne scrollovať namiesto rastu do nekonečna), vnútorný
        // scroll sa nikdy nespustil. Oprava: `h-[85dvh]` (s `h-[85vh]`
        // fallbackom pre prehliadače bez `dvh`) dáva panelu PEVNÚ výšku —
        // vnútorný flex layout (ChatMessageView.tsx: header auto / správy
        // min-h-0 flex-1 overflow-y-auto / composer auto) sa tak správa
        // presne podľa zámeru: composer je vždy vo viditeľnej časti, rastie
        // iba zoznam správ (interným scrollom). `dvh` navyše (na rozdiel od
        // statického `vh`) spolu s `interactiveWidget: "resizes-content"`
        // (app/layout.tsx) korektne zmenší panel pri otvorení soft
        // klávesnice bez JS hacku na výšku viewportu.
        className="surface-card flex h-[85vh] h-[85dvh] flex-col overflow-hidden rounded-t-2xl border-t border-subtle shadow-2xl"
        style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
      >
        <PanelHeader
          showBack={!!selectedConversationId}
          onBack={onBack}
          onClose={onClose}
          t={t}
        />
        {/* MOBILE CHAT LAYOUT BUG fix #2 (2026-08-30, DOM/flex chain audit):
            PanelBody musí byť PRIAMYM flex-item potomkom tejto karty (rovnako
            ako na Desklope nižšie — DesktopPanel renderuje PanelHeader +
            PanelBody priamo, bez medzičlánku). Predtým tu bol obalový
            `<div className="min-h-0 flex-1">` okolo PanelBody — ten obal SÁM
            nemal `display:flex`, takže:
              1) jeho vlastné `min-h-0 flex-1` triedy správne fungovali (bol
                 flex-itemom TEJTO karty), takže od svojho rodiča DOSTAL
                 definitívnu výšku,
              2) ale PanelBody vo vnútri (ktoré má TIE ISTÉ `min-h-0 flex-1`
                 triedy) bolo iba obyčajné block dieťa tohto obalu — keďže
                 obal nemal `display:flex`, PanelBody's `flex-1`/`min-h-0`
                 triedy boli úplne bez efektu (fungujú len na flex-itemoch) a
                 PanelBody zostalo na `height:auto` (shrink-to-fit obsahu),
              3) ChatMessageView vo vnútri PanelBody spolieha na `h-full`
                 (height:100%) — percentuálna výška sa ale nedá vypočítať
                 voči rodičovi s `auto` výškou, takže sa podľa CSS špecifikácie
                 vyhodnotí tiež ako `auto` → CELÝ obsah (hlavička + VŠETKY
                 správy + composer) sa vykreslil na plnú výšku obsahu, bez
                 akéhokoľvek interného scrollu,
              4) tento "príliš vysoký" obsah potom pretiekol cez obalový div
                 (ten mal `overflow: visible`, žiadne orezanie) až po TÚTO
                 kartu, kde ho až `overflow-hidden` orezalo ZDOLA — presne to,
                 čo bolo vidno na screenshote (posledná správa + composer
                 odrezané, composer nedostupný).
            Odstránením obalu je PanelBody priamym flex-itemom tejto karty
            (`flex h-[85dvh] flex-col`, definitívna výška) — PanelBody's
            vlastné `min-h-0 flex-1 overflow-hidden p-3` (nezmenené) teraz
            skutočne fungujú, ChatMessageView's `h-full` má voči čomu
            rezolvovať percentá, a jeho vnútorný `min-h-0 flex-1
            overflow-y-auto` zoznam správ dostane skutočnú scrollovateľnú
            výšku — composer (flex-none sibling, nie vo vnútri scroll
            containera) ostáva vždy viditeľný. Mobile je touto zmenou
            štruktúrne zhodný s Desktopom (ten tento problém nikdy nemal,
            keďže PanelBody tam bolo od začiatku priamym potomkom). */}
        <PanelBody
          selectedConversationId={selectedConversationId}
          onSelectConversation={onSelectConversation}
          onClose={onClose}
        />
      </div>
    </div>
  );
}

function PanelHeader({
  showBack,
  onBack,
  onClose,
  t,
}: {
  showBack: boolean;
  onBack: () => void;
  onClose: () => void;
  t: (key: string) => string;
}) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-subtle px-2 py-2">
      {showBack ? (
        <button
          type="button"
          onClick={onBack}
          aria-label={t("chat.backToList")}
          className="flex h-8 w-8 items-center justify-center rounded-full text-secondary transition hover:bg-surface-hover hover:text-primary"
        >
          ←
        </button>
      ) : (
        <span />
      )}

      <button
        type="button"
        onClick={onClose}
        aria-label={t("chat.closePanel")}
        className="flex h-8 w-8 items-center justify-center rounded-full text-secondary transition hover:bg-surface-hover hover:text-primary"
      >
        ✕
      </button>
    </div>
  );
}

function PanelBody({
  selectedConversationId,
  onSelectConversation,
  onClose,
}: {
  selectedConversationId: string | null;
  onSelectConversation: (id: string) => void;
  /** Zavolá sa TESNE PRED interným router.push() z entity-reference karty
   * (klik na vozidlo/stroj/sklad/servis), aby plávajúci panel neprekrýval
   * cieľovú stránku po navigácii. Prehnané cez ChatMessageView →
   * MessageBubble → ChatEntityReferenceCard (pozri ChatMessageView.tsx). */
  onClose: () => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-hidden p-3">
      {selectedConversationId ? (
        <ChatMessageView
          conversationId={selectedConversationId}
          onInternalNavigate={onClose}
        />
      ) : (
        <ChatConversationList
          activeConversationId={null}
          onSelectConversation={onSelectConversation}
        />
      )}
    </div>
  );
}
