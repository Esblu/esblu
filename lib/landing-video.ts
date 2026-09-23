/**
 * KONFIGURÁCIA PRODUKTOVÉHO DEMO VIDEA NA LANDING PAGE
 * ---------------------------------------------------------------------------
 * Jediné miesto, kde sa video konfiguruje. Komponent prehrávača
 * (app/components/EsbluDemoVideo.tsx) aj structured data
 * (app/components/LandingVideoJsonLd.tsx) čítajú odtiaľto.
 *
 * PRI VÝMENE VIDEA ZA NOVÚ VERZIU SKONTROLUJ:
 *   1. VIDEO_DURATION_SECONDS — musí sedieť s reálnym súborom
 *   2. VIDEO_PUBLISHED_AT — dátum zverejnenia (ISO 8601)
 *
 * Súbory pripraví `scripts/prepare-landing-video.sh`.
 */

export const VIDEO_SRC_1080 = "/video/esblu-demo-1080p.mp4";
export const VIDEO_SRC_720 = "/video/esblu-demo-720p.mp4";
export const VIDEO_POSTER = "/video/esblu-demo-poster.jpg";
export const VIDEO_CAPTIONS_SK = "/video/esblu-demo-sk.vtt";

/** Produkčná adresa webu — potrebná pre absolútne URL v structured data. */
export const SITE_URL = "https://www.esblu.com";

/** Dĺžka videa v sekundách. */
export const VIDEO_DURATION_SECONDS = 416;

/**
 * Dátum zverejnenia videa v tvare ISO 8601 (napr. "2026-09-23").
 *
 * TOTO JE ZÁROVEŇ PREPÍNAČ CELEJ SEKCIE.
 *
 * Kým je prázdny:
 *   • sekcia #ukazka sa na landing page nevykreslí,
 *   • odkaz „Pozrieť ukážku“ v hero časti aj položka v hlavičke sa skryjú,
 *   • structured data VideoObject sa nevykreslí.
 *
 * Dôvod: video súbory (≈33 MB) nie sú v repozitári. Bez nich by sekcia
 * ukazovala prázdny prehrávač. Zároveň Google vyžaduje pri schéme
 * VideoObject platný `uploadDate` — radšej žiadna schéma než schéma
 * s vymysleným údajom.
 *
 * Po nahratí súborov do public/video stačí sem doplniť dátum a celá
 * sekcia sa zapne.
 */
export const VIDEO_PUBLISHED_AT = "2026-09-23";

/** Jazyk zvukovej stopy videa (BCP 47). */
export const VIDEO_AUDIO_LOCALE = "sk";

/** Je video reálne nasadené? Riadi vykreslenie celej sekcie aj schémy. */
export const isVideoPublished = () => VIDEO_PUBLISHED_AT.trim().length > 0;

/** "6:56" */
export function formatVideoTime(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** ISO 8601 trvanie pre schema.org, napr. "PT6M56S". */
export function toIsoDuration(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `PT${minutes}M${seconds}S`;
}
