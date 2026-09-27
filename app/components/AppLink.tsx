"use client";

import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { resolveAppHref } from "@/lib/app-routes";

// =============================================================================
// Interný odkaz, ktorý rešpektuje aktuálny build (web / mobilná appka).
//
// Kanonický webový href (napr. zo servera: "/vozidla/<id>") sa preloží cez
// lib/app-routes.ts. Ak cieľ v tomto builde neexistuje (mobilná appka zatiaľ
// nemá faktúry, partnerov, priečinky, chat), obsah sa vykreslí BEZ odkazu
// (obyčajný <div> s rovnakou triedou) — nikdy mŕtvy odkaz na prázdnu
// stránku. Na webe je správanie identické s next/link.
// =============================================================================

type AppLinkProps = Omit<ComponentProps<typeof Link>, "href"> & {
  href: string;
  children: ReactNode;
};

export function AppLink({ href, children, className, onClick, ...rest }: AppLinkProps) {
  const resolved = resolveAppHref(href);
  if (!resolved) {
    return <div className={className}>{children}</div>;
  }
  return (
    <Link href={resolved} className={className} onClick={onClick} {...rest}>
      {children}
    </Link>
  );
}
