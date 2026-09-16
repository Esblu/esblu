import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import LegalAcceptanceGate from "./components/LegalAcceptanceGate";
import CompanyDpaGate from "./components/CompanyDpaGate";
import FloatingChatWidget from "./components/chat/FloatingChatWidget";
import { LocaleProvider } from "@/lib/i18n/LocaleProvider";
import { DEFAULT_LOCALE } from "@/lib/i18n/locales";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Metadata (bod 17 zadania — sociálne zdieľanie/SEO): jediný statický
// popis (SK) zámerne zhodný s existujúcou architektúrou tohto súboru —
// appka dnes nemá per-locale metadata (SSR vždy vykresľuje DEFAULT_LOCALE,
// pozri komentár pri <html lang> nižšie), preto title/description/OG/
// Twitter ostávajú jeden spoločný (SK) text, nie nová i18n vrstva. Text
// musí odzrkadľovať uzavretú beta a NESMIE tvrdiť, že eFaktúra je hotová
// (bod 10 zadania) — PDF faktúr (FÁZA 3A) tu tiež nie je prezentované ako
// eFaktúra.
const LANDING_SOCIAL_TITLE = "Esblu — firemná evidencia a fakturácia";
const LANDING_SOCIAL_DESCRIPTION =
  "Esblu spája firemnú evidenciu dokumentov, vozidiel, strojov, skladu, obchodných partnerov a faktúr v jednej aplikácii. Aktuálne v uzavretej beta verzii.";

export const metadata: Metadata = {
  title: LANDING_SOCIAL_TITLE,
  description: LANDING_SOCIAL_DESCRIPTION,
  manifest: "/manifest.json",
  openGraph: {
    title: LANDING_SOCIAL_TITLE,
    description: LANDING_SOCIAL_DESCRIPTION,
    siteName: "Esblu",
    locale: "sk_SK",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: LANDING_SOCIAL_TITLE,
    description: LANDING_SOCIAL_DESCRIPTION,
  },
};

export const viewport: Viewport = {
  themeColor: "#2563eb",
  // MOBILE CHAT LAYOUT BUG fix (2026-08-30): default Chrome/Android WebView
  // viewport behavior ("resizes-visual") shrinká iba VIZUÁLNY viewport pri
  // otvorení soft klávesnice, ale NIE layout viewport — takže `dvh` jednotky
  // (a `position: fixed` elementy, ktoré sa naň spoliehajú) zostávajú
  // rovnaké aj s otvorenou klávesnicou, čo spôsobovalo, že spodná časť
  // FloatingChatWidget bottom-sheetu (composer) skončila skrytá pod
  // klávesnicou/Android nav barom. `resizes-content` prepína prehliadač na
  // to, aby PRI OTVORENÍ klávesnice skutočne zmenšil samotný layout
  // viewport — `dvh`/`fixed` elementy sa potom prepočítajú a zmenšia
  // automaticky, bez JS visualViewport hackov. Zdieľané webom aj mobile
  // (mobile/app/layout.tsx re-exportuje `viewport` z tohto súboru).
  interactiveWidget: "resizes-content",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Jazyk sa NEURČUJE zo server-side cookie (revidované — appka zámerne
  // nezavádza žiadnu novú cookie, pozri lib/i18n/locales.ts pre plné
  // zdôvodnenie). SSR vždy vykresľuje DEFAULT_LOCALE (sk); LocaleProvider
  // po mountnutí na klientovi prečíta localStorage a <html lang> aj celý
  // preložený obsah prepne na uloženú preferenciu (vedomý kompromis — krátky
  // FOUC v SK pri tvrdom reloade pre DE/EN používateľa).
  return (
    <html
      lang={DEFAULT_LOCALE}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <LocaleProvider>
          <LegalAcceptanceGate>
            <CompanyDpaGate>
              {children}
              {/* Globálny plávajúci chat — jediné miesto v appke, ktoré
                  obaľuje VŠETKY moduly (tie samotné nemajú spoločný
                  sidebar/layout, pozri audit v FloatingChatWidget.tsx).
                  Renderuje sa AŽ za {children}/vnútri CompanyDpaGate, takže
                  jeho z-index (70) je zámerne pod LegalAcceptanceGate (100)
                  aj CompanyDpaGate (90) — nedostupný gate vždy prekryje
                  bublinku, presne ako medzi sebou tieto dva gate. */}
              <FloatingChatWidget />
            </CompanyDpaGate>
          </LegalAcceptanceGate>
        </LocaleProvider>
      </body>
    </html>
  );
}