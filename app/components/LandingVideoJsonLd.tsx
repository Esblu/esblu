"use client";

import { useLocale } from "@/lib/i18n/LocaleProvider";
import {
  SITE_URL,
  VIDEO_POSTER,
  VIDEO_SRC_1080,
  VIDEO_DURATION_SECONDS,
  VIDEO_PUBLISHED_AT,
  VIDEO_AUDIO_LOCALE,
  isVideoPublished,
  toIsoDuration,
} from "@/lib/landing-video";

/**
 * Structured data (schema.org VideoObject) pre produktové demo na landingu.
 *
 * Vykreslí sa IBA vtedy, keď je v lib/landing-video.ts vyplnený skutočný
 * dátum zverejnenia. Google vyžaduje pri VideoObject platný `uploadDate` —
 * radšej žiadna schéma než schéma s vymysleným údajom.
 *
 * Názov a popis sa berú z existujúceho slovníka, takže sa neduplikuje text
 * a schéma zodpovedá tomu, čo je reálne na stránke.
 */
export default function LandingVideoJsonLd() {
  const { t } = useLocale();

  if (!isVideoPublished()) return null;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "VideoObject",
    name: t("landing.video.title"),
    description: t("landing.video.subtitle"),
    thumbnailUrl: [`${SITE_URL}${VIDEO_POSTER}`],
    contentUrl: `${SITE_URL}${VIDEO_SRC_1080}`,
    uploadDate: VIDEO_PUBLISHED_AT,
    duration: toIsoDuration(VIDEO_DURATION_SECONDS),
    inLanguage: VIDEO_AUDIO_LOCALE,
    isFamilyFriendly: true,
    publisher: {
      "@type": "Organization",
      name: "Esblu",
      url: SITE_URL,
    },
  };

  return (
    <script
      type="application/ld+json"
      // Obsah je zostavený z vlastných konštánt a prekladov, nie zo vstupu
      // používateľa — nejde o vloženie nedôveryhodného HTML.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
    />
  );
}
