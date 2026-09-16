"use client";

import { ChangeEvent, useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import BackLink from "@/app/components/BackLink";
import {
  createCompanyInvite,
  getCreateInviteErrorMessage,
  isOwnerOrAdmin,
  listMyCompanyInvites,
  listMyCompanyMembers,
  type CompanyInviteRole,
  type CompanyInviteRow,
  type CompanyMemberRole,
  type CompanyMemberRow,
} from "@/lib/company";
import {
  listMyLegalAcceptances,
  type MyLegalAcceptanceRow,
} from "@/lib/legal-acceptance";
import { legalConfig } from "@/lib/legal-config";
import { publicWebUrl } from "@/lib/public-url";
import {
  ACCOUNT_DELETION_CONFIRM_PHRASE,
  deleteMyAccount,
  fetchAccountDeletionPreflight,
  isPartialAccountDeletionError,
  stripPartialAccountDeletionMarker,
  type AccountDeletionPreflight,
} from "@/lib/account-deletion";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { formatDateTime } from "@/lib/i18n/format";
import LanguageSwitcher from "@/app/components/LanguageSwitcher";

function getMemberRoleLabels(t: (key: string) => string): Record<string, string> {
  return {
    owner: t("settings.users.roles.owner"),
    admin: t("settings.users.roles.admin"),
    employee: t("settings.users.roles.employee"),
  };
}

function getInviteStatusLabels(t: (key: string) => string): Record<string, string> {
  return {
    pending: t("settings.users.inviteStatus.pending"),
    accepted: t("settings.users.inviteStatus.accepted"),
    revoked: t("settings.users.inviteStatus.revoked"),
    expired: t("settings.users.inviteStatus.expired"),
  };
}

function buildMailto(to: string, subject: string, body: string) {
  return `mailto:${to}?subject=${encodeURIComponent(
    subject
  )}&body=${encodeURIComponent(body)}`;
}

function getFeedbackMailto(t: (key: string) => string): string {
  return buildMailto(
    "info@esblu.com",
    t("settings.feedback.mailSubject"),
    t("settings.feedback.mailBody")
  );
}

function getDocTypeLabels(t: (key: string) => string): Record<string, string> {
  return {
    terms: t("settings.privacy.docTypes.terms"),
    privacy_policy: t("settings.privacy.docTypes.privacy_policy"),
    dpa: t("settings.privacy.docTypes.dpa"),
    cookie_policy: t("settings.privacy.docTypes.cookie_policy"),
  };
}

function getExportRequestMailto(t: (key: string) => string): string {
  return buildMailto(
    "privacy@esblu.com",
    t("settings.privacy.exportMailSubject"),
    t("settings.privacy.exportMailBody")
  );
}

function getCorrectionRequestMailto(t: (key: string) => string): string {
  return buildMailto(
    "privacy@esblu.com",
    t("settings.privacy.correctionMailSubject"),
    t("settings.privacy.correctionMailBody")
  );
}

export default function NastaveniaPage() {
  const { locale, t, tCount } = useLocale();
  const MEMBER_ROLE_LABELS = getMemberRoleLabels(t);
  const INVITE_STATUS_LABELS = getInviteStatusLabels(t);
  const DOC_TYPE_LABELS = getDocTypeLabels(t);
  const feedbackMailto = getFeedbackMailto(t);
  const exportRequestMailto = getExportRequestMailto(t);
  const correctionRequestMailto = getCorrectionRequestMailto(t);
  const [userId, setUserId] = useState("");
  const [companyName, setCompanyName] = useState("");

  const [logoPath, setLogoPath] = useState("");
  const [logoUrl, setLogoUrl] = useState("");

  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");

  const [settingsLoading, setSettingsLoading] = useState(false);
  const [logoLoading, setLogoLoading] = useState(false);
  const [passwordLoading, setPasswordLoading] = useState(false);

  const [members, setMembers] = useState<CompanyMemberRow[]>([]);
  const [invites, setInvites] = useState<CompanyInviteRow[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [myRole, setMyRole] = useState<CompanyMemberRole | null>(null);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<CompanyInviteRole>("employee");
  const [inviteSubmitting, setInviteSubmitting] = useState(false);
  const [inviteError, setInviteError] = useState("");
  const [lastInviteLink, setLastInviteLink] = useState("");
  const [linkCopied, setLinkCopied] = useState(false);

  const [acceptances, setAcceptances] = useState<MyLegalAcceptanceRow[]>([]);
  const [acceptancesLoading, setAcceptancesLoading] = useState(false);

  const [showDeleteAccountModal, setShowDeleteAccountModal] = useState(false);
  // Nastaví loadCompanyUsers(), keď ownMembership neexistuje AJ preflight
  // potvrdí orphan:true (auth.users existuje, žiadne aktívne členstvo, nie
  // je owner_id žiadnej firmy) — riadi viditeľnosť sekcie "Zrušiť účet" pre
  // takýto účet (myRole je preň null, takže pôvodné {myRole && (...)}
  // gatovanie by ho inak úplne skrylo).
  const [isOrphanAccount, setIsOrphanAccount] = useState(false);
  const [deletePreflight, setDeletePreflight] =
    useState<AccountDeletionPreflight | null>(null);
  const [deletePreflightLoading, setDeletePreflightLoading] = useState(false);
  const [deletePreflightError, setDeletePreflightError] = useState("");
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  useEffect(() => {
    checkUser();
  }, []);

  async function loadCompanyUsers(currentUserId: string) {
    setUsersLoading(true);

    try {
      // Vlastný membership riadok je dostupný cez existujúcu RLS policy
      // (company_members_select_own, z 20260814110000) pre KAŽDÚ rolu
      // vrátane employee. Preto sa číta priamo z tabuľky — na rozdiel od
      // esblu_list_my_company_members()/..._invites(), ktoré sú teraz
      // vyhradené iba pre aktívneho owner/admin a employee by pre ne
      // dostal chybu (zámerne, pozri report).
      const { data: ownMembership, error: ownMembershipError } =
        await supabase
          .from("company_members")
          .select("role")
          .eq("user_id", currentUserId)
          .eq("status", "active")
          .maybeSingle();

      if (ownMembershipError) {
        throw ownMembershipError;
      }

      const role = ownMembership?.role ?? null;
      setMyRole(role);

      if (role === "owner" || role === "admin") {
        const [memberRows, inviteRows] = await Promise.all([
          listMyCompanyMembers(),
          listMyCompanyInvites(),
        ]);

        setMembers(memberRows);
        setInvites(inviteRows);
      } else {
        setMembers([]);
        setInvites([]);
      }

      if (role === null) {
        // Žiadne aktívne membership — zisti (server-side, service-role),
        // či ide o bezpečne rozpoznaného "orphan" účet (pozri
        // app/api/account/preflight/route.ts), aby appka vedela ponúknuť
        // samoobslužné zrušenie účtu aj tu. Zámerne "best effort" — pri
        // chybe iba ostane isOrphanAccount=false (sekcia sa jednoducho
        // nezobrazí, nič sa nerozbije).
        try {
          const preflight = await fetchAccountDeletionPreflight(locale);
          setIsOrphanAccount(preflight.orphan === true);
        } catch (preflightError) {
          console.error(
            "Overenie orphan stavu zlyhalo:",
            preflightError
          );
          setIsOrphanAccount(false);
        }
      } else {
        setIsOrphanAccount(false);
      }
    } catch (error) {
      console.error("Načítanie používateľov firmy zlyhalo:", error);
    } finally {
      setUsersLoading(false);
    }
  }

  async function handleCreateInvite() {
    setInviteError("");
    setLastInviteLink("");
    setLinkCopied(false);

    const normalizedEmail = inviteEmail.trim().toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      setInviteError(t("settings.users.invalidEmail"));
      return;
    }

    setInviteSubmitting(true);

    try {
      const result = await createCompanyInvite(normalizedEmail, inviteRole);
      // publicWebUrl() namiesto priameho window.location.origin — na mobile
      // (Capacitor) builde by origin bol lokálny WebView origin, nie
      // https://esblu.com, a odkaz skopírovaný/zdieľaný mimo appku by bol
      // nepoužiteľný. Pozri lib/public-url.ts.
      const inviteLink = publicWebUrl(`/invite/${result.token}`);

      setLastInviteLink(inviteLink);
      setInviteEmail("");

      if (userId) {
        await loadCompanyUsers(userId);
      }
    } catch (error) {
      setInviteError(getCreateInviteErrorMessage(error, t));
    } finally {
      setInviteSubmitting(false);
    }
  }

  async function copyInviteLink() {
    if (!lastInviteLink) return;

    try {
      await navigator.clipboard.writeText(lastInviteLink);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch (error) {
      console.error("Kopírovanie odkazu zlyhalo:", error);
    }
  }

  function getLogoPublicUrl(path: string) {
    if (!path) {
      return "";
    }

    const { data } = supabase.storage
      .from("company-logos")
      .getPublicUrl(path);

    return data.publicUrl;
  }

  async function checkUser() {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session) {
      window.location.href = "/login";
      return;
    }

    setUserId(session.user.id);
    await loadSettings(session.user.id);
    await loadCompanyUsers(session.user.id);
    await loadAcceptances();
  }

  async function loadAcceptances() {
    setAcceptancesLoading(true);
    const rows = await listMyLegalAcceptances();
    setAcceptances(rows);
    setAcceptancesLoading(false);
  }

  async function loadSettings(currentUserId: string) {
    const { data, error } = await supabase
      .from("settings")
      .select("*")
      .eq("user_id", currentUserId)
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error("Chyba pri načítaní nastavení:", error);
      return;
    }

    if (data) {
      const savedLogoPath = data.logo_path || "";

      setCompanyName(data.company_name || "");
      setLogoPath(savedLogoPath);
      setLogoUrl(getLogoPublicUrl(savedLogoPath));
    }
  }

  async function findSettingsRow() {
    return await supabase
      .from("settings")
      .select("id, logo_path")
      .eq("user_id", userId)
      .limit(1)
      .maybeSingle();
  }

  async function saveLogoPathToDatabase(path: string | null) {
    const { data, error: findError } = await findSettingsRow();

    if (findError) {
      throw findError;
    }

    if (data) {
      const { error } = await supabase
        .from("settings")
        .update({
          logo_path: path,
        })
        .eq("id", data.id)
        .eq("user_id", userId);

      if (error) {
        throw error;
      }

      return;
    }

    const { error } = await supabase.from("settings").insert({
      user_id: userId,
      company_name: companyName.trim(),
      logo_path: path,
    });

    if (error) {
      throw error;
    }
  }

  async function saveSettings() {
    if (!userId) {
      alert(t("settings.errors.notLoggedIn"));
      return;
    }

    setSettingsLoading(true);

    const { data, error: findError } = await findSettingsRow();

    if (findError) {
      setSettingsLoading(false);
      alert(t("settings.errors.settingsLoadFailed"));
      return;
    }

    if (data) {
      const { error } = await supabase
        .from("settings")
        .update({
          company_name: companyName.trim(),
        })
        .eq("id", data.id)
        .eq("user_id", userId);

      if (error) {
        setSettingsLoading(false);
        alert(t("settings.errors.settingsSaveFailedPrefix", { message: error.message }));
        return;
      }
    } else {
      const { error } = await supabase.from("settings").insert({
        user_id: userId,
        company_name: companyName.trim(),
        logo_path: logoPath || null,
      });

      if (error) {
        setSettingsLoading(false);
        alert(t("settings.errors.settingsSaveFailedPrefix", { message: error.message }));
        return;
      }
    }

    setSettingsLoading(false);
    alert(t("settings.errors.settingsSaved"));
  }

  async function compressLogo(file: File): Promise<File> {
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);

    try {
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () =>
          reject(new Error(t("settings.errors.imageLoadFailed")));
        image.src = objectUrl;
      });

      const maxSize = 800;
      const scale = Math.min(
        maxSize / image.width,
        maxSize / image.height,
        1
      );

      const width = Math.max(1, Math.round(image.width * scale));
      const height = Math.max(1, Math.round(image.height * scale));

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;

      const context = canvas.getContext("2d");

      if (!context) {
        throw new Error(t("settings.errors.imageProcessFailed"));
      }

      context.drawImage(image, 0, 0, width, height);

      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (result) => {
            if (result) {
              resolve(result);
            } else {
              reject(new Error(t("settings.errors.logoCompressFailed")));
            }
          },
          "image/webp",
          0.85
        );
      });

      return new File([blob], "company-logo.webp", {
        type: "image/webp",
      });
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  async function handleLogoChange(
    event: ChangeEvent<HTMLInputElement>
  ) {
    const selectedFile = event.target.files?.[0];

    if (!selectedFile) {
      return;
    }

    event.target.value = "";

    if (!userId) {
      alert(t("settings.errors.notLoggedIn"));
      return;
    }

    if (!selectedFile.type.startsWith("image/")) {
      alert(t("settings.errors.chooseValidImage"));
      return;
    }

    setLogoLoading(true);

    let uploadedPath = "";

    try {
      const compressedLogo = await compressLogo(selectedFile);

      if (compressedLogo.size > 2 * 1024 * 1024) {
        throw new Error(t("settings.errors.logoTooLargeAfterCompression"));
      }

      uploadedPath = `${userId}/${Date.now()}-company-logo.webp`;

      const { error: uploadError } = await supabase.storage
        .from("company-logos")
        .upload(uploadedPath, compressedLogo, {
          cacheControl: "3600",
          contentType: "image/webp",
          upsert: false,
        });

      if (uploadError) {
        throw uploadError;
      }

      const previousLogoPath = logoPath;

      await saveLogoPathToDatabase(uploadedPath);

      setLogoPath(uploadedPath);
      setLogoUrl(
        getLogoPublicUrl(uploadedPath) + `?v=${Date.now()}`
      );

      if (
        previousLogoPath &&
        previousLogoPath !== uploadedPath
      ) {
        const { error: deleteOldLogoError } =
          await supabase.storage
            .from("company-logos")
            .remove([previousLogoPath]);

        if (deleteOldLogoError) {
          console.error(
            "Staré logo sa nepodarilo vymazať:",
            deleteOldLogoError
          );
        }
      }

      alert(t("settings.errors.logoSaved"));
    } catch (error) {
      if (uploadedPath) {
        await supabase.storage
          .from("company-logos")
          .remove([uploadedPath]);
      }

      const message =
        error instanceof Error
          ? error.message
          : t("settings.errors.logoSaveFailedGeneric");

      alert(t("settings.errors.logoSaveFailedPrefix", { message }));
    } finally {
      setLogoLoading(false);
    }
  }

  async function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Kompenzačný krok pre deleteLogo(): v tomto bode je Storage objekt UŽ
  // nenávratne odstránený, takže vynechanie tohto zápisu by nechalo
  // logo_path odkazovať na neexistujúci objekt (presne ten stav, ktorému sa
  // má flow vyhnúť — DB a Storage nevie byť atomické naprieč dvoma rôznymi
  // backendmi bez distribuovanej transakcie, preto aspoň bounded retry).
  // Krátke oneskorenia (400ms/900ms) pokrývajú bežné prechodné zlyhania
  // (výpadok siete, dočasná chyba DB) bez zámerného predlžovania flow pri
  // trvalej chybe.
  async function saveLogoPathToDatabaseWithRetry(
    path: string | null,
    attempts = 3
  ) {
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await saveLogoPathToDatabase(path);
        return;
      } catch (error) {
        lastError = error;

        if (attempt < attempts) {
          await sleep(attempt * 450);
        }
      }
    }

    throw lastError;
  }

  async function deleteLogo() {
    if (!userId || !logoPath) {
      return;
    }

    const confirmed = window.confirm(
      t("settings.errors.confirmDeleteLogo")
    );

    if (!confirmed) {
      return;
    }

    setLogoLoading(true);

    const { error: storageError } = await supabase.storage
      .from("company-logos")
      .remove([logoPath]);

    if (storageError) {
      setLogoLoading(false);
      alert(
        t("settings.errors.logoStorageDeleteFailedPrefix", {
          message: storageError.message,
        })
      );
      return;
    }

    try {
      await saveLogoPathToDatabaseWithRetry(null);

      setLogoPath("");
      setLogoUrl("");

      alert(t("settings.errors.logoDeleted"));
    } catch (error) {
      // Storage objekt je už nenávratne preč (DELETE vyššie uspel), ale
      // databázový logo_path sa napriek retry nepodarilo vynulovať — DB by
      // inak odkazovala na neexistujúci objekt (rozbitý <img>). Preto sa
      // lokálny stav zámerne vyčistí aj tu (UI prestane zobrazovať mŕtvy
      // odkaz), a chybová hláška používateľa jasne vyzve na kontrolu/uloženie
      // znova, keďže DB záznam môže byť dočasne nekonzistentný.
      setLogoPath("");
      setLogoUrl("");

      const message =
        error instanceof Error
          ? error.message
          : t("settings.errors.logoDbUpdateFailed");

      alert(t("settings.errors.logoDeletedButErrorPrefix", { message }));
    } finally {
      setLogoLoading(false);
    }
  }

  async function changePassword() {
    if (newPassword.length < 8) {
      alert(t("settings.password.tooShort"));
      return;
    }

    if (newPassword !== confirmNewPassword) {
      alert(t("settings.password.mismatch"));
      return;
    }

    setPasswordLoading(true);

    const { error } = await supabase.auth.updateUser({
      password: newPassword,
    });

    setPasswordLoading(false);

    if (error) {
      alert(t("settings.password.changeFailedPrefix", { message: error.message }));
      return;
    }

    setNewPassword("");
    setConfirmNewPassword("");

    alert(t("settings.password.changed"));
  }

  async function openDeleteAccountModal() {
    setShowDeleteAccountModal(true);
    setDeleteConfirmText("");
    setDeleteError("");
    setDeletePreflightError("");
    setDeletePreflight(null);
    setDeletePreflightLoading(true);

    try {
      const preflight = await fetchAccountDeletionPreflight(locale);
      setDeletePreflight(preflight);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : t("settings.deleteModal.preflightLoadFailed");
      setDeletePreflightError(message);
    } finally {
      setDeletePreflightLoading(false);
    }
  }

  function closeDeleteAccountModal() {
    if (deleteSubmitting) {
      return;
    }

    setShowDeleteAccountModal(false);
    setDeleteConfirmText("");
    setDeleteError("");
  }

  async function confirmDeleteAccount() {
    if (!deletePreflight) {
      return;
    }

    if (
      deletePreflight.role === "owner" &&
      deleteConfirmText !== ACCOUNT_DELETION_CONFIRM_PHRASE
    ) {
      return;
    }

    setDeleteSubmitting(true);
    setDeleteError("");

    try {
      await deleteMyAccount(
        locale,
        deletePreflight.role === "owner" ? deleteConfirmText : undefined
      );

      await supabase.auth.signOut();

      window.location.href = "/login?ucet-zruseny=1";
    } catch (error) {
      // DÔLEŽITÉ: server označí chybu ako `partial: true` (pozri
      // app/api/account/delete/route.ts), keď DB/membership časť je už
      // NEVRATNE zmazaná, ale auth.users účet ostal existovať —
      // v takom prípade sa NESMIE ponechať aktívna session (používateľ by
      // sa mohol ďalej pohybovať v appke s membershipom, ktorý už
      // neexistuje). Vynútime rovnaké odhlásenie + presmerovanie ako pri
      // úspechu, iba s odlíšeným query flagom pre login stránku.
      if (isPartialAccountDeletionError(error)) {
        await supabase.auth.signOut();
        window.location.href = "/login?ucet-zruseny-ciastocne=1";
        return;
      }

      setDeleteSubmitting(false);

      const message =
        error instanceof Error
          ? stripPartialAccountDeletionMarker(error.message)
          : t("settings.deleteModal.deleteFailed");
      setDeleteError(message);
    }
  }

  return (
    <main className="app-shell-bg min-h-screen p-4 sm:p-6 lg:p-10">
      <BackLink href="/" label={t("inbox.backToMenu")} className="mb-4" />

      <div className="flex items-center gap-4">
        <img
          src="/images/settings.png"
          alt={t("settings.pageTitle")}
          className="h-20 w-20 object-contain"
        />

        <h1 className="text-4xl font-bold text-primary">
          {t("settings.pageTitle")}
        </h1>
      </div>

      <div className="mt-8 max-w-2xl space-y-6">
        <section className="rounded-3xl border border-subtle bg-surface-1 p-8 shadow-lg backdrop-blur-xl">
          <h2 className="text-2xl font-bold text-primary">
            {t("settings.language.title")}
          </h2>

          <p className="mt-2 text-sm text-muted-esblu">
            {t("settings.language.description")}
          </p>

          <div className="mt-5">
            <LanguageSwitcher />
          </div>
        </section>

        {isOwnerOrAdmin(myRole) && (
        <section className="rounded-3xl border border-subtle bg-surface-1 p-8 shadow-lg backdrop-blur-xl">
          <h2 className="text-2xl font-bold text-primary">
            {t("settings.company.title")}
          </h2>

          <div className="mt-6">
            <label className="mb-2 block font-semibold">
              {t("settings.company.nameLabel")}
            </label>

            <input
              className="w-full rounded-xl border p-3"
              placeholder={t("settings.company.namePlaceholder")}
              value={companyName}
              onChange={(event) =>
                setCompanyName(event.target.value)
              }
              disabled={settingsLoading}
            />
          </div>

          <div className="mt-6">
            <label className="mb-2 block font-semibold">
              {t("settings.company.logoLabel")}
            </label>

            {logoUrl ? (
              <div className="mb-4 flex min-h-40 items-center justify-center rounded-2xl border border-subtle bg-surface-2 p-4">
                <img
                  src={logoUrl}
                  alt={t("settings.company.logoAlt")}
                  className="max-h-36 max-w-full object-contain"
                />
              </div>
            ) : (
              <div className="mb-4 flex min-h-40 items-center justify-center rounded-2xl border border-dashed border-slate-400 bg-surface-1 p-4 text-center text-secondary">
                {t("settings.company.noLogo")}
              </div>
            )}

            <label className="btn-secondary inline-flex cursor-pointer px-6 py-3 font-semibold">
              {logoLoading
                ? t("settings.company.processingLogo")
                : logoPath
                  ? t("settings.company.changeLogo")
                  : t("settings.company.addLogo")}

              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={handleLogoChange}
                disabled={logoLoading}
                className="hidden"
              />
            </label>

            {logoPath && (
              <button
                type="button"
                onClick={deleteLogo}
                disabled={logoLoading}
                className="ml-3 rounded-xl bg-red-600 px-6 py-3 font-semibold text-white hover:bg-red-700 disabled:bg-gray-400"
              >
                {t("settings.company.deleteLogo")}
              </button>
            )}

            <p className="mt-3 text-sm text-secondary">
              {t("settings.company.logoHint")}
            </p>
          </div>

          <button
            type="button"
            onClick={saveSettings}
            disabled={settingsLoading || logoLoading}
            className="mt-8 rounded-xl bg-blue-600 px-6 py-3 text-white hover:bg-blue-700 disabled:bg-gray-400"
          >
            {settingsLoading ? t("settings.company.saving") : t("settings.company.save")}
          </button>
        </section>
        )}

        {myRole && (
          <section className="rounded-3xl border border-subtle bg-surface-1 p-8 shadow-lg backdrop-blur-xl">
            <h2 className="text-2xl font-bold text-primary">
              {t("settings.users.title")}
            </h2>

            <p className="mt-2 text-sm text-secondary">
              {t("settings.users.yourMembership")}{" "}
              <span className="font-semibold">
                {MEMBER_ROLE_LABELS[myRole] || myRole}
              </span>
            </p>

            {usersLoading ? (
              <p className="mt-4 text-sm text-secondary">{t("settings.users.loading")}</p>
            ) : (
              <>
                {members.length > 0 && (
                  <div className="mt-6">
                    <h3 className="font-semibold text-primary">{t("settings.users.membersTitle")}</h3>

                    <ul className="mt-3 space-y-2">
                      {members.map((member) => (
                        <li
                          key={member.member_id}
                          className="flex items-center justify-between rounded-xl bg-surface-2 px-4 py-3"
                        >
                          <span className="text-sm text-primary">
                            {member.email}
                          </span>
                          <span className="text-xs font-semibold text-secondary">
                            {MEMBER_ROLE_LABELS[member.role] || member.role}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {(myRole === "owner" || myRole === "admin") && (
                  <>
                    {invites.length > 0 && (
                      <div className="mt-6">
                        <h3 className="font-semibold text-primary">
                          {t("settings.users.invitesTitle")}
                        </h3>

                        <ul className="mt-3 space-y-2">
                          {invites.map((invite) => (
                            <li
                              key={invite.invite_id}
                              className="flex items-center justify-between rounded-xl bg-surface-2 px-4 py-3"
                            >
                              <span className="text-sm text-primary">
                                {invite.email}{" "}
                                <span className="text-xs text-muted-esblu">
                                  (
                                  {MEMBER_ROLE_LABELS[invite.role] ||
                                    invite.role}
                                  )
                                </span>
                              </span>
                              <span className="text-xs font-semibold text-secondary">
                                {INVITE_STATUS_LABELS[invite.status] ||
                                  invite.status}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <div className="mt-6 rounded-2xl border border-dashed border-subtle p-5">
                      <h3 className="font-semibold text-primary">
                        {t("settings.users.inviteUserTitle")}
                      </h3>

                      <div className="mt-4 space-y-3">
                        <input
                          type="email"
                          placeholder={t("settings.users.emailPlaceholder")}
                          className="w-full rounded-xl border p-3"
                          value={inviteEmail}
                          onChange={(event) =>
                            setInviteEmail(event.target.value)
                          }
                          disabled={inviteSubmitting}
                        />

                        <div className="flex flex-col gap-2 sm:flex-row">
                          <label className="flex flex-1 items-center gap-2 rounded-xl border border-subtle p-3 text-sm">
                            <input
                              type="radio"
                              name="inviteRole"
                              checked={inviteRole === "admin"}
                              onChange={() => setInviteRole("admin")}
                              disabled={inviteSubmitting}
                            />
                            {t("settings.users.roleAdmin")}
                          </label>

                          <label className="flex flex-1 items-center gap-2 rounded-xl border border-subtle p-3 text-sm">
                            <input
                              type="radio"
                              name="inviteRole"
                              checked={inviteRole === "employee"}
                              onChange={() => setInviteRole("employee")}
                              disabled={inviteSubmitting}
                            />
                            {t("settings.users.roleEmployee")}
                          </label>
                        </div>
                      </div>

                      {inviteError && (
                        <p className="mt-3 text-sm font-medium text-red-700">
                          {inviteError}
                        </p>
                      )}

                      <button
                        type="button"
                        onClick={handleCreateInvite}
                        disabled={inviteSubmitting}
                        className="mt-4 rounded-xl bg-blue-600 px-6 py-3 font-semibold text-white hover:bg-blue-700 disabled:bg-gray-400"
                      >
                        {inviteSubmitting
                          ? t("settings.users.creating")
                          : t("settings.users.inviteUser")}
                      </button>

                      {lastInviteLink && (
                        <div className="mt-4 rounded-xl bg-surface-2 p-4">
                          <p className="text-sm font-semibold text-primary">
                            {t("settings.users.inviteCreated")}
                          </p>
                          <p className="mt-2 break-all text-xs text-secondary">
                            {lastInviteLink}
                          </p>
                          <button
                            type="button"
                            onClick={copyInviteLink}
                            className="mt-3 rounded-xl border border-subtle px-4 py-2 text-sm font-semibold text-secondary hover:bg-surface-1"
                          >
                            {linkCopied ? t("settings.users.linkCopied") : t("settings.users.copyLink")}
                          </button>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </>
            )}
          </section>
        )}

        <section className="rounded-3xl border border-subtle bg-surface-1 p-8 shadow-lg backdrop-blur-xl">
          <h2 className="text-2xl font-bold text-primary">
            {t("settings.password.title")}
          </h2>

          <p className="mt-2 text-sm text-secondary">
            {t("settings.password.minLengthHint")}
          </p>

          <div className="mt-6 space-y-4">
            <div>
              <label className="mb-2 block font-semibold">
                {t("settings.password.newPasswordLabel")}
              </label>

              <input
                type="password"
                autoComplete="new-password"
                className="w-full rounded-xl border p-3"
                placeholder={t("settings.password.newPasswordPlaceholder")}
                value={newPassword}
                onChange={(event) =>
                  setNewPassword(event.target.value)
                }
                disabled={passwordLoading}
              />
            </div>

            <div>
              <label className="mb-2 block font-semibold">
                {t("settings.password.confirmPasswordLabel")}
              </label>

              <input
                type="password"
                autoComplete="new-password"
                className="w-full rounded-xl border p-3"
                placeholder={t("settings.password.confirmPasswordPlaceholder")}
                value={confirmNewPassword}
                onChange={(event) =>
                  setConfirmNewPassword(event.target.value)
                }
                disabled={passwordLoading}
              />
            </div>
          </div>

          <button
            type="button"
            onClick={changePassword}
            disabled={passwordLoading}
            className="btn-secondary mt-8 px-6 py-3 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {passwordLoading
              ? t("settings.password.changing")
              : t("settings.password.changeButton")}
          </button>
        </section>

        <section className="rounded-3xl border border-subtle bg-surface-1 p-8 shadow-lg backdrop-blur-xl">
          <h2 className="text-2xl font-bold text-primary">
            {t("settings.feedback.title")}
          </h2>

          <p className="mt-2 leading-7 text-secondary">
            {t("settings.feedback.description")}
          </p>

          <a
            href={feedbackMailto}
            className="mt-6 inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-blue-600 px-6 py-3 text-center font-semibold text-white transition hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 sm:w-auto"
          >
            {t("settings.feedback.sendButton")}
          </a>

          <p className="mt-3 text-sm leading-6 text-secondary">
            {t("settings.feedback.privacyHint")}
          </p>
        </section>

        <section className="rounded-3xl border border-subtle bg-surface-1 p-8 shadow-lg backdrop-blur-xl">
          <h2 className="text-2xl font-bold text-primary">
            {t("settings.legal.title")}
          </h2>

          <p className="mt-2 text-sm text-secondary">
            {t("settings.legal.description")}
          </p>

          <nav
            aria-label={t("settings.legal.navAriaLabel")}
            className="mt-6 grid gap-3"
          >
            <Link
              href="/ochrana-osobnych-udajov"
              className="rounded-xl border border-subtle bg-surface-2 px-5 py-3 font-semibold text-blue-700 transition hover:bg-surface-1"
            >
              {t("settings.legal.privacyLink")}
            </Link>
            <Link
              href="/podmienky-pouzivania"
              className="rounded-xl border border-subtle bg-surface-2 px-5 py-3 font-semibold text-blue-700 transition hover:bg-surface-1"
            >
              {t("settings.legal.termsLink")}
            </Link>
            <Link
              href="/cookies"
              className="rounded-xl border border-subtle bg-surface-2 px-5 py-3 font-semibold text-blue-700 transition hover:bg-surface-1"
            >
              {t("settings.legal.cookiesLink")}
            </Link>
            <Link
              href="/dpa"
              className="rounded-xl border border-subtle bg-surface-2 px-5 py-3 font-semibold text-blue-700 transition hover:bg-surface-1"
            >
              {t("settings.legal.dpaLink")}
            </Link>
            <Link
              href="/subprocessors"
              className="rounded-xl border border-subtle bg-surface-2 px-5 py-3 font-semibold text-blue-700 transition hover:bg-surface-1"
            >
              {t("settings.legal.subprocessorsLink")}
            </Link>
            <Link
              href="/kontakt"
              className="rounded-xl border border-subtle bg-surface-2 px-5 py-3 font-semibold text-blue-700 transition hover:bg-surface-1"
            >
              {t("settings.legal.contactLink")}
            </Link>
          </nav>
        </section>

        <section className="rounded-3xl border border-subtle bg-surface-1 p-8 shadow-lg backdrop-blur-xl">
          <h2 className="text-2xl font-bold text-primary">
            {t("settings.privacy.title")}
          </h2>

          <p className="mt-2 text-sm text-secondary">
            {t("settings.privacy.description")}
          </p>

          <div className="mt-6">
            <h3 className="font-semibold text-primary">
              {t("settings.privacy.confirmedDocsTitle")}
            </h3>

            {acceptancesLoading ? (
              <p className="mt-3 text-sm text-secondary">{t("settings.privacy.loading")}</p>
            ) : acceptances.length > 0 ? (
              <ul className="mt-3 space-y-2">
                {acceptances.map((row) => (
                  <li
                    key={`${row.document_type}-${row.version}`}
                    className="flex flex-col gap-1 rounded-xl bg-surface-2 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
                  >
                    <span className="font-semibold text-primary">
                      {DOC_TYPE_LABELS[row.document_type] || row.document_type}{" "}
                      <span className="font-normal text-muted-esblu">
                        {t("settings.privacy.versionLabel", { version: row.version })}
                      </span>
                    </span>
                    <span className="text-xs text-muted-esblu">
                      {t("settings.privacy.confirmedAt", {
                        date: formatDateTime(row.accepted_at, locale),
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-secondary">
                {t("settings.privacy.noAcceptancesYet")}
              </p>
            )}

            <p className="mt-3 text-xs text-muted-esblu">
              {t("settings.privacy.currentVersions", {
                terms: legalConfig.termsVersion,
                privacy: legalConfig.privacyPolicyVersion,
              })}
            </p>
          </div>

          <div className="mt-8 grid gap-3 sm:grid-cols-2">
            <a
              href={exportRequestMailto}
              className="rounded-xl border border-subtle bg-surface-2 px-5 py-3 text-center font-semibold text-blue-700 transition hover:bg-surface-1"
            >
              {t("settings.privacy.requestExport")}
            </a>
            <a
              href={correctionRequestMailto}
              className="rounded-xl border border-subtle bg-surface-2 px-5 py-3 text-center font-semibold text-blue-700 transition hover:bg-surface-1"
            >
              {t("settings.privacy.requestCorrection")}
            </a>
          </div>

        </section>

        {(myRole || isOrphanAccount) && (
          <section className="rounded-2xl border border-subtle/60 bg-surface-1/60 p-6">
            <h2 className="text-sm font-semibold text-secondary">
              {t("settings.deleteAccount.title")}
            </h2>

            {myRole === "owner" ? (
              <p className="mt-2 text-sm text-muted-esblu">
                {t("settings.deleteAccount.ownerDescription")}
              </p>
            ) : myRole ? (
              <p className="mt-2 text-sm text-muted-esblu">
                {t("settings.deleteAccount.memberDescription")}
              </p>
            ) : (
              <p className="mt-2 text-sm text-muted-esblu">
                {t("settings.deleteAccount.orphanDescription")}
              </p>
            )}

            <button
              type="button"
              onClick={openDeleteAccountModal}
              className="mt-4 rounded-xl border border-red-900/50 px-5 py-2.5 text-sm font-semibold text-red-400/90 transition hover:border-red-700 hover:bg-red-950/30 hover:text-red-300"
            >
              {t("settings.deleteAccount.button")}
            </button>
          </section>
        )}
      </div>

      {showDeleteAccountModal && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-3 sm:items-center sm:p-4">
          <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-3xl bg-surface-1 p-5 shadow-2xl sm:p-8">
            <div className="flex items-center justify-between">
              <h2 className="text-2xl font-bold text-primary">
                {deletePreflight?.role === "owner"
                  ? t("settings.deleteModal.ownerTitle")
                  : t("settings.deleteModal.genericTitle")}
              </h2>

              <button
                type="button"
                onClick={closeDeleteAccountModal}
                disabled={deleteSubmitting}
                className="rounded-xl bg-surface-2 px-4 py-2 disabled:opacity-50"
              >
                {t("settings.deleteModal.close")}
              </button>
            </div>

            {deletePreflightLoading ? (
              <p className="mt-6 text-sm text-secondary">
                {t("settings.deleteModal.loading")}
              </p>
            ) : deletePreflightError ? (
              <p className="mt-6 text-sm font-medium text-red-400">
                {deletePreflightError}
              </p>
            ) : deletePreflight?.role === "owner" ? (
              <div className="mt-6 space-y-4">
                <p className="text-sm leading-6 text-secondary">
                  {t("settings.deleteModal.irreversibleIntro")}
                </p>

                <ul className="list-disc space-y-1 pl-5 text-sm text-secondary">
                  <li>{t("settings.deleteModal.deleteItemCompany")}</li>
                  <li>{t("settings.deleteModal.deleteItemAiEvidence")}</li>
                  <li>{t("settings.deleteModal.deleteItemVehicles")}</li>
                  <li>{t("settings.deleteModal.deleteItemMachines")}</li>
                  <li>{t("settings.deleteModal.deleteItemInventory")}</li>
                  <li>{t("settings.deleteModal.deleteItemPhotos")}</li>
                  <li>{t("settings.deleteModal.deleteItemInvites")}</li>
                  <li>{t("settings.deleteModal.deleteItemMemberships")}</li>
                </ul>

                <p className="text-sm leading-6 text-secondary">
                  {deletePreflight.otherActiveMembersCount > 0
                    ? tCount("settings.deleteModal.otherMembersWarning", deletePreflight.otherActiveMembersCount, {
                        count: deletePreflight.otherActiveMembersCount,
                      })
                    : t("settings.deleteModal.noOtherMembers")}
                </p>

                <div>
                  <label className="mb-2 block text-sm font-semibold text-primary">
                    {t("settings.deleteModal.confirmPhraseLabel", {
                      phrase: ACCOUNT_DELETION_CONFIRM_PHRASE,
                    })}
                  </label>

                  <input
                    type="text"
                    className="w-full rounded-xl border p-3"
                    value={deleteConfirmText}
                    onChange={(event) =>
                      setDeleteConfirmText(event.target.value)
                    }
                    disabled={deleteSubmitting}
                    autoComplete="off"
                  />
                </div>

                {deleteError && (
                  <p className="text-sm font-medium text-red-400">
                    {deleteError}
                  </p>
                )}

                <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
                  <button
                    type="button"
                    onClick={closeDeleteAccountModal}
                    disabled={deleteSubmitting}
                    className="btn-secondary px-6 py-3 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {t("settings.deleteModal.cancel")}
                  </button>

                  <button
                    type="button"
                    onClick={confirmDeleteAccount}
                    disabled={
                      deleteSubmitting ||
                      deleteConfirmText !== ACCOUNT_DELETION_CONFIRM_PHRASE
                    }
                    className="rounded-xl bg-red-600 px-6 py-3 font-semibold text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-gray-500 disabled:opacity-60"
                  >
                    {deleteSubmitting
                      ? t("settings.deleteModal.deletingAccount")
                      : t("settings.deleteModal.deletePermanently")}
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-6 space-y-4">
                {deletePreflight?.orphan ? (
                  <p className="text-sm leading-6 text-secondary">
                    {t("settings.deleteModal.orphanIrreversible")}
                  </p>
                ) : (
                  <p className="text-sm leading-6 text-secondary">
                    {t("settings.deleteModal.memberIrreversible")}
                  </p>
                )}

                {deleteError && (
                  <p className="text-sm font-medium text-red-400">
                    {deleteError}
                  </p>
                )}

                <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
                  <button
                    type="button"
                    onClick={closeDeleteAccountModal}
                    disabled={deleteSubmitting}
                    className="btn-secondary px-6 py-3 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {t("settings.deleteModal.cancel")}
                  </button>

                  <button
                    type="button"
                    onClick={confirmDeleteAccount}
                    disabled={deleteSubmitting}
                    className="rounded-xl bg-red-600 px-6 py-3 font-semibold text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {deleteSubmitting ? t("settings.deleteModal.deletingAccount") : t("settings.deleteModal.confirmDelete")}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
