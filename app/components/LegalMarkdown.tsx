import type { ReactNode } from "react";
import { LegalSection } from "@/app/components/PublicLegalLayout";
import { AppLink } from "@/app/components/AppLink";

// =============================================================================
// Minimálny, zámerne bez-závislostný renderer pre nemenný obsah v legal/
// (žiadna nová npm závislosť — obsah je plne pod našou kontrolou, nie
// používateľský vstup, takže malý vlastný parser pre podmnožinu Markdown,
// ktorú sami používame, je bezpečnejšia a jednoduchšia voľba než ťahať
// knižnicu tretej strany).
//
// Podporovaná syntax (presne to, čo sa reálne používa v legal/*/*.md):
//   ## Nadpis            -> nová LegalSection (title = zvyšok riadku)
//   - položka             -> <ul><li>
//   > citácia             -> zvýraznený "aside" box (napr. upozornenie)
//   prázdny riadok         -> oddeľovač blokov
//   inak                   -> odsek <p>
// Inline: **tučné**, `kód`, [text](url) — interné odkazy (začínajúce "/")
// cez next/link, mailto: a externé http(s) odkazy cez <a>.
// =============================================================================

type Block =
  | { type: "heading"; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[] }
  | { type: "quote"; text: string };

function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    if (line.startsWith("## ")) {
      blocks.push({ type: "heading", text: line.slice(3).trim() });
      i++;
      continue;
    }

    if (line.startsWith("- ")) {
      const items: string[] = [];
      while (i < lines.length && lines[i].startsWith("- ")) {
        items.push(lines[i].slice(2).trim());
        i++;
      }
      blocks.push({ type: "list", items });
      continue;
    }

    if (line.startsWith("> ")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith("> ")) {
        quoteLines.push(lines[i].slice(2).trim());
        i++;
      }
      blocks.push({ type: "quote", text: quoteLines.join(" ") });
      continue;
    }

    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].startsWith("## ") &&
      !lines[i].startsWith("- ") &&
      !lines[i].startsWith("> ")
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push({ type: "paragraph", text: paraLines.join(" ") });
  }

  return blocks;
}

const INLINE_PATTERN = /(\*\*(.+?)\*\*)|(`(.+?)`)|(\[(.+?)\]\((.+?)\))/;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let remaining = text;
  let idx = 0;

  while (remaining.length > 0) {
    const match = INLINE_PATTERN.exec(remaining);

    if (!match) {
      nodes.push(remaining);
      break;
    }

    const before = remaining.slice(0, match.index);
    if (before) {
      nodes.push(before);
    }

    if (match[1]) {
      nodes.push(<strong key={`${keyPrefix}-b${idx++}`}>{match[2]}</strong>);
    } else if (match[3]) {
      nodes.push(
        <code
          key={`${keyPrefix}-c${idx++}`}
          className="rounded bg-surface-2 px-1.5 py-0.5 text-sm"
        >
          {match[4]}
        </code>
      );
    } else if (match[5]) {
      const linkText = match[6];
      const href = match[7];

      if (href.startsWith("/")) {
        nodes.push(
          <AppLink
            key={`${keyPrefix}-l${idx++}`}
            href={href}
            className="font-semibold text-blue-700 underline decoration-blue-300 underline-offset-4"
          >
            {linkText}
          </AppLink>
        );
      } else {
        const isMailto = href.startsWith("mailto:");
        nodes.push(
          <a
            key={`${keyPrefix}-l${idx++}`}
            href={href}
            target={isMailto ? undefined : "_blank"}
            rel={isMailto ? undefined : "noopener noreferrer"}
            className="break-all font-semibold text-blue-700 underline decoration-blue-300 underline-offset-4"
          >
            {linkText}
          </a>
        );
      }
    }

    remaining = remaining.slice(match.index + match[0].length);
  }

  return nodes;
}

/**
 * Vykreslí nemenný Markdown obsah (z legal/*.md, cez
 * lib/legal-content.ts#readLegalMarkdown) do JSX zodpovedajúceho
 * doterajšiemu vizuálu právnych stránok (LegalSection wrapper pre "## "
 * bloky, odseky pred prvým nadpisom ako úvodný text).
 */
export function LegalMarkdown({ markdown }: { markdown: string }) {
  const blocks = parseBlocks(markdown);
  const result: ReactNode[] = [];
  let currentTitle: string | null = null;
  let currentChildren: ReactNode[] = [];
  let blockKey = 0;

  function flushSection() {
    if (currentTitle !== null) {
      result.push(
        <LegalSection key={`section-${blockKey++}`} title={currentTitle}>
          {currentChildren}
        </LegalSection>
      );
    }
    currentTitle = null;
    currentChildren = [];
  }

  for (const block of blocks) {
    if (block.type === "heading") {
      flushSection();
      currentTitle = block.text;
      continue;
    }

    const key = `block-${blockKey++}`;
    let rendered: ReactNode;

    if (block.type === "paragraph") {
      rendered = <p key={key}>{renderInline(block.text, key)}</p>;
    } else if (block.type === "list") {
      rendered = (
        <ul key={key} className="list-disc space-y-2 pl-6">
          {block.items.map((item, itemIdx) => (
            <li key={`${key}-${itemIdx}`}>
              {renderInline(item, `${key}-${itemIdx}`)}
            </li>
          ))}
        </ul>
      );
    } else {
      rendered = (
        <aside
          key={key}
          className="rounded-2xl border border-amber-200 bg-amber-50 p-5 font-semibold text-amber-950"
        >
          {renderInline(block.text, key)}
        </aside>
      );
    }

    if (currentTitle !== null) {
      currentChildren.push(rendered);
    } else {
      result.push(rendered);
    }
  }

  flushSection();

  return <>{result}</>;
}
