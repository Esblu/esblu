"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { useActiveMembership } from "@/hooks/use-active-membership";
import {
  activeMobileNavKey,
  isChromelessPath,
  mobileNavModel,
  type MobileNavItem,
  type MobileNavKey,
} from "@/lib/mobile-nav";
import { resolveAppHref } from "@/lib/app-routes";
import { ESBLU_BUILD_ID } from "@/lib/build-target";
import { pushLayer } from "@/lib/back-stack";
import { signOutOnThisDevice } from "@/lib/sign-out";
import { confirmAction } from "@/app/components/ui/AppDialog";
import { isKeyboardEditable } from "@/lib/mobile/lifecycle";
import {
  CarIcon,
  CloseIcon,
  FolderIcon,
  HomeIcon,
  MachineIcon,
  MoreGridIcon,
  PackageIcon,
} from "@/app/components/icons/AppIcons";
import InboxDocumentIcon from "@/app/components/icons/InboxDocumentIcon";
import InvoicesIcon from "@/app/components/icons/InvoicesIcon";
import BusinessPartnersIcon from "@/app/components/icons/BusinessPartnersIcon";
import ChatBubbleIcon from "@/app/components/icons/ChatBubbleIcon";
import SettingsIcon from "@/app/components/icons/SettingsIcon";

// =============================================================================
// Spodná navigácia mobilnej appky (Mobile M1, 2026-09-28).
//
// - mountuje sa IBA v mobilnom builde (mobile/app/layout.tsx),
// - položky z lib/mobile-nav.ts (rola + finance oprávnenia, rovnaké pravidlá
//   ako web); skrytie je UX, autorizáciu robí server,
// - na prihlásení, pozvánke, onboardingu a právnych textoch sa nezobrazuje,
// - „Viac" otvára spodný panel so sekundárnymi modulmi,
// - obsah stránok dostane rezervu dole (CSS premenná --mobile-tabbar-space
//   na <html>), takže lišta nikdy neprekryje obsah ani sticky akcie;
//   bezpečná zóna gest (safe-area) je započítaná.
// =============================================================================

const TABBAR_HEIGHT_PX = 60;

function NavIcon({ navKey, size = 22 }: { navKey: MobileNavKey; size?: number }) {
  switch (navKey) {
    case "home":
      return <HomeIcon size={size} />;
    case "inbox":
      return <InboxDocumentIcon size={size} />;
    case "invoices":
      return <InvoicesIcon size={size} />;
    case "partners":
      return <BusinessPartnersIcon size={size} />;
    case "folders":
      return <FolderIcon size={size} />;
    case "vehicles":
      return <CarIcon size={size} />;
    case "machines":
      return <MachineIcon size={size} />;
    case "inventory":
      return <PackageIcon size={size} />;
    case "chat":
      return <ChatBubbleIcon size={size} />;
    case "settings":
      return <SettingsIcon size={size} />;
  }
}

function TabButton({
  active,
  label,
  icon,
  href,
  onClick,
  expanded,
}: {
  active: boolean;
  label: string;
  icon: ReactNode;
  href?: string;
  onClick?: () => void;
  expanded?: boolean;
}) {
  const className = `flex min-h-[52px] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-xl px-1 text-[11px] font-semibold leading-tight transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring ${
    active ? "text-accent-cyan" : "text-muted-esblu hover:text-primary"
  }`;
  const content = (
    <>
      <span aria-hidden="true">{icon}</span>
      <span className="max-w-full truncate">{label}</span>
    </>
  );
  if (href) {
    return (
      <Link href={href} className={className} aria-current={active ? "page" : undefined}>
        {content}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} className={className} aria-expanded={expanded} aria-haspopup="dialog">
      {content}
    </button>
  );
}

export default function MobileTabBar() {
  const pathname = usePathname() ?? "/";
  // Otvorená klávesnica (fokus v textovom poli) → navigácia sa skryje, aby
  // pri interactiveWidget=resizes-content neprekrývala formulár ani composer.
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  useEffect(() => {
    const update = () => setKeyboardOpen(isKeyboardEditable(document.activeElement as HTMLInputElement | null));
    const deferred = () => window.setTimeout(update, 0);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", deferred);
    return () => {
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", deferred);
    };
  }, []);
  const { t } = useLocale();
  const router = useRouter();
  const { loading, signedIn, membership } = useActiveMembership();
  // Panel „Viac" je viazaný na obrazovku, na ktorej sa otvoril — zmena
  // obrazovky ho zatvorí bez ďalšieho renderu (žiadny setState v efekte).
  const [moreOpenFor, setMoreOpenFor] = useState<string | null>(null);
  const moreOpen = moreOpenFor === pathname;
  const setMoreOpen = (open: boolean | ((current: boolean) => boolean)) =>
    setMoreOpenFor((current) => {
      const next = typeof open === "function" ? open(current === pathname) : open;
      return next ? pathname : null;
    });
  const closeRef = useRef<HTMLButtonElement | null>(null);

  const model = useMemo(
    () => mobileNavModel(membership ? { role: membership.role, permissions: membership.permissions } : null),
    [membership]
  );

  // Iba ciele, ktoré v tomto builde existujú (obrana do hĺbky k testu).
  const tabs = model.tabs.filter((item) => resolveAppHref(item.href) !== null);
  const more = model.more.filter((item) => resolveAppHref(item.href) !== null);
  const visible = !loading && signedIn && tabs.length > 0 && !isChromelessPath(pathname);

  const activeKey = activeMobileNavKey(pathname, [...tabs, ...more]);
  const moreActive = activeKey !== null && more.some((item) => item.key === activeKey);

  // Rezerva pre obsah stránok (globals.css: body padding cez premennú).
  useEffect(() => {
    const root = document.documentElement;
    if (visible) root.style.setProperty("--mobile-tabbar-space", `calc(${TABBAR_HEIGHT_PX}px + var(--esblu-safe-bottom))`);
    else root.style.removeProperty("--mobile-tabbar-space");
    return () => {
      root.style.removeProperty("--mobile-tabbar-space");
    };
  }, [visible]);

  // Hardvérové/systémové „späť" a Escape zatvoria panel skôr, než odíde stránka.
  useEffect(() => {
    if (!moreOpen) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMoreOpenFor(null);
    };
    const unregister = pushLayer(() => setMoreOpenFor(null));
    window.addEventListener("keydown", onKey);
    return () => {
      unregister();
      window.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);

  async function handleLogout() {
    const confirmed = await confirmAction({ message: t("nav.logoutConfirm"), confirmLabel: t("nav.logout") });
    if (!confirmed) return;
    setMoreOpen(false);
    await signOutOnThisDevice();
    router.replace("/login");
  }

  if (!visible) return null;

  const label = (item: MobileNavItem) => t(item.labelKey);

  return (
    <>
      {moreOpen && (
        <div className="fixed inset-0 z-[46] flex items-end" role="dialog" aria-modal="true" aria-label={t("nav.moreTitle")}>
          <button
            type="button"
            className="absolute inset-0 bg-black/60"
            aria-label={t("common.buttons.close")}
            onClick={() => setMoreOpen(false)}
          />
          <div className="relative w-full rounded-t-3xl border-t border-subtle bg-surface-1 px-4 pb-[calc(var(--mobile-tabbar-space,0px)+12px)] pt-3 shadow-2xl">
            <div className="flex items-center justify-between">
              <p className="text-base font-bold text-primary">{t("nav.moreTitle")}</p>
              <button
                ref={closeRef}
                type="button"
                onClick={() => setMoreOpen(false)}
                aria-label={t("common.buttons.close")}
                className="flex h-11 w-11 items-center justify-center rounded-xl text-secondary hover:bg-surface-hover"
              >
                <CloseIcon size={20} />
              </button>
            </div>
            <ul className="mt-2 grid grid-cols-3 gap-2">
              {more.map((item) => (
                <li key={item.key}>
                  <Link
                    href={item.href}
                    className={`flex min-h-[76px] flex-col items-center justify-center gap-1.5 rounded-2xl border px-2 text-center text-xs font-semibold transition ${
                      activeKey === item.key
                        ? "border-accent-cyan/60 bg-accent-cyan/10 text-accent-cyan"
                        : "border-subtle bg-surface-2 text-primary hover:bg-surface-hover"
                    }`}
                    aria-current={activeKey === item.key ? "page" : undefined}
                  >
                    <NavIcon navKey={item.key} size={22} />
                    <span className="leading-tight">{label(item)}</span>
                  </Link>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => void handleLogout()}
              className="mt-3 flex min-h-11 w-full items-center justify-center rounded-2xl border border-subtle px-4 text-sm font-semibold text-secondary hover:bg-surface-hover"
            >
              {t("nav.logout")}
            </button>
            {ESBLU_BUILD_ID && (
              <p className="mt-2 text-center text-xs text-muted-esblu">
                {t("nav.appBuild", { build: ESBLU_BUILD_ID })}
              </p>
            )}
          </div>
        </div>
      )}

      <nav
        aria-label={t("nav.mainNavigation")}
        className={`fixed inset-x-0 bottom-0 z-[45] border-t border-subtle bg-surface-1/95 pb-[var(--esblu-safe-bottom)] backdrop-blur ${keyboardOpen ? "hidden" : ""}`}
      >
        <div className="mx-auto flex max-w-xl items-stretch gap-1 px-2 py-1" style={{ minHeight: TABBAR_HEIGHT_PX }}>
          {tabs.map((item) => (
            <TabButton
              key={item.key}
              href={item.href}
              active={activeKey === item.key}
              label={label(item)}
              icon={<NavIcon navKey={item.key} />}
            />
          ))}
          {more.length > 0 && (
            <TabButton
              active={moreOpen || moreActive}
              expanded={moreOpen}
              label={t("nav.more")}
              icon={<MoreGridIcon size={22} />}
              onClick={() => setMoreOpen((open) => !open)}
            />
          )}
        </div>
      </nav>
    </>
  );
}
