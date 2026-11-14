import { Document, Page, Text, View, StyleSheet, renderToBuffer } from "@react-pdf/renderer";
import { ensureFontsRegistered } from "@/lib/invoicing/pdf-renderer";
import type { companyOverview } from "@/lib/company-export-readable";

// =============================================================================
// Prehlad_firmy.pdf — súhrn firmy a rozsahu exportu. Iba údaje z exportovaných
// riadkov (companyOverview), žiadny dotaz, žiadne nové údaje. Generuje sa iba
// v pamäti pre jeden ZIP.
// =============================================================================

type Overview = ReturnType<typeof companyOverview>;

const styles = StyleSheet.create({
  page: { fontFamily: "NotoSans", fontSize: 10, padding: 40, lineHeight: 1.4 },
  h1: { fontSize: 18, fontWeight: "bold", marginBottom: 4 },
  sub: { fontSize: 10, color: "#555555", marginBottom: 16 },
  h2: { fontSize: 12, fontWeight: "bold", marginTop: 14, marginBottom: 6 },
  row: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: "#dddddd", paddingVertical: 3 },
  key: { width: 170, color: "#555555" },
  val: { flex: 1 },
  note: { fontSize: 9, color: "#555555", marginTop: 4 },
});

function Line({ k, v }: { k: string; v: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.key}>{k}</Text>
      <Text style={styles.val}>{v || "—"}</Text>
    </View>
  );
}

function OverviewDocument({ o }: { o: Overview }) {
  return (
    <Document title="Prehľad firmy — export Esblu" author="Esblu">
      <Page size="A4" style={styles.page}>
        <Text style={styles.h1}>Prehľad firmy</Text>
        <Text style={styles.sub}>Export údajov firmy z Esblu · vytvorený {o.generatedAt} (UTC)</Text>

        <Text style={styles.h2}>Firma</Text>
        <Line k="Názov" v={o.name} />
        <Line k="IČO" v={o.ico} />
        <Line k="DIČ" v={o.dic} />
        <Line k="IČ DPH" v={o.icDph} />
        <Line k="Adresa" v={o.address} />
        <Line k="Kontaktný e-mail" v={o.contactEmail} />

        <Text style={styles.h2}>Rozsah exportu (počet záznamov)</Text>
        {o.areas.map(([k, n]) => (
          <Line key={k} k={k} v={String(n)} />
        ))}

        <Text style={styles.h2}>Obsah balíka</Text>
        <Text>Priečinok CITATELNY_EXPORT obsahuje prehľadné tabuľky (CSV pre Excel) a PDF vizualizácie finalizovaných vydaných faktúr.</Text>
        <Text>Technická časť (data/*.json, data/*.csv, manifest.json) a dávky originálnych súborov (files/…) zostávajú súčasťou exportu bez zmeny.</Text>
        <Text style={styles.note}>
          PDF faktúr sú vizualizácie uložených údajov, nie nové právne originály. Originál e-faktúry je XML súbor v dávkach súborov.
          Export nie je zákonný archív — za uchovávanie účtovných dokladov zodpovedá firma.
        </Text>
      </Page>
    </Document>
  );
}

export async function renderCompanyOverviewPdf(o: Overview): Promise<Buffer> {
  ensureFontsRegistered();
  return renderToBuffer(<OverviewDocument o={o} />);
}
