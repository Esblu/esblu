"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import {
  addItemsToFolder,
  createDocumentFolder,
  listDocumentFolders,
  moveItemsBetweenFolders,
  type DocumentFolder,
  type FolderRef,
} from "@/lib/document-folders";
import {
  DocumentModal,
  DocumentNotice,
  docButtonPrimary,
  docButtonSecondary,
  docField,
  docLabel,
} from "@/app/components/document/DocumentLayout";
import { FolderIcon } from "@/app/components/icons/AppIcons";

// =============================================================================
// Výber priečinka pre „Pridať do priečinka" / „Presunúť do priečinka".
//
// Jeden komponent pre Faktúry, Inbox aj detail priečinka. Pridanie aj presun
// menia VÝHRADNE odkazy v document_folder_items — faktúra ani dokument sa
// nehýbe. Počet v hlásení je to, čo databáza naozaj potvrdila.
// =============================================================================

export type FolderPickerResult = { folderId: string; folderName: string; affected: number; skipped: number };

export function FolderPickerModal({
  companyId,
  userId,
  refs,
  mode = "add",
  sourceFolderId,
  onClose,
  onDone,
}: {
  companyId: string;
  userId: string;
  refs: FolderRef[];
  mode?: "add" | "move";
  sourceFolderId?: string;
  onClose: () => void;
  onDone: (result: FolderPickerResult) => void;
}) {
  const { t } = useLocale();
  const [folders, setFolders] = useState<DocumentFolder[] | null>(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void listDocumentFolders(supabase).then((rows) => {
      if (!cancelled) setFolders(rows);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const candidates = (folders ?? []).filter((folder) => folder.id !== sourceFolderId);

  function errorText(code: string): string {
    if (code === "DUPLICATE_NAME") return t("folders.errors.duplicateName");
    if (code === "INVALID_NAME") return t("folders.errors.invalidName");
    if (code === "FORBIDDEN") return t("folders.errors.forbidden");
    if (code === "NOT_FOUND") return t("folders.errors.notFound");
    return t("folders.errors.failed");
  }

  async function apply(folder: { id: string; name: string }) {
    setBusy(true);
    setError("");
    const result =
      mode === "move" && sourceFolderId
        ? await moveItemsBetweenFolders(supabase, companyId, userId, sourceFolderId, folder.id, refs)
        : await addItemsToFolder(supabase, companyId, userId, folder.id, refs);
    setBusy(false);
    if (!result.ok) {
      setError(errorText(result.error));
      return;
    }
    onDone({
      folderId: folder.id,
      folderName: folder.name,
      affected: result.affected,
      skipped: (result as { skipped?: number }).skipped ?? 0,
    });
  }

  async function createAndApply() {
    setBusy(true);
    setError("");
    const created = await createDocumentFolder(supabase, companyId, userId, newName);
    setBusy(false);
    if (!created.ok) {
      setError(errorText(created.error));
      return;
    }
    await apply(created.folder);
  }

  return (
    <DocumentModal
      title={mode === "move" ? t("folders.moveToFolder") : t("folders.addToFolder")}
      eyebrow={t("folders.selectedCount", { count: refs.length })}
      onClose={onClose}
      closeLabel={t("common.buttons.close")}
      size="md"
    >
      {error && <DocumentNotice tone="critical">{error}</DocumentNotice>}

      <div>
        <p className={docLabel}>{t("folders.chooseFolder")}</p>
        {folders === null ? (
          <p className="text-sm text-muted-esblu">{t("folders.loading")}</p>
        ) : candidates.length === 0 ? (
          <p className="text-sm text-muted-esblu">
            {mode === "move" ? t("folders.noOtherFolders") : t("folders.empty")}
          </p>
        ) : (
          <ul className="max-h-72 space-y-1.5 overflow-y-auto">
            {candidates.map((folder) => (
              <li key={folder.id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void apply(folder)}
                  className="flex min-h-11 w-full items-center gap-3 rounded-doc-sm border border-doc-border px-3 py-2 text-left text-sm transition hover:bg-surface-hover disabled:opacity-40"
                >
                  <FolderIcon size={18} className="shrink-0 text-muted-esblu" />
                  <span className="min-w-0 flex-1 truncate font-medium text-primary">{folder.name}</span>
                  <span className="shrink-0 text-xs text-muted-esblu">
                    {t("folders.itemCount", { count: folder.itemCount })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <form
        className="border-t border-doc-border pt-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && newName.trim()) void createAndApply();
        }}
      >
        <label className={docLabel} htmlFor="folder-picker-new">
          {t("folders.createAndAdd")}
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id="folder-picker-new"
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

      <div className="flex justify-end">
        <button type="button" onClick={onClose} className={docButtonSecondary}>
          {t("common.buttons.cancel")}
        </button>
      </div>
    </DocumentModal>
  );
}
