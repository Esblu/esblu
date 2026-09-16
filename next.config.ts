import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // FÁZA 3A — PDF faktúry (app/api/invoices/[id]/pdf/route.ts) číta
  // assets/fonts/*.ttf priamo cez fs (path.join(process.cwd(), ...)), nie
  // cez import — Next.js file tracing preto tieto súbory bez explicitnej
  // deklarácie do Vercel serverless bundlu nezahrnie (next/font Google Fonts
  // mechanizmus tu nepomôže, @react-pdf/renderer potrebuje reálny súborový
  // .ttf). Pozri lib/invoicing/pdf-renderer.tsx.
  outputFileTracingIncludes: {
    "/api/invoices/**": ["./assets/fonts/**"],
  },
};

export default nextConfig;
