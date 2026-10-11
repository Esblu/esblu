"use client";

import { ChangeEvent, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { flushMediaDeletions } from "@/lib/storage/media-deletion";
import { signMediaUrl } from "@/lib/storage/signed-media";
import BackLink from "@/app/components/BackLink";
import {
  createCompanyInvite,
  getCompanyProfile,
  getCreateInviteErrorMessage,
  hasFinanceManage,
  hasFinanceView,
  listMyCompanyInvites,
  listMyCompanyMembers,
  type CompanyInviteRole,
  type CompanyInviteRow,
  type CompanyMemberRole,
  type CompanyMemberRow,
  type MemberPermissions,
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
import { LOCALE_LABELS } from "@/lib/i18n/locales";
import {
  EMPTY_COMPANY_BILLING_PROFILE_FORM,
  billingProfileToForm,
  getCompanyBillingProfile,
  saveCompanyBillingProfileLogoPath,
  upsertCompanyBillingProfile,
  validateCompanyBillingProfileForm,
  type CompanyBillingProfileForm,
  type CompanyBillingProfileValidationError,
} from "@/lib/company-billing-profile";
import { PushNotificationSettings } from "@/app/components/push/PushNotificationSettings";
import { navigateHard } from "@/lib/app-navigation";
import { confirmAction } from "@/app/components/ui/AppDialog";
import { signOutOnThisDevice } from "@/lib/sign-out";
import {
  FormField,
  InlineNotice,
  SettingsDisclosure,
  SettingsLinkRow,
  SettingsRow,
  SettingsSection,
} from "@/app/components/ui/SettingsList";
import { ImageIcon, TrashIcon } from "@/app/components/icons/AppIcons";

type SectionNotice = { tone: "success" | "error"; text: string } | null;

/**
 * Role, ktoré sa dajú pozvať. Zrkadlí DB allowlist v
 * esblu_create_company_invite — majiteľ sa nepozýva, ten firmu zakladá.
 */
const INVITE_ROLE_OPTIONS: {
  value: CompanyInviteRole;
  labelKey: string;
  hintKey: string;
}[] = [
  {
    value: "admin",
    labelKey: "settings.users.roleAdmin",
    hintKey: "settings.users.roleAdminHint",
  },
  {
    value: "accountant",
    labelKey: "settings.users.roleAccountant",
    hintKey: "settings.users.roleAccountantHint",
  },
  {
    value: "employee",
    labelKey: "settings.users.roleEmployee",
    hintKey: "settings.users.roleEmployeeHint",
  },
];

function getMemberRoleLabels(t: (key: string) => string): Record<string, string> {
  return {
    owner: t("settings.users.roles.owner"),
    admin: t("settings.users.roles.admin"),
    accountant: t("settings.users.roles.accountant"),
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
  const [companyId, setCompanyId] = useState("");

  // company_billing_profile (Fáza 1B) — jediný living source-of-truth pre
  // firemné/fakturačné údaje. NAHRÁDZA predošlé settings.company_name/
  // settings.logo_path (tie appka od tejto fázy ďalej nečíta/nezapisuje —
  // pozri lib/company-billing-profile.ts).
  const [billingProfile, setBillingProfile] = useState<CompanyBillingProfileForm>(
    EMPTY_COMPANY_BILLING_PROFILE_FORM
  );
  const [billingProfileErrors, setBillingProfileErrors] = useState<
    CompanyBillingProfileValidationError[]
  >([]);

  const [logoPath, setLogoPath] = useState("");
  const [logoUrl, setLogoUrl] = useState("");

  // Finance Access Hardening — billingProfile/logoPath/logoUrl vyššie sa
  // napĺňajú IBA keď má prihlásený používateľ finance view/manage (pozri
  // loadBillingProfile nižšie). Bez finance prístupu appka namiesto toho
  // natiahne VÝHRADNE branding (názov+logo) cez bezpečnú
  // esblu_get_company_profile() RPC (getCompanyProfile()) — tá NIKDY
  // nevracia IČO/DIČ/IBAN a pod., takže citlivé billing polia sa do
  // browseru pre non-finance používateľa vôbec nedostanú (obranná vrstva
  // navyše, nezávislá od toho, čo appka v UI skryje/zobrazí).
  const [brandingOnlyName, setBrandingOnlyName] = useState("");
  const [brandingOnlyLogoUrl, setBrandingOnlyLogoUrl] = useState("");
  const [myPermissions, setMyPermissions] = useState<MemberPermissions>({});

  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");

  const [settingsLoading, setSettingsLoading] = useState(false);
  const [logoLoading, setLogoLoading] = useState(false);
  const [passwordLoading, setPasswordLoading] = useState(false);

  const [members, setMembers] = useState<CompanyMemberRow[]>([]);
  const [invites, setInvites] = useState<CompanyInviteRow[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [myRole, setMyRole] = useState<CompanyMemberRole | null>(null);
  // Finance Access Hardening — owner vždy, inak iba explicitné
  // permissions.finance.view/manage (nie role==='admin'). Iba UI vrstva —
  // reálne vynútenie je RLS (esblu_my_finance_view/manage()).
  const financeView = hasFinanceView({ role: myRole, permissions: myPermissions });
  const financeManage = hasFinanceManage({ role: myRole, permissions: myPermissions });

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

  // UI refresh 2026-10-11: rozbaľovacie skupiny a inline správy namiesto
  // window.alert() (alert blokuje celé WebView a pôsobí ako chyba appky).
  const [companyOpen, setCompanyOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [acceptancesOpen, setAcceptancesOpen] = useState(false);
  const [companyNotice, setCompanyNotice] = useState<SectionNotice>(null);
  const [logoNotice, setLogoNotice] = useState<SectionNotice>(null);
  const [passwordNotice, setPasswordNotice] = useState<SectionNotice>(null);

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
          .select("role, company_id, permissions")
          .eq("user_id", currentUserId)
          .eq("status", "active")
          .maybeSingle();

      if (ownMembershipError) {
        throw ownMembershipError;
      }

      const role = ownMembership?.role ?? null;
      setMyRole(role);

      const permissions = (ownMembership?.permissions ?? {}) as MemberPermissions;
      setMyPermissions(permissions);

      const activeCompanyId = ownMembership?.company_id ?? "";
      setCompanyId(activeCompanyId);

      if (activeCompanyId) {
        if (hasFinanceView({ role, permissions })) {
          await loadBillingProfile(activeCompanyId);
        } else {
          // Bez finance prístupu sa NIKDY nevolá priamy SELECT na
          // company_billing_profile (RLS by aj tak vrátila 0 riadkov) —
          // iba bezpečná branding-only RPC (legal_name/logo_path, žiadne
          // IČO/DIČ/IBAN).
          await loadBrandingOnly();
        }
      }

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

  // Súkromný bucket company-logos: krátkodobá podpísaná URL. `force` po
  // nahratí nového loga obíde cache (lib/storage/signed-media.ts).
  async function getLogoSignedUrl(path: string, force = false) {
    if (!path) {
      return "";
    }

    return signMediaUrl("company-logos", path, { force });
  }

  async function checkUser() {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session) {
      navigateHard("/login");
      return;
    }

    setUserId(session.user.id);
    // companyId sa nastaví v loadCompanyUsers() (company_members riadok) —
    // loadBillingProfile() sa odtiaľ zavolá hneď, keď je companyId známe
    // (pozri loadCompanyUsers vyššie). Samotné company_billing_profile už
    // NEZÁVISÍ od settings — settings sa od Fázy 1B na firemný branding
    // ďalej nepoužíva (legacy stĺpce company_name/logo_path v settings
    // appka odteraz ani nečíta, ani nezapisuje).
    await loadCompanyUsers(session.user.id);
    await loadAcceptances();
  }

  async function loadAcceptances() {
    setAcceptancesLoading(true);
    const rows = await listMyLegalAcceptances();
    setAcceptances(rows);
    setAcceptancesLoading(false);
  }

  async function loadBillingProfile(activeCompanyId: string) {
    try {
      const profile = await getCompanyBillingProfile(activeCompanyId);

      setBillingProfile(billingProfileToForm(profile));
      // Nevyplnený profil → formulár otvorený (prvé nastavenie firmy).
      if (!profile?.legal_name) setCompanyOpen(true);

      const savedLogoPath = profile?.logo_path || "";
      setLogoPath(savedLogoPath);
      setLogoUrl(savedLogoPath ? await getLogoSignedUrl(savedLogoPath) : "");
    } catch (error) {
      console.error("Načítanie firemného profilu zlyhalo:", error);
    }
  }

  // Branding-only náčítanie pre používateľa BEZ finance prístupu — cez
  // esblu_get_company_profile() (SECURITY DEFINER, obchádza RLS na
  // company_billing_profile úplne), vracia iba legal_name/logo_path.
  // billingProfile/logoPath state sa tu zámerne NEPOUŽÍVA — ostávajú
  // prázdne, aby žiadne billing pole nebolo ani v pamäti prehliadača.
  async function loadBrandingOnly() {
    try {
      const profile = await getCompanyProfile();
      setBrandingOnlyName(profile?.company_name || "");
      setBrandingOnlyLogoUrl(
        profile?.logo_path ? await getLogoSignedUrl(profile.logo_path) : ""
      );
    } catch (error) {
      console.error("Načítanie firemného brandingu zlyhalo:", error);
    }
  }

  async function saveLogoPathToDatabase(path: string | null) {
    if (!companyId) {
      throw new Error(t("settings.errors.notLoggedIn"));
    }

    await saveCompanyBillingProfileLogoPath(companyId, userId, path);
  }

  async function saveSettings() {
    setCompanyNotice(null);
    if (!userId || !companyId) {
      setCompanyNotice({ tone: "error", text: t("settings.errors.notLoggedIn") });
      return;
    }

    const { errors, payload } = validateCompanyBillingProfileForm(billingProfile);
    setBillingProfileErrors(errors);

    if (errors.length > 0 || !payload) {
      setCompanyOpen(true);
      setCompanyNotice({ tone: "error", text: t("settings.errors.settingsSaveFailedPrefix", { message: t("settings.company.validationFailed") }) });
      return;
    }

    setSettingsLoading(true);

    try {
      // logoPath sa zámerne NEODOVZDÁVA (upsertCompanyBillingProfile ho pri
      // undefined nemení) — logo má vlastný, samostatný Storage+DB flow
      // (handleLogoChange/deleteLogo), uloženie textových polí formulára ho
      // nikdy nesmie vedľajškovo prepísať.
      // Bankové údaje (IBAN/BIC) mení iba majiteľ — pre ostatných sa do
      // uloženia vôbec neposielajú (DB trigger zmenu ne-ownerom odmietne).
      const { iban: _iban, bic: _bic, ...withoutBank } = payload;
      void _iban;
      void _bic;
      await upsertCompanyBillingProfile(companyId, userId, myRole === "owner" ? payload : withoutBank);
      setSettingsLoading(false);
      setCompanyNotice({ tone: "success", text: t("settings.errors.settingsSaved") });
    } catch (error) {
      setSettingsLoading(false);
      const message = error instanceof Error ? error.message : String(error);
      setCompanyNotice({
        tone: "error",
        text: message.includes("ESBLU_BANK_DETAILS_OWNER_ONLY")
          ? t("settings.company.bankDetailsOwnerOnly")
          : t("settings.errors.settingsSaveFailedPrefix", { message }),
      });
    }
  }

  function updateBillingProfileField(
    field: keyof CompanyBillingProfileForm,
    value: string
  ) {
    setBillingProfile((previous) => ({ ...previous, [field]: value }));
  }

  function billingProfileFieldError(field: keyof CompanyBillingProfileForm): string {
    const found = billingProfileErrors.find((error) => error.field === field);
    return found ? t(`settings.company.errors.${found.messageKey}`) : "";
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
    setLogoNotice(null);

    if (!userId) {
      setLogoNotice({ tone: "error", text: t("settings.errors.notLoggedIn") });
      return;
    }

    if (!selectedFile.type.startsWith("image/")) {
      setLogoNotice({ tone: "error", text: t("settings.errors.chooseValidImage") });
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
      setLogoUrl(await getLogoSignedUrl(uploadedPath, true));

      if (
        previousLogoPath &&
        previousLogoPath !== uploadedPath
      ) {
        // Staré logo je po zmene logo_path vo fronte mazania (trigger);
        // pri zlyhaní ostáva evidované a zopakuje sa.
        const cleanup = await flushMediaDeletions(supabase);

        if (cleanup.remaining !== 0) {
          console.error("Staré logo čaká na dokončenie mazania v úložisku.");
        }
      }

      setLogoNotice({ tone: "success", text: t("settings.errors.logoSaved") });
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

      setLogoNotice({ tone: "error", text: t("settings.errors.logoSaveFailedPrefix", { message }) });
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

    const confirmed = (await confirmAction({ message: t("settings.errors.confirmDeleteLogo"), destructive: true }));

    if (!confirmed) {
      return;
    }

    setLogoLoading(true);
    setLogoNotice(null);

    const { error: storageError } = await supabase.storage
      .from("company-logos")
      .remove([logoPath]);

    if (storageError) {
      setLogoLoading(false);
      setLogoNotice({
        tone: "error",
        text: t("settings.errors.logoStorageDeleteFailedPrefix", {
          message: storageError.message,
        }),
      });
      return;
    }

    try {
      await saveLogoPathToDatabaseWithRetry(null);
      // Logo bolo zmazané ešte pri existujúcom zázname; vynulovanie cesty
      // ho zapísalo do fronty — sweep to overí a uzavrie.
      await flushMediaDeletions(supabase);

      setLogoPath("");
      setLogoUrl("");

      setLogoNotice({ tone: "success", text: t("settings.errors.logoDeleted") });
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

      setLogoNotice({ tone: "error", text: t("settings.errors.logoDeletedButErrorPrefix", { message }) });
    } finally {
      setLogoLoading(false);
    }
  }

  async function changePassword() {
    setPasswordNotice(null);
    if (newPassword.length < 8) {
      setPasswordNotice({ tone: "error", text: t("settings.password.tooShort") });
      return;
    }

    if (newPassword !== confirmNewPassword) {
      setPasswordNotice({ tone: "error", text: t("settings.password.mismatch") });
      return;
    }

    setPasswordLoading(true);

    const { error } = await supabase.auth.updateUser({
      password: newPassword,
    });

    setPasswordLoading(false);

    if (error) {
      setPasswordNotice({ tone: "error", text: t("settings.password.changeFailedPrefix", { message: error.message }) });
      return;
    }

    setNewPassword("");
    setConfirmNewPassword("");

    setPasswordNotice({ tone: "success", text: t("settings.password.changed") });
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

      await signOutOnThisDevice();

      navigateHard("/login?ucet-zruseny=1");
    } catch (error) {
      // DÔLEŽITÉ: server označí chybu ako `partial: true` (pozri
      // app/api/account/delete/route.ts), keď DB/membership časť je už
      // NEVRATNE zmazaná, ale auth.users účet ostal existovať —
      // v takom prípade sa NESMIE ponechať aktívna session (používateľ by
      // sa mohol ďalej pohybovať v appke s membershipom, ktorý už
      // neexistuje). Vynútime rovnaké odhlásenie + presmerovanie ako pri
      // úspechu, iba s odlíšeným query flagom pre login stránku.
      if (isPartialAccountDeletionError(error)) {
        await signOutOnThisDevice();
        navigateHard("/login?ucet-zruseny-ciastocne=1");
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

  const canEditCompany = financeManage;
  const roleBadge = (role: string) => (
    <span className={role === "owner" ? "ui-badge ui-badge-brand" : "ui-badge"}>{MEMBER_ROLE_LABELS[role] || role}</span>
  );
  const selectedInviteRole = INVITE_ROLE_OPTIONS.find((option) => option.value === inviteRole);
  const companySummary = [billingProfile.ico && `${t("settings.company.icoLabel")} ${billingProfile.ico}`, billingProfile.city]
    .filter(Boolean)
    .join(" · ");

  function field(
    fieldKey: keyof CompanyBillingProfileForm,
    labelKey: string,
    options?: { placeholder?: string; type?: string; ownerOnly?: boolean; className?: string; inputMode?: "numeric" | "decimal" | "email" | "text"; autoComplete?: string }
  ) {
    const errorText = billingProfileFieldError(fieldKey);
    const disabled = !canEditCompany || settingsLoading || (options?.ownerOnly === true && myRole !== "owner");

    return (
      <FormField label={t(labelKey)} error={errorText || undefined} className={options?.className}>
        {(aria) => (
          <input
            {...aria}
            className="ui-input"
            type={options?.type ?? "text"}
            inputMode={options?.inputMode}
            autoComplete={options?.autoComplete ?? "off"}
            placeholder={options?.placeholder}
            value={billingProfile[fieldKey]}
            onChange={(event) => updateBillingProfileField(fieldKey, event.target.value)}
            disabled={disabled}
          />
        )}
      </FormField>
    );
  }

  const logoThumb = (url: string) => (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-doc-sm border border-doc-border bg-surface-2">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={t("settings.company.logoAlt")} className="h-full w-full object-contain" />
      ) : (
        <ImageIcon size={18} className="text-muted-esblu" aria-hidden="true" />
      )}
    </span>
  );

  return (
    <main className="app-shell-bg min-h-screen">
      <div className="ui-page max-w-2xl">
        <BackLink href="/" label={t("inbox.backToMenu")} />

        <h1 className="ui-page-title mb-3">{t("settings.pageTitle")}</h1>

        <div className="space-y-4">
          {/* ---------------- Jazyk ---------------- */}
          <SettingsSection title={t("settings.language.title")}>
            <SettingsRow title={LOCALE_LABELS[locale]} trailing={<LanguageSwitcher />} />
          </SettingsSection>

          {/* ---------------- Firma (finance view) ----------------
              Finance Access Hardening — plná sekcia "Firma" (vrátane billing
              polí IČO/DIČ/IBAN/...) sa vykresľuje iba pre finance view/manage
              (owner vždy). Bez finance prístupu sa nižšie zobrazí samostatná
              branding-only sekcia (iba názov+logo). */}
          {myRole && financeView && (
            <SettingsSection
              title={t("settings.company.title")}
              footer={!canEditCompany ? t("settings.company.readOnlyNotice") : undefined}
            >
              {/* UI polish 2: jeden riadok — názov firmy + IČO/mesto; ťuknutím
                  sa rozbalí formulár firemných a fakturačných údajov. */}
              <SettingsDisclosure
                title={billingProfile.legal_name || t("settings.ui.notSet")}
                subtitle={companySummary || t("settings.ui.companyDetails")}
                open={companyOpen}
                onOpenChange={setCompanyOpen}
              >
                <div className="space-y-4">
                  <fieldset className="space-y-3">
                    <legend className="ui-eyebrow mb-2">{t("settings.ui.sectionIdentity")}</legend>
                    {field("legal_name", "settings.company.nameLabel", {
                      placeholder: t("settings.company.namePlaceholder"),
                      autoComplete: "organization",
                    })}
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                      {field("ico", "settings.company.icoLabel", { inputMode: "numeric" })}
                      {field("dic", "settings.company.dicLabel", { inputMode: "numeric" })}
                      {field("ic_dph", "settings.company.icDphLabel", { className: "col-span-2 sm:col-span-1" })}
                    </div>
                    <p className="ui-help">{t("settings.company.icDphHint")}</p>
                  </fieldset>

                  <fieldset className="space-y-3">
                    <legend className="ui-eyebrow mb-2">{t("settings.ui.sectionAddress")}</legend>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {field("address_line1", "settings.company.addressLine1Label", { autoComplete: "address-line1" })}
                      {field("address_line2", "settings.company.addressLine2Label", { autoComplete: "address-line2" })}
                    </div>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                      {field("city", "settings.company.cityLabel", { autoComplete: "address-level2", className: "col-span-2 sm:col-span-1" })}
                      {field("postal_code", "settings.company.postalCodeLabel", { autoComplete: "postal-code" })}
                      {field("country_code", "settings.company.countryCodeLabel", { placeholder: "SK" })}
                    </div>
                  </fieldset>

                  <fieldset className="space-y-3">
                    <legend className="ui-eyebrow mb-2">{t("settings.ui.sectionBank")}</legend>
                    <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
                      {field("iban", "settings.company.ibanLabel", { ownerOnly: true })}
                      {field("bic", "settings.company.bicLabel", { ownerOnly: true })}
                    </div>
                    {canEditCompany && myRole !== "owner" && (
                      <p className="ui-help">{t("settings.company.bankDetailsOwnerOnly")}</p>
                    )}
                  </fieldset>

                  <fieldset className="space-y-3">
                    <legend className="ui-eyebrow mb-2">{t("settings.ui.sectionInvoicing")}</legend>
                    {field("contact_email", "settings.company.contactEmailLabel", { type: "email", inputMode: "email", autoComplete: "email" })}
                    <div className="grid grid-cols-3 gap-3">
                      {field("default_due_days", "settings.company.defaultDueDaysLabel", { placeholder: "14", inputMode: "numeric" })}
                      {field("default_currency", "settings.company.defaultCurrencyLabel", { placeholder: "EUR" })}
                      {field("default_vat_rate", "settings.company.defaultVatRateLabel", { placeholder: "20", inputMode: "decimal" })}
                    </div>
                    {field("invoice_numbering_prefix", "settings.company.invoiceNumberingPrefixLabel")}
                  </fieldset>

                  {canEditCompany && (
                    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-divider pt-3">
                      <button
                        type="button"
                        onClick={saveSettings}
                        disabled={settingsLoading || logoLoading}
                        className="ui-btn ui-btn-primary"
                      >
                        {settingsLoading ? t("settings.company.saving") : t("settings.company.save")}
                      </button>
                    </div>
                  )}
                  <InlineNotice notice={companyNotice} />
                </div>
              </SettingsDisclosure>
            </SettingsSection>
          )}

          {/* ---------------- Logo (finance view) ---------------- */}
          {myRole && financeView && (
            <SettingsSection title={t("settings.company.logoLabel")} footer={canEditCompany ? t("settings.company.logoHint") : undefined}>
              <div className="ui-row flex-wrap">
                {logoThumb(logoUrl)}
                <span className="min-w-0 flex-1">
                  <span className="ui-row-title block">
                    {logoUrl ? t("settings.company.logoLabel") : t("settings.company.noLogo")}
                  </span>
                </span>
                {canEditCompany && (
                  <span className="flex shrink-0 items-center gap-2">
                    <label className={`ui-btn ui-btn-secondary ui-btn-sm cursor-pointer ${logoLoading ? "pointer-events-none opacity-50" : ""}`}>
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
                        className="sr-only"
                      />
                    </label>
                    {logoPath && (
                      <button
                        type="button"
                        onClick={deleteLogo}
                        disabled={logoLoading}
                        aria-label={t("settings.company.deleteLogo")}
                        title={t("settings.company.deleteLogo")}
                        className="ui-btn ui-btn-danger ui-btn-sm ui-btn-icon"
                      >
                        <TrashIcon size={15} aria-hidden="true" />
                      </button>
                    )}
                  </span>
                )}
              </div>
              {logoNotice && (
                <div className="ui-group-body">
                  <InlineNotice notice={logoNotice} />
                </div>
              )}
            </SettingsSection>
          )}

          {/* ---------------- Firma (bez finance prístupu) ----------------
              Finance Access Hardening — bez finance view appka NIKDY
              nenačítava/nezobrazuje billing polia (IČO/DIČ/IBAN/...); iba
              branding (názov+logo) cez esblu_get_company_profile() RPC. */}
          {myRole && !financeView && (
            <SettingsSection title={t("settings.company.title")} footer={t("settings.company.noFinanceAccessNotice")}>
              <SettingsRow
                leading={logoThumb(brandingOnlyLogoUrl)}
                title={brandingOnlyName || t("settings.company.namePlaceholder")}
                subtitle={brandingOnlyLogoUrl ? undefined : t("settings.company.noLogo")}
              />
            </SettingsSection>
          )}

          {/* ---------------- Používatelia ---------------- */}
          {myRole && (
            <SettingsSection title={t("settings.users.title")}>
              {/* Vlastné členstvo iba keď sa nezobrazuje zoznam členov (owner/admin
                  sa v ňom vidí sám — duplicitný riadok by iba predĺžil sekciu). */}
              {(usersLoading || members.length === 0) && (
                <SettingsRow title={t("settings.users.yourMembership").replace(/:\s*$/, "")} trailing={roleBadge(myRole)} />
              )}

              {usersLoading ? (
                <SettingsRow title={<span className="text-secondary">{t("settings.users.loading")}</span>} />
              ) : (
                <>
                  {members.map((member) => (
                    <SettingsRow
                      key={member.member_id}
                      title={<span className="block truncate">{member.email}</span>}
                      trailing={roleBadge(member.role)}
                    />
                  ))}

                  {(myRole === "owner" || myRole === "admin") &&
                    invites.map((invite) => (
                      <SettingsRow
                        key={invite.invite_id}
                        title={<span className="block truncate text-secondary">{invite.email}</span>}
                        subtitle={`${t("settings.users.invitesTitle")} · ${MEMBER_ROLE_LABELS[invite.role] || invite.role}`}
                        trailing={<span className="ui-badge">{INVITE_STATUS_LABELS[invite.status] || invite.status}</span>}
                      />
                    ))}

                  {(myRole === "owner" || myRole === "admin") && (
                    <SettingsDisclosure title={t("settings.users.inviteUserTitle")} open={inviteOpen} onOpenChange={setInviteOpen}>
                      <div className="space-y-3">
                        <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
                          <FormField label={t("settings.users.emailPlaceholder")} error={inviteError || undefined}>
                            {(aria) => (
                              <input
                                {...aria}
                                type="email"
                                inputMode="email"
                                autoComplete="off"
                                placeholder={t("settings.users.emailPlaceholder")}
                                className="ui-input"
                                value={inviteEmail}
                                onChange={(event) => setInviteEmail(event.target.value)}
                                disabled={inviteSubmitting}
                              />
                            )}
                          </FormField>
                          {/* Rola účtovníka nesie finančný prístup — pozvať ju
                              smie iba majiteľ (server to vynucuje). */}
                          <FormField label={t("settings.ui.role")}>
                            {(aria) => (
                              <select
                                {...aria}
                                className="ui-input"
                                value={inviteRole}
                                onChange={(event) => setInviteRole(event.target.value as CompanyInviteRole)}
                                disabled={inviteSubmitting}
                              >
                                {INVITE_ROLE_OPTIONS.filter((option) => option.value !== "accountant" || myRole === "owner").map((option) => (
                                  <option key={option.value} value={option.value}>
                                    {t(option.labelKey)}
                                  </option>
                                ))}
                              </select>
                            )}
                          </FormField>
                        </div>
                        {selectedInviteRole && <p className="ui-help">{t(selectedInviteRole.hintKey)}</p>}

                        <div className="flex justify-end">
                          <button
                            type="button"
                            onClick={handleCreateInvite}
                            disabled={inviteSubmitting}
                            className="ui-btn ui-btn-primary"
                          >
                            {inviteSubmitting ? t("settings.users.creating") : t("settings.users.inviteUser")}
                          </button>
                        </div>

                        {lastInviteLink && (
                          <div className="ui-notice" data-tone="success" role="status">
                            <p className="font-semibold">{t("settings.users.inviteCreated")}</p>
                            <p className="mt-1 break-all text-xs opacity-90">{lastInviteLink}</p>
                            <button type="button" onClick={copyInviteLink} className="ui-btn ui-btn-secondary ui-btn-sm mt-2">
                              {linkCopied ? t("settings.users.linkCopied") : t("settings.users.copyLink")}
                            </button>
                          </div>
                        )}
                      </div>
                    </SettingsDisclosure>
                  )}
                </>
              )}
            </SettingsSection>
          )}

          {/* ---------------- Heslo ---------------- */}
          <SettingsSection title={t("settings.password.title")}>
            <SettingsDisclosure
              title={t("settings.password.changeButton")}
              subtitle={t("settings.password.minLengthHint")}
              open={passwordOpen}
              onOpenChange={setPasswordOpen}
            >
              <div className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <FormField label={t("settings.password.newPasswordLabel")}>
                    {(aria) => (
                      <input
                        {...aria}
                        type="password"
                        autoComplete="new-password"
                        className="ui-input"
                        placeholder={t("settings.password.newPasswordPlaceholder")}
                        value={newPassword}
                        onChange={(event) => setNewPassword(event.target.value)}
                        disabled={passwordLoading}
                      />
                    )}
                  </FormField>
                  <FormField label={t("settings.password.confirmPasswordLabel")}>
                    {(aria) => (
                      <input
                        {...aria}
                        type="password"
                        autoComplete="new-password"
                        className="ui-input"
                        placeholder={t("settings.password.confirmPasswordPlaceholder")}
                        value={confirmNewPassword}
                        onChange={(event) => setConfirmNewPassword(event.target.value)}
                        disabled={passwordLoading}
                      />
                    )}
                  </FormField>
                </div>
                <div className="flex justify-end">
                  <button type="button" onClick={changePassword} disabled={passwordLoading} className="ui-btn ui-btn-secondary">
                    {passwordLoading ? t("settings.password.changing") : t("settings.password.changeButton")}
                  </button>
                </div>
                <InlineNotice notice={passwordNotice} />
              </div>
            </SettingsDisclosure>
          </SettingsSection>

          {/* ---------------- Upozornenia ---------------- */}
          <PushNotificationSettings />

          {/* ---------------- Spätná väzba ---------------- */}
          <SettingsSection title={t("settings.feedback.title")} footer={t("settings.feedback.privacyHint")}>
            <SettingsLinkRow href={feedbackMailto} title={t("settings.feedback.sendButton")} />
          </SettingsSection>

          {/* ---------------- Právne informácie ---------------- */}
          <SettingsSection title={t("settings.legal.title")}>
            <nav aria-label={t("settings.legal.navAriaLabel")} className="contents ui-divided">
              <SettingsLinkRow href="/ochrana-osobnych-udajov" title={t("settings.legal.privacyLink")} />
              <SettingsLinkRow href="/podmienky-pouzivania" title={t("settings.legal.termsLink")} />
              <SettingsLinkRow href="/cookies" title={t("settings.legal.cookiesLink")} />
              <SettingsLinkRow href="/dpa" title={t("settings.legal.dpaLink")} />
              <SettingsLinkRow href="/subprocessors" title={t("settings.legal.subprocessorsLink")} />
              <SettingsLinkRow href="/kontakt" title={t("settings.legal.contactLink")} />
            </nav>
          </SettingsSection>

          {/* ---------------- Súkromie a dáta ---------------- */}
          <SettingsSection
            title={t("settings.privacy.title")}
            footer={
              <>
                {t("settings.privacy.description")}{" "}
                {t("settings.privacy.currentVersions", {
                  terms: legalConfig.termsVersion,
                  privacy: legalConfig.privacyPolicyVersion,
                })}
              </>
            }
          >
            <SettingsDisclosure
              title={t("settings.privacy.confirmedDocsTitle")}
              subtitle={acceptancesLoading ? t("settings.privacy.loading") : acceptances.length > 0 ? String(acceptances.length) : t("settings.privacy.noAcceptancesYet")}
              open={acceptancesOpen}
              onOpenChange={setAcceptancesOpen}
            >
              {acceptances.length > 0 ? (
                <ul className="ui-divided -my-1">
                  {acceptances.map((row) => (
                    <li key={`${row.document_type}-${row.version}`} className="flex items-center gap-3 py-1.5">
                      <span className="min-w-0 flex-1">
                        <span className="ui-row-title block">{DOC_TYPE_LABELS[row.document_type] || row.document_type}</span>
                        <span className="ui-row-sub block">
                          {t("settings.privacy.confirmedAt", { date: formatDateTime(row.accepted_at, locale) })}
                        </span>
                      </span>
                      <span className="ui-badge">{t("settings.privacy.versionLabel", { version: row.version })}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="ui-help">{acceptancesLoading ? t("settings.privacy.loading") : t("settings.privacy.noAcceptancesYet")}</p>
              )}
            </SettingsDisclosure>
            <SettingsLinkRow href={exportRequestMailto} title={t("settings.privacy.requestExport")} />
            <SettingsLinkRow href={correctionRequestMailto} title={t("settings.privacy.requestCorrection")} />
          </SettingsSection>

          {/* ---------------- Zrušiť účet ---------------- */}
          {(myRole || isOrphanAccount) && (
            <SettingsSection title={t("settings.deleteAccount.title")}>
              <button type="button" onClick={openDeleteAccountModal} className="ui-row">
                <span className="min-w-0 flex-1">
                  <span className="ui-row-title block !text-danger">{t("settings.deleteAccount.button")}</span>
                  <span className="ui-row-sub mt-0.5 block line-clamp-2">
                    {myRole === "owner"
                      ? t("settings.deleteAccount.ownerDescription")
                      : myRole
                        ? t("settings.deleteAccount.memberDescription")
                        : t("settings.deleteAccount.orphanDescription")}
                  </span>
                </span>
              </button>
            </SettingsSection>
          )}
        </div>
      </div>

      {showDeleteAccountModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-account-title"
          className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto bg-black/60 p-3 sm:items-center sm:p-4"
        >
          <div className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-doc border border-doc-border bg-surface-1 shadow-2xl">
            <div className="flex items-center justify-between gap-3 border-b border-doc-border px-4 py-3">
              <h2 id="delete-account-title" className="ui-section-title">
                {deletePreflight?.role === "owner"
                  ? t("settings.deleteModal.ownerTitle")
                  : t("settings.deleteModal.genericTitle")}
              </h2>
              <button
                type="button"
                onClick={closeDeleteAccountModal}
                disabled={deleteSubmitting}
                className="ui-btn ui-btn-ghost ui-btn-sm"
              >
                {t("settings.deleteModal.close")}
              </button>
            </div>

            <div className="px-4 py-4">
              {deletePreflightLoading ? (
                <p className="ui-body">{t("settings.deleteModal.loading")}</p>
              ) : deletePreflightError ? (
                <p className="ui-notice" data-tone="error" role="alert">
                  {deletePreflightError}
                </p>
              ) : deletePreflight?.role === "owner" && deletePreflight.ownerDeletionBlocked ? (
                <div className="space-y-3">
                  {/* Archivácia účtovných dokladov: zrušenie sa NEPONÚKNE (nič sa nemaže). */}
                  <p className="ui-body">{t("settings.deleteModal.ownerBlockedRetention")}</p>
                  <div className="flex justify-end">
                    <button type="button" onClick={closeDeleteAccountModal} className="ui-btn ui-btn-secondary">
                      {t("settings.deleteModal.cancel")}
                    </button>
                  </div>
                </div>
              ) : deletePreflight?.role === "owner" ? (
                <div className="space-y-3">
                  <p className="ui-body">{t("settings.deleteModal.irreversibleIntro")}</p>

                  <ul className="ui-body list-disc space-y-0.5 pl-5">
                    <li>{t("settings.deleteModal.deleteItemCompany")}</li>
                    <li>{t("settings.deleteModal.deleteItemAiEvidence")}</li>
                    <li>{t("settings.deleteModal.deleteItemVehicles")}</li>
                    <li>{t("settings.deleteModal.deleteItemMachines")}</li>
                    <li>{t("settings.deleteModal.deleteItemInventory")}</li>
                    <li>{t("settings.deleteModal.deleteItemPhotos")}</li>
                    <li>{t("settings.deleteModal.deleteItemInvites")}</li>
                    <li>{t("settings.deleteModal.deleteItemMemberships")}</li>
                  </ul>

                  <p className="ui-body">
                    {deletePreflight.otherActiveMembersCount > 0
                      ? tCount("settings.deleteModal.otherMembersWarning", deletePreflight.otherActiveMembersCount, {
                          count: deletePreflight.otherActiveMembersCount,
                        })
                      : t("settings.deleteModal.noOtherMembers")}
                  </p>

                  <FormField label={t("settings.deleteModal.confirmPhraseLabel", { phrase: ACCOUNT_DELETION_CONFIRM_PHRASE })}>
                    {(aria) => (
                      <input
                        {...aria}
                        type="text"
                        className="ui-input"
                        value={deleteConfirmText}
                        onChange={(event) => setDeleteConfirmText(event.target.value)}
                        disabled={deleteSubmitting}
                        autoComplete="off"
                      />
                    )}
                  </FormField>

                  {deleteError && (
                    <p className="ui-notice" data-tone="error" role="alert">
                      {deleteError}
                    </p>
                  )}

                  <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                    <button
                      type="button"
                      onClick={closeDeleteAccountModal}
                      disabled={deleteSubmitting}
                      className="ui-btn ui-btn-secondary"
                    >
                      {t("settings.deleteModal.cancel")}
                    </button>
                    <button
                      type="button"
                      onClick={confirmDeleteAccount}
                      disabled={deleteSubmitting || deleteConfirmText !== ACCOUNT_DELETION_CONFIRM_PHRASE}
                      className="ui-btn bg-red-600 text-white hover:bg-red-700"
                    >
                      {deleteSubmitting
                        ? t("settings.deleteModal.deletingAccount")
                        : t("settings.deleteModal.deletePermanently")}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="ui-body">
                    {deletePreflight?.orphan
                      ? t("settings.deleteModal.orphanIrreversible")
                      : t("settings.deleteModal.memberIrreversible")}
                  </p>

                  {deleteError && (
                    <p className="ui-notice" data-tone="error" role="alert">
                      {deleteError}
                    </p>
                  )}

                  <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                    <button
                      type="button"
                      onClick={closeDeleteAccountModal}
                      disabled={deleteSubmitting}
                      className="ui-btn ui-btn-secondary"
                    >
                      {t("settings.deleteModal.cancel")}
                    </button>
                    <button
                      type="button"
                      onClick={confirmDeleteAccount}
                      disabled={deleteSubmitting}
                      className="ui-btn bg-red-600 text-white hover:bg-red-700"
                    >
                      {deleteSubmitting ? t("settings.deleteModal.deletingAccount") : t("settings.deleteModal.confirmDelete")}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
