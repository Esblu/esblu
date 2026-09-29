"use client";

import Link from "next/link";
import type { MouseEvent, ReactNode } from "react";
import { IS_MOBILE_BUILD } from "@/lib/build-target";
import { canonicalWebUrl } from "@/lib/app-origin";
import { openExternalUrl } from "@/lib/file-actions";

// =============================================================================
// Odkaz na právny dokument (podmienky, ochrana údajov, DPA…) z formulára
// alebo súhlasovej brány — otvára sa MIMO aktuálnej obrazovky, aby sa
// neprišlo o rozpracovaný formulár / súhlas.
//
// Web: nová karta (target=_blank) — doterajšie správanie.
// Mobil (Mobile M1): `target=_blank` v Capacitor WebView nie je spoľahlivé
// (buď nič, alebo prepíše aktuálnu obrazovku) → dokument sa otvorí v
// in-app prehliadači (Chrome Custom Tab) z kanonického webu.
// =============================================================================

export function LegalDocLink({
  path,
  className,
  children,
}: {
  path: string;
  className?: string;
  children: ReactNode;
}) {
  if (IS_MOBILE_BUILD) {
    const url = canonicalWebUrl(path);
    return (
      <a
        href={url}
        className={className}
        onClick={(event: MouseEvent<HTMLAnchorElement>) => {
          event.preventDefault();
          void openExternalUrl(url);
        }}
      >
        {children}
      </a>
    );
  }
  return (
    <Link href={path} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
    </Link>
  );
}
