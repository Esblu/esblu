"use client";

import { useCallback, useRef, useState } from "react";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import {
  VIDEO_SRC_1080,
  VIDEO_SRC_720,
  VIDEO_POSTER,
  VIDEO_CAPTIONS_SK,
  VIDEO_DURATION_SECONDS,
  VIDEO_CHAPTERS,
  formatVideoTime,
} from "@/lib/landing-video";

/**
 * PRODUKTOVÉ DEMO VIDEO NA LANDING PAGE
 * ---------------------------------------------------------------------------
 * Návrhové rozhodnutia:
 *
 * 1. VÝKON — pred kliknutím na play sa <video> element vôbec nevykreslí.
 *    Landing page tak neprenesie ani bajt videa; sťahuje sa až vtedy, keď
 *    o to návštevník sám požiada. Miesto prehrávača drží poster s pevným
 *    pomerom strán 16:9, takže nevzniká layout shift.
 *
 * 2. ZDROJ PODĽA ZARIADENIA — voľba súboru prebieha až v momente kliknutia,
 *    keď už poznáme šírku viewportu. Mobil dostane 720p verziu (rádovo
 *    štvrtinový prenos), desktop 1080p. <source media> sa na <video>
 *    naprieč prehliadačmi nespráva spoľahlivo, preto sa rozhoduje v JS.
 *
 * 3. KAPITOLY — video má cez šesť minút. Bez navigácie by ho na landing page
 *    nikto nedopozeral. Kapitoly umožnia skočiť rovno na modul, ktorý
 *    návštevníka zaujíma.
 *
 * 4. MERANIE — projekt zatiaľ nemá žiadnu analytiku. Komponent preto iba
 *    vysiela `window` CustomEvent `esblu:video`. Nič ho dnes nepočúva,
 *    neukladá sa žiadna cookie ani sa nikam neposiela request, takže to
 *    nemá vplyv na Cookie Policy. Keď pribudne analytika, stačí sa na
 *    udalosť naviazať jedným listenerom.
 */

/** Jednosmerné hlásenie udalostí — bez cookies, bez siete, bez vendora. */
function emit(action: string, detail: Record<string, unknown> = {}) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("esblu:video", { detail: { action, ...detail } })
  );
}

export default function EsbluDemoVideo() {
  const { t } = useLocale();
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const [started, setStarted] = useState(false);
  const [activeChapter, setActiveChapter] = useState(0);
  // Aby sa každý míľnik dopozerania ohlásil najviac raz.
  const reachedRef = useRef<Set<number>>(new Set());

  const start = useCallback(
    (chapterIndex = 0) => {
      setActiveChapter(chapterIndex);
      setStarted(true);
      emit("play", {
        chapter: VIDEO_CHAPTERS[chapterIndex]?.key ?? "intro",
        from: VIDEO_CHAPTERS[chapterIndex]?.start ?? 0,
      });
    },
    []
  );

  /** Skok na kapitolu — funguje pred prvým spustením aj počas prehrávania. */
  const goToChapter = useCallback(
    (index: number) => {
      const chapter = VIDEO_CHAPTERS[index];
      if (!chapter) return;

      if (!started) {
        start(index);
        return;
      }

      const el = videoRef.current;
      if (!el) return;
      el.currentTime = chapter.start;
      setActiveChapter(index);
      emit("chapter", { chapter: chapter.key, from: chapter.start });
      void el.play().catch(() => {
        // Prehliadač môže prehrávanie odmietnuť (napr. úsporný režim) —
        // používateľ si ho spustí natívnym tlačidlom, nie je to chyba.
      });
    },
    [started, start]
  );

  /** Po vykreslení <video> ho rovno spustíme od zvolenej kapitoly. */
  const handleLoaded = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    const from = VIDEO_CHAPTERS[activeChapter]?.start ?? 0;
    if (from > 0) el.currentTime = from;
    void el.play().catch(() => {
      // Ak autoplay so zvukom prehliadač zablokuje, zostane viditeľný
      // natívny play button — video sa neprehrá samo, čo je v poriadku.
    });
  }, [activeChapter]);

  const handleTimeUpdate = useCallback(() => {
    const el = videoRef.current;
    if (!el || !el.duration) return;

    // Zvýraznenie práve prebiehajúcej kapitoly.
    const now = el.currentTime;
    let idx = 0;
    for (let i = 0; i < VIDEO_CHAPTERS.length; i += 1) {
      if (now >= VIDEO_CHAPTERS[i].start) idx = i;
    }
    setActiveChapter((prev) => (prev === idx ? prev : idx));

    // Míľniky dopozerania.
    const pct = (now / el.duration) * 100;
    for (const milestone of [25, 50, 75, 95]) {
      if (pct >= milestone && !reachedRef.current.has(milestone)) {
        reachedRef.current.add(milestone);
        emit("progress", { percent: milestone });
      }
    }
  }, []);

  const isNarrow =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(max-width: 768px)").matches;

  return (
    <div className="mt-10">
      {/* Prehrávač / poster — pevný pomer 16:9 drží miesto, takže sa layout
          pri prepnutí na <video> neposunie. */}
      <div className="relative overflow-hidden rounded-3xl border border-subtle bg-slate-950 shadow-2xl shadow-black/50">
        <div className="relative aspect-video w-full">
          {started ? (
            <video
              ref={videoRef}
              className="absolute inset-0 h-full w-full bg-black"
              controls
              playsInline
              preload="auto"
              poster={VIDEO_POSTER}
              onLoadedMetadata={handleLoaded}
              onTimeUpdate={handleTimeUpdate}
              onEnded={() => emit("ended")}
            >
              <source src={isNarrow ? VIDEO_SRC_720 : VIDEO_SRC_1080} type="video/mp4" />
              <track
                kind="subtitles"
                src={VIDEO_CAPTIONS_SK}
                srcLang="sk"
                label="Slovenčina"
                default
              />
            </video>
          ) : (
            <button
              type="button"
              onClick={() => start(0)}
              aria-label={t("landing.video.playAria")}
              className="group absolute inset-0 h-full w-full cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={VIDEO_POSTER}
                alt={t("landing.video.posterAlt")}
                className="absolute inset-0 h-full w-full object-cover"
                loading="lazy"
                decoding="async"
                width={1920}
                height={1080}
              />
              <span
                aria-hidden="true"
                className="absolute inset-0 bg-gradient-to-t from-slate-950/85 via-slate-950/25 to-slate-950/45"
              />

              {/* Play tlačidlo */}
              <span
                aria-hidden="true"
                className="absolute left-1/2 top-1/2 flex h-20 w-20 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-gradient-to-br from-accent-cyan to-accent-blue-strong shadow-2xl shadow-accent-cyan/40 transition group-hover:scale-105 sm:h-24 sm:w-24"
              >
                <svg
                  viewBox="0 0 24 24"
                  className="ml-1 h-8 w-8 sm:h-10 sm:w-10"
                  fill="#051221"
                  aria-hidden="true"
                >
                  <path d="M8 5.14v13.72a1 1 0 0 0 1.53.85l10.74-6.86a1 1 0 0 0 0-1.7L9.53 4.29A1 1 0 0 0 8 5.14Z" />
                </svg>
              </span>

              {/* Dĺžka + jazyk zvuku */}
              <span className="absolute bottom-4 left-4 flex flex-wrap items-center gap-2 sm:bottom-6 sm:left-6">
                <span className="rounded-full bg-slate-950/80 px-3 py-1.5 text-sm font-bold text-white backdrop-blur">
                  {formatVideoTime(VIDEO_DURATION_SECONDS)}
                </span>
                <span className="rounded-full bg-slate-950/80 px-3 py-1.5 text-sm font-semibold text-slate-300 backdrop-blur">
                  {t("landing.video.audioLanguage")}
                </span>
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Kapitoly */}
      <div className="mt-6">
        <p className="text-sm font-bold uppercase tracking-[0.16em] text-muted-esblu">
          {t("landing.video.chaptersLabel")}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {VIDEO_CHAPTERS.map((chapter, index) => {
            const isActive = started && index === activeChapter;
            return (
              <button
                key={chapter.key}
                type="button"
                onClick={() => goToChapter(index)}
                aria-current={isActive ? "true" : undefined}
                className={`inline-flex min-h-11 items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan ${
                  isActive
                    ? "border-accent-cyan bg-accent-cyan/12 text-accent-cyan"
                    : "border-subtle bg-surface-2 text-secondary hover:border-border-strong hover:text-primary"
                }`}
              >
                {t(`landing.video.chapter.${chapter.key}`)}
                <span className="text-xs font-bold tabular-nums text-muted-esblu">
                  {formatVideoTime(chapter.start)}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Pomocník pre CTA pod videom — aby sa klik dal merať rovnakým kanálom. */
export function emitVideoCtaClick() {
  emit("cta");
}
