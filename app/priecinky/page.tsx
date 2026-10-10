"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import BackLink from "@/app/components/BackLink";
import { getMyActiveMembership, hasFinanceManage, type MyActiveMembership } from "@/lib/company";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { formatDate } from "@/lib/i18n/format";
import {
  createDocumentFolder,
  listDocumentFolders,
  type DocumentFolder,
} from "@/lib/document-folders";
import {
  DocumentHeader,
  DocumentNotice,
  DocumentPageShell,
  docButtonPrimary,
  docField,
  docLabel,
} from "@/app/components/document/DocumentLayout";
import { EmptyState, LoadingRows } from "@/app/components/ui/Primitives";
import { FolderIcon, ChevronRightIcon } from "@/app/components/icons/AppIcons";
import { navigateHard } from "@/lib/app-navigation";
import { folderDetailHref } from "@/lib/entity-links";
import { type MutationKeyRef } from "@/lib/idempotent-insert";

// Idempotency kľúč pre retry toho istého vytvorenia (lib/idempotent-insert.ts).
const FOLDER_CREATE_MUTATION: MutationKeyRef = { current: null };

// =============================================================================
// /priecinky — zoznam priečinkov dokladov.
//
// Priečinok je organizačná zbierka odkazov naprieč modulmi (faktúry aj
// doklady z Inboxu). Nič sa do neho nepresúva — pozri
// supabase/migrations/20260926100000_document_folders_and_download_events.sql.
// =============================================================================

export default function FoldersPage() {
  const { t, locale } = useLocale();
  const [membership, setMembership] = useState<MyActiveMembership | null>(null);
  const [userId, setUserId] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [folders, setFolders] = useState<DocumentFolder[]>([]);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "info" | "critical"; text: string } | null>(null);

  const canManage = hasFinanceManage(membership);

  useEffect(() => {
    void (async () => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        navigateHard("/login");
        return;
      }
      setUserId(data.session.user.id);
      const active = await getMyActiveMembership();
      setMembership(active);
      if (active && hasFinanceManage(active)) setFolders(await listDocumentFolders(supabase));
      setLoaded(true);
    })();
  }, []);

  async function handleCreate() {
    if (!membership || busy) return;
    setBusy(true);
    setNotice(null);
    const result = await createDocumentFolder(supabase, membership.company_id, userId, newName, { mutationRef: FOLDER_CREATE_MUTATION });
    setBusy(false);
    if (!result.ok) {
      setNotice({
        tone: "critical",
        text:
          result.error === "DUPLICATE_NAME"
            ? t("folders.errors.duplicateName")
            : result.error === "INVALID_NAME"
              ? t("folders.errors.invalidName")
              : result.error === "FORBIDDEN"
                ? t("folders.errors.forbidden")
                : t("folders.errors.failed"),
      });
      return;
    }
    setNewName("");
    setFolders(await listDocumentFolders(supabase));
  }

  return (
    <DocumentPageShell wide moduleContext="folders">
      <BackLink href="/" label={t("nav.dashboard")} className="mb-1 sm:mb-3" />

      <DocumentHeader
        eyebrow={
          <span className="inline-flex items-center gap-2">
            <FolderIcon size={16} />
            {t("folders.navLabel")}
          </span>
        }
        title={t("folders.title")}
        meta={t("folders.subtitle")}
      />

      {loaded && !canManage && (
        <div className="mt-3">
          <DocumentNotice>{t("folders.noAccess")}</DocumentNotice>
        </div>
      )}

      {canManage && (
        <form
          className="mt-4 rounded-doc border border-doc-border bg-doc-surface p-3 sm:p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void handleCreate();
          }}
        >
          <label htmlFor="new-folder-name" className={docLabel}>
            {t("folders.newFolder")}
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id="new-folder-name"
              value={newName}
              maxLength={120}
              onChange={(event) => setNewName(event.target.value)}
              placeholder={t("folders.namePlaceholder")}
              className={docField}
            />
            <button type="submit" disabled={busy || !newName.trim()} className={`shrink-0 ${docButtonPrimary}`}>
              {busy ? t("folders.creating") : t("folders.create")}
            </button>
          </div>
        </form>
      )}

      {notice && (
        <div className="mt-3">
          <DocumentNotice tone={notice.tone}>{notice.text}</DocumentNotice>
        </div>
      )}

      {canManage && (
        <div className="mt-4">
          {!loaded ? (
            <LoadingRows label={t("folders.loading")} />
          ) : folders.length === 0 ? (
            <EmptyState title={t("folders.empty")} />
          ) : (
            <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 sm:gap-2">
              {folders.map((folder) => (
                <li key={folder.id}>
                  <Link
                    href={folderDetailHref(folder.id)}
                    className="flex min-h-[var(--row-min-h)] items-center gap-2.5 rounded-doc border border-doc-border bg-doc-surface px-3 py-2 transition hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                  >
                    <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-doc-sm border border-doc-border bg-surface-2 text-secondary">
                      <FolderIcon size={16} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-primary">{folder.name}</span>
                      <span className="block text-xs tabular-nums text-muted-esblu">
                        {t("folders.itemCount", { count: folder.itemCount })} · {formatDate(folder.created_at, locale)}
                      </span>
                    </span>
                    <ChevronRightIcon size={16} className="shrink-0 text-muted-esblu" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </DocumentPageShell>
  );
}
