"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import BackLink from "@/app/components/BackLink";
import { getMyActiveMembership, hasFinanceManage, type MyActiveMembership } from "@/lib/company";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { formatDate, formatMoney } from "@/lib/i18n/format";
import {
  deleteDocumentFolder,
  listFolderItemViews,
  removeItemsFromFolder,
  renameDocumentFolder,
  type FolderItemView,
  type FolderRef,
} from "@/lib/document-folders";
import {
  downloadDocumentPackage,
  loadDownloadStates,
  PackageDownloadError,
} from "@/lib/document-package-client";
import {
  downloadStateOf,
  matchesDownloadFilter,
  DOWNLOAD_FILTERS,
  type DownloadFilter,
  type DownloadState,
} from "@/lib/invoicing/document-package";
import {
  DocumentHeader,
  DocumentModal,
  DocumentNotice,
  DocumentPageShell,
  docButtonDanger,
  docButtonPrimary,
  docButtonSecondary,
  docField,
} from "@/app/components/document/DocumentLayout";
import { EmptyState, FilterChips, LoadingRows } from "@/app/components/ui/Primitives";
import { CheckIcon, FolderIcon } from "@/app/components/icons/AppIcons";
import { DownloadStateBadge } from "@/app/components/folders/DownloadStateBadge";
import { FolderPickerModal } from "@/app/components/folders/FolderPickerModal";
import { describePackageOutcome, describePackageError } from "@/app/components/folders/package-messages";

// =============================================================================
// Detail priečinka: kanonické doklady z rôznych modulov na jednom mieste.
//
// Riadok ukazuje druh dokladu (vydaná/prijatá faktúra, bloček, …), dátum,
// partnera, sumu, či existuje originál a či sa už sťahoval. Odobratie z
// priečinka doklad nemaže; stiahnutie ho nezamyká.
// =============================================================================

export default function FolderDetailView({ folderId }: { folderId: string }) {
  const { t, locale } = useLocale();
  const [membership, setMembership] = useState<MyActiveMembership | null>(null);
  const [userId, setUserId] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [items, setItems] = useState<FolderItemView[]>([]);
  const [downloadStates, setDownloadStates] = useState<Map<string, DownloadState>>(new Map());
  const [filter, setFilter] = useState<DownloadFilter>("all");
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [picker, setPicker] = useState<"move" | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "info" | "warning" | "critical"; text: string } | null>(null);

  const canManage = hasFinanceManage(membership);

  const reload = useCallback(async () => {
    const { data: folder } = await supabase.from("document_folders").select("id, name").eq("id", folderId).maybeSingle();
    if (!folder) {
      setNotFound(true);
      return;
    }
    setFolderName((folder as { name: string }).name);
    const [views, states] = await Promise.all([listFolderItemViews(supabase, folderId), loadDownloadStates()]);
    setItems(views);
    setDownloadStates(states);
  }, [folderId]);

  useEffect(() => {
    void (async () => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        window.location.href = "/login";
        return;
      }
      setUserId(data.session.user.id);
      const active = await getMyActiveMembership();
      setMembership(active);
      if (active && hasFinanceManage(active)) await reload();
      setLoaded(true);
    })();
  }, [reload]);

  const key = (item: { type: string; id: string }) => `${item.type}:${item.id}`;
  const stateOf = (item: FolderItemView) => downloadStateOf(downloadStates, item.type, item.id);

  const filterCounts = useMemo(() => {
    const counts: Record<DownloadFilter, number> = { all: 0, not_downloaded: 0, downloaded: 0 };
    for (const item of items) {
      const state = downloadStateOf(downloadStates, item.type, item.id);
      for (const f of DOWNLOAD_FILTERS) if (matchesDownloadFilter(state, f)) counts[f] += 1;
    }
    return counts;
  }, [items, downloadStates]);

  const visible = items.filter((item) => matchesDownloadFilter(stateOf(item), filter));
  const selectedRefs: FolderRef[] = items
    .filter((item) => selected.includes(key(item)))
    .map((item) => ({ type: item.type, id: item.id }));

  function toggle(item: FolderItemView) {
    const k = key(item);
    setSelected((current) => (current.includes(k) ? current.filter((x) => x !== k) : [...current, k]));
  }

  function exitSelection() {
    setSelectionMode(false);
    setSelected([]);
  }

  async function handleDownload(onlySelected: boolean) {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const outcome = await downloadDocumentPackage(
        onlySelected ? { kind: "selection", items: selectedRefs } : { kind: "folder", folderId },
        locale
      );
      setNotice(describePackageOutcome(t, outcome));
      setDownloadStates(await loadDownloadStates());
    } catch (error) {
      setNotice({ tone: "critical", text: describePackageError(t, error instanceof PackageDownloadError ? error : null) });
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove() {
    if (busy || selectedRefs.length === 0) return;
    setBusy(true);
    const result = await removeItemsFromFolder(supabase, folderId, selectedRefs);
    setBusy(false);
    if (!result.ok) {
      setNotice({ tone: "critical", text: t("folders.errors.failed") });
      return;
    }
    setNotice({ tone: "info", text: t("folders.removed", { count: result.affected }) });
    exitSelection();
    await reload();
  }

  async function handleRename() {
    if (busy) return;
    setBusy(true);
    const result = await renameDocumentFolder(supabase, folderId, renameValue);
    setBusy(false);
    if (!result.ok) {
      setNotice({
        tone: "critical",
        text:
          result.error === "DUPLICATE_NAME"
            ? t("folders.errors.duplicateName")
            : result.error === "INVALID_NAME"
              ? t("folders.errors.invalidName")
              : t("folders.errors.failed"),
      });
      return;
    }
    setRenaming(false);
    await reload();
  }

  async function handleDelete() {
    if (busy) return;
    setBusy(true);
    const result = await deleteDocumentFolder(supabase, folderId);
    setBusy(false);
    if (!result.ok) {
      setConfirmDelete(false);
      setNotice({ tone: "critical", text: t("folders.errors.failed") });
      return;
    }
    window.location.href = "/priecinky";
  }

  function originalLabel(item: FolderItemView): { text: string; tone: "ok" | "warn" | "muted" } {
    if (item.kind === "missing") return { text: t("folders.original.missing"), tone: "warn" };
    if (item.draft) return { text: t("folders.original.draft"), tone: "muted" };
    if (item.kind === "issued_invoice") return { text: t("folders.original.generated"), tone: "ok" };
    return item.originalAvailable
      ? { text: t("folders.original.available"), tone: "ok" }
      : { text: t("folders.original.missing"), tone: "warn" };
  }

  if (loaded && (!canManage || notFound)) {
    return (
      <DocumentPageShell wide>
        <BackLink href="/priecinky" label={t("folders.back")} className="mb-6" />
        <DocumentNotice>{!canManage ? t("folders.noAccess") : t("folders.errors.notFound")}</DocumentNotice>
      </DocumentPageShell>
    );
  }

  const COLUMNS = "sm:grid-cols-[minmax(0,2.2fr)_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1.3fr)]";

  return (
    <DocumentPageShell
      wide
      moduleContext="folders"
      folderContextId={folderId}
      voiceSelection={selectedRefs.length > 0 ? { items: selectedRefs, folderId } : null}
    >
      <BackLink href="/priecinky" label={t("folders.back")} className="mb-6" />

      <DocumentHeader
        eyebrow={
          <span className="inline-flex items-center gap-2">
            <FolderIcon size={18} />
            {t("folders.navLabel")}
          </span>
        }
        title={
          renaming ? (
            <form
              className="flex flex-col gap-2 sm:flex-row"
              onSubmit={(event) => {
                event.preventDefault();
                void handleRename();
              }}
            >
              <input
                value={renameValue}
                maxLength={120}
                onChange={(event) => setRenameValue(event.target.value)}
                aria-label={t("folders.nameLabel")}
                className={docField}
                autoFocus
              />
              <div className="flex gap-2">
                <button type="submit" disabled={busy} className={docButtonPrimary}>
                  {t("folders.renameSave")}
                </button>
                <button type="button" onClick={() => setRenaming(false)} className={docButtonSecondary}>
                  {t("common.buttons.cancel")}
                </button>
              </div>
            </form>
          ) : (
            folderName ?? "…"
          )
        }
        meta={`${t("folders.itemCount", { count: items.length })} · ${t("folders.downloadHint")}`}
        aside={
          canManage ? (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void handleDownload(false)}
                disabled={busy || items.length === 0}
                aria-busy={busy}
                className={docButtonPrimary}
              >
                {busy ? t("folders.downloading") : t("folders.downloadFolder")}
              </button>
              {!renaming && (
                <button
                  type="button"
                  onClick={() => {
                    setRenameValue(folderName ?? "");
                    setRenaming(true);
                  }}
                  className={docButtonSecondary}
                >
                  {t("folders.rename")}
                </button>
              )}
              <button type="button" onClick={() => setConfirmDelete(true)} className={docButtonDanger}>
                {t("folders.deleteFolder")}
              </button>
            </div>
          ) : undefined
        }
      />

      {notice && (
        <div className="mt-4">
          <DocumentNotice tone={notice.tone}>{notice.text}</DocumentNotice>
        </div>
      )}

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <FilterChips
          label={t("folders.filter.label")}
          active={filter}
          onSelect={(value) => setFilter(value as DownloadFilter)}
          options={DOWNLOAD_FILTERS.map((f) => ({ key: f, label: t(`folders.filter.${f}`), count: filterCounts[f] }))}
        />
        {items.length > 0 && (
          <button
            type="button"
            onClick={() => (selectionMode ? exitSelection() : setSelectionMode(true))}
            className={docButtonSecondary}
          >
            {selectionMode ? t("folders.selectionCancel") : t("folders.select")}
          </button>
        )}
      </div>

      {selectionMode && selected.length > 0 && (
        <div className="sticky bottom-4 z-10 mt-3 rounded-doc border border-doc-border bg-surface-1/95 p-3 backdrop-blur">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium text-primary">{t("folders.selectedCount", { count: selected.length })}</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={busy} onClick={() => void handleDownload(true)} className={docButtonPrimary}>
                {t("folders.downloadSelected")}
              </button>
              <button type="button" disabled={busy} onClick={() => setPicker("move")} className={docButtonSecondary}>
                {t("folders.moveToFolder")}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleRemove()}
                title={t("folders.removeHint")}
                className={docButtonSecondary}
              >
                {t("folders.removeFromFolder")}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="mt-4">
        {!loaded ? (
          <LoadingRows label={t("folders.loading")} />
        ) : items.length === 0 ? (
          <EmptyState title={t("folders.emptyFolder")} />
        ) : (
          <ul className="space-y-1.5">
            {visible.map((item) => {
              const original = originalLabel(item);
              const isSelected = selected.includes(key(item));
              const body = (
                <>
                  <div className="flex min-w-0 items-start gap-2.5">
                    {selectionMode && (
                      <span
                        aria-hidden="true"
                        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] border ${
                          isSelected ? "border-transparent bg-accent-esblu text-on-accent" : "border-doc-border"
                        }`}
                      >
                        {isSelected && <CheckIcon size={12} />}
                      </span>
                    )}
                    <div className="min-w-0">
                      <p className="truncate text-base font-medium text-primary sm:text-sm">
                        {item.label || t(`folders.kind.${item.kind}`)}
                      </p>
                      <p className="mt-0.5 truncate text-sm text-muted-esblu">
                        {t(`folders.kind.${item.kind}`)}
                        {item.date ? ` · ${formatDate(item.date, locale)}` : ""}
                      </p>
                    </div>
                  </div>
                  <p className="mt-1 truncate text-sm text-secondary sm:mt-0">{item.partner || "—"}</p>
                  <p className="mt-1 text-base font-semibold tabular-nums text-primary sm:mt-0 sm:text-right sm:text-sm">
                    {item.amount !== null && Number.isFinite(item.amount)
                      ? formatMoney(item.amount, item.currency, locale)
                      : "—"}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 sm:mt-0 sm:justify-end">
                    <span
                      className={`rounded-doc-sm px-2 py-0.5 text-xs font-medium ${
                        original.tone === "ok"
                          ? "bg-surface-2 text-secondary"
                          : original.tone === "warn"
                            ? "bg-warning-soft text-warning"
                            : "bg-surface-2 text-muted-esblu"
                      }`}
                    >
                      {original.text}
                    </span>
                    <DownloadStateBadge state={stateOf(item)} showNever />
                  </div>
                </>
              );
              const rowClass = `block w-full rounded-doc border border-doc-border bg-doc-surface px-4 py-3 text-left transition hover:bg-surface-hover sm:grid sm:items-center sm:gap-4 ${COLUMNS}`;
              return (
                <li key={key(item)}>
                  {selectionMode ? (
                    <button type="button" onClick={() => toggle(item)} aria-pressed={isSelected} className={rowClass}>
                      {body}
                    </button>
                  ) : item.href ? (
                    <Link href={item.href} className={rowClass}>
                      {body}
                    </Link>
                  ) : (
                    <div className={rowClass}>{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <p className="mt-6 text-sm text-muted-esblu">{t("folders.semantics")}</p>

      {picker && membership && (
        <FolderPickerModal
          companyId={membership.company_id}
          userId={userId}
          refs={selectedRefs}
          mode="move"
          sourceFolderId={folderId}
          onClose={() => setPicker(null)}
          onDone={async (result) => {
            setPicker(null);
            setNotice({ tone: "info", text: t("folders.moved", { name: result.folderName, count: selectedRefs.length }) });
            exitSelection();
            await reload();
          }}
        />
      )}

      {confirmDelete && (
        <DocumentModal
          title={t("folders.deleteConfirmTitle", { name: folderName ?? "" })}
          onClose={() => setConfirmDelete(false)}
          closeLabel={t("common.buttons.close")}
          size="md"
          footer={
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" onClick={() => setConfirmDelete(false)} className={docButtonSecondary}>
                {t("common.buttons.cancel")}
              </button>
              <button type="button" disabled={busy} onClick={() => void handleDelete()} className={docButtonDanger}>
                {t("folders.deleteFolder")}
              </button>
            </div>
          }
        >
          <p className="text-sm text-secondary">{t("folders.deleteConfirmBody", { count: items.length })}</p>
        </DocumentModal>
      )}
    </DocumentPageShell>
  );
}
