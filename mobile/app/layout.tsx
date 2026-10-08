import type { Viewport } from "next";
import RootLayout, { metadata, viewport as webViewport } from "@/app/layout";
import DeepLinkBridge from "./DeepLinkBridge";
import BackButtonBridge from "./BackButtonBridge";
import NativeRuntimeMarker from "./NativeRuntimeMarker";
import PushBridge from "./PushBridge";
import AppLifecycleBridge from "./AppLifecycleBridge";
import OfflineBanner from "@/app/components/mobile/OfflineBanner";
import MobileTabBar from "@/app/components/mobile/MobileTabBar";

// -----------------------------------------------------------------------------
// MOBILE root layout — kompozícia, NIE duplikácia. Celá vizuálna/business
// štruktúra (LocaleProvider, LegalAcceptanceGate, CompanyDpaGate,
// FloatingChatWidget, fonty, metadata/viewport) zostáva 100% zdieľaná zo
// @/app/layout — ten istý RootLayout komponent, ktorý používa web. Tento
// súbor ho iba VOLÁ ako obyčajný React komponent (nie cez file-based layout
// nesting — mobile/ je vlastný Next.js projekt, takže toto JE jeho root
// layout) a vloží doň navyše <DeepLinkBridge /> ako súrodenca {children},
// vnútri rovnakého <html><body> stromu.
//
// DeepLinkBridge (App Links routing cez @capacitor/app) sa TAKTO mountuje
// VÝHRADNE v mobile builde — @capacitor/app sa nikde v koreňovom (web)
// app/layout.tsx neimportuje ani nespomína, takže webový bundle/build sa
// touto zmenou vôbec nedotýka.
// -----------------------------------------------------------------------------
export { metadata };

// Mobile Platform (2026-10-08): viewport-fit=cover IBA v natívnej appke —
// env(safe-area-inset-*) potom vracia skutočné výrezy (iOS notch, Android
// edge-to-edge) a --esblu-safe-* ich používa. Web ostáva nezmenený.
export const viewport: Viewport = { ...webViewport, viewportFit: "cover" };

export default function MobileRootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <RootLayout>
      <DeepLinkBridge />
      <BackButtonBridge />
      <NativeRuntimeMarker />
      <AppLifecycleBridge />
      <OfflineBanner />
      {/* Kliknutie na natívnu push notifikáciu → obrazovka z allowlistu. */}
      <PushBridge />
      {children}
      {/* Mobile M1: spodná navigácia (iba mobilný build). */}
      <MobileTabBar />
    </RootLayout>
  );
}
