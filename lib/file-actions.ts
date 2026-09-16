import { IS_MOBILE_BUILD } from "@/lib/build-target";
import { sanitizeFileName } from "@/lib/sanitize-filename";

export { sanitizeFileName } from "@/lib/sanitize-filename";

// -----------------------------------------------------------------------------
// Zdieľaná vrstva pre "otvor dokument" / "stiahni súbor" akcie (web aj mobile).
// Rieši presne dva reálne problémy zistené auditom (FÁZA: MOBILE FILES /
// PREVIEW / DOWNLOAD / EXPORT):
//
// 1. `window.open(signedUrl, "_blank")` — na webe spoľahlivo otvorí novú
//    kartu. V Capacitor Android WebView je toto správanie nespoľahlivé
//    (WebView defaultne nepodporuje viacero okien/kariet) a natívny WebView
//    navyše PDF vôbec nevykreslí (na rozdiel od plnohodnotného Chrome).
//    Riešenie: @capacitor/browser (Chrome Custom Tabs) — oficiálny,
//    udržiavaný Capacitor 8 plugin práve na tento presný problém.
//
// 2. Klientský Blob download (`<a download>` na `blob:` URL — XLSX export,
//    stiahnutie originálu dokumentu z Inboxu) — na webe funguje spoľahlivo.
//    V Android WebView `blob:` URL nie je skutočný súbor a kliknutie na
//    `<a download>` naň typicky nevyvolá žiadny download (žiadna chyba,
//    používateľ iba nič nedostane). Riešenie: @capacitor/filesystem (zápis
//    do Directory.Cache — scoped-storage-safe, BEZ akéhokoľvek permission,
//    funguje aj na Android API 36) + @capacitor/share (systémový Share
//    sheet, ktorým používateľ súbor sám uloží do Stiahnutých súborov/pošle
//    inam — presne to, čo dnes rieši prehliadačový "Downloads" priečinok na
//    webe).
//
// WEB: správanie je 1:1 zachované — presne ten istý window.open()/
// blob+anchor kód, aký appka používala doteraz, iba zoskupený na jedno
// miesto namiesto 3 duplicitných kópií (downloadOriginal v ai-evidencia,
// export-ai-evidence-excel.ts, export-ai-inbox-documents-excel.ts).
//
// MOBILE-ONLY IMPORT: @capacitor/browser/filesystem/share sa importujú
// VÝHRADNE dynamicky (`await import(...)`) a VÝHRADNE vnútri `if
// (IS_MOBILE_BUILD)` vetvy. IS_MOBILE_BUILD je build-time konštanta (pozri
// lib/build-target.ts) — vo webovom builde je vždy `false`, takže Next.js/
// Turbopack tento kód po inlinovaní `NEXT_PUBLIC_ESBLU_MOBILE` ako literál
// `false` odstráni ako nedosiahnuteľný (dead code elimination) ešte pred
// bundlovaním. Web build preto nemá @capacitor/browser/filesystem/share ako
// runtime závislosť — overené priamym `npm run build` bez týchto balíčkov v
// koreňovom package.json (iba mobile/package.json ich má).
//
// BEZPEČNOSŤ: signed URL a token sa NIKDY nelogujú (volajúci v ai-evidencia.
// tsx/VehicleDetailView.tsx/ChatMessageView.tsx toto dodržiavali už predtým
// — táto vrstva to nemení, iba presúva samotné volanie window.open/Blob
// handling). Názov súboru sa vždy sanitizuje (sanitizeFileName) — žiadny
// path traversal cez `original_filename` (ten pochádza z OCR/upload flow,
// teda nie je 100% dôveryhodný vstup).
//
// SHARE CANCEL (potvrdené reálnym Android testom): manuálne zavretie
// systémového Share dialógu (bez výberu cieľa) spôsobuje, že
// @capacitor/share na Androide odmietne promise s textom "Share canceled"
// (SharePlugin.java: `RESULT_CANCELED` → `call.reject("Share canceled")`).
// Bez ošetrenia sa toto dostalo až do UI ako "Chyba pri exporte Excelu:
// Error: Share canceled", hoci ide o bežné zrušenie používateľom, nie o
// zlyhanie exportu — súbor bol do Directory.Cache zapísaný úspešne.
// downloadBlob() preto tento presný prípad rozpozná (isShareCanceledError)
// a potichu ho ukončí ako úspech; každá iná chyba (skutočné zlyhanie
// zápisu/zdieľania) sa naďalej vyhadzuje volajúcemu nezmenená.
// -----------------------------------------------------------------------------

/**
 * Otvorí externú (typicky Supabase signed) URL na PREVIEW — dokument, PDF,
 * príloha. Web: nová karta prehliadača (nezmenené doterajšie správanie).
 * Mobile: @capacitor/browser (Chrome Custom Tab) — spoľahlivo funguje pre
 * PDF aj obrázky, na rozdiel od holého window.open() v Capacitor WebView.
 */
export async function openExternalUrl(url: string): Promise<void> {
  if (IS_MOBILE_BUILD) {
    const { Browser } = await import("@capacitor/browser");
    await Browser.open({ url });
    return;
  }

  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * Stiahne/uloží Blob (klientsky generovaný XLSX export, alebo stiahnutý
 * originál dokumentu) tak, aby sa dostal k používateľovi.
 * Web: nezmenené — Blob → ObjectURL → dočasný <a download> → click → revoke.
 * Mobile: Blob → base64 → Filesystem.writeFile do Directory.Cache (bez
 * potreby akéhokoľvek storage permission) → Share.share() — systémový
 * "Zdieľať" dialóg, ktorým používateľ súbor uloží do Stiahnutých súborov
 * alebo otvorí v inej appke. Cache súbor sa zámerne NEMAŽE hneď po
 * Share.share() (ten promise sa na Androide vyrieši už po spustení share
 * intentu, nie po tom, čo cieľová appka súbor skutočne dočíta — predčasné
 * zmazanie by mohlo pretrhnúť odovzdanie) — Directory.Cache je OS-spravovaný
 * priestor, ktorý sa priebežne uvoľňuje sám.
 */
export async function downloadBlob(
  blob: Blob,
  fileName: string
): Promise<void> {
  const safeName = sanitizeFileName(fileName);

  if (IS_MOBILE_BUILD) {
    const [{ Filesystem, Directory }, { Share }] = await Promise.all([
      import("@capacitor/filesystem"),
      import("@capacitor/share"),
    ]);

    const base64Data = await blobToBase64(blob);

    const written = await Filesystem.writeFile({
      path: safeName,
      data: base64Data,
      directory: Directory.Cache,
    });

    try {
      await Share.share({ url: written.uri });
    } catch (shareError: unknown) {
      if (isShareCanceledError(shareError)) {
        // Používateľ manuálne zavrel systémový Share dialóg bez výberu
        // cieľa — @capacitor/share na Androide na toto reaguje odmietnutím
        // promise s presne týmto textom (potvrdené priamo v zdroji pluginu,
        // node_modules/@capacitor/share/android/.../SharePlugin.java:
        // `if (result.getResultCode() == Activity.RESULT_CANCELED) { call.
        // reject("Share canceled"); }`). Súbor bol do Directory.Cache
        // úspešne zapísaný — ide o bežné používateľské zrušenie, nie o
        // zlyhanie exportu/sťahovania, preto sa tu ticho ukončí ako úspech.
        // Akákoľvek INÁ chyba (zápis zlyhal, nesprávna URL, súbežné
        // zdieľanie a pod.) sa naďalej vyhodí ďalej nezmenená.
        return;
      }
      throw shareError;
    }
    return;
  }

  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = objectUrl;
  link.download = safeName;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

/**
 * Rozpozná presne iba explicitné zrušenie Android Share dialógu
 * používateľom (@capacitor/share reject("Share canceled") — textový
 * literál potvrdený priamo v zdroji pluginu). Zámerne prísne porovnanie
 * (nie substring/regex), aby sa nikdy omylom neprehltla iná, skutočná
 * chyba, ktorá by náhodou obsahovala podobné slovo.
 */
function isShareCanceledError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message === "Share canceled";
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onloadend = () => {
      const result = reader.result;

      if (typeof result !== "string") {
        reject(new Error("Neočakávaný výsledok FileReader.readAsDataURL"));
        return;
      }

      // "data:<mime>;base64,<data>" — Filesystem.writeFile bez explicitného
      // `encoding` očakáva čistý base64 obsah, bez data: prefixu.
      const commaIndex = result.indexOf(",");
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };

    reader.onerror = () => {
      reject(reader.error ?? new Error("Čítanie Blob zlyhalo"));
    };

    reader.readAsDataURL(blob);
  });
}
