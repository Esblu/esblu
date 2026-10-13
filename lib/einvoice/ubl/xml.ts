import { DOMImplementation, XMLSerializer, type Document, type Element } from "@xmldom/xmldom";

// =============================================================================
// Bezpečné skladanie XML cez DOM (@xmldom/xmldom) — žiadne lepenie reťazcov.
// Escaping textu aj atribútov a deklarácie namespace rieši knižnica. Navyše:
//   - znaky, ktoré XML 1.0 vôbec nepovoľuje (C0 riadiace znaky okrem
//     TAB/LF/CR, nepárové surrogaty, U+FFFE/U+FFFF), sa NEMAŽÚ potichu —
//     vyhodí sa chyba (fail-closed, žiadna tichá úprava údajov používateľa),
//   - poradie elementov určuje volajúci (UBL schéma je sekvencia), preto je
//     výstup pre rovnaký vstup bajtovo zhodný.
// =============================================================================

export const NS = {
  invoice: "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2",
  creditNote: "urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2",
  cac: "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
  cbc: "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
} as const;

const XMLNS = "http://www.w3.org/2000/xmlns/";

export class XmlInvalidCharacterError extends Error {
  readonly context: string;
  constructor(context: string) {
    super(`XML_INVALID_CHARACTER:${context}`);
    this.context = context;
  }
}

// XML 1.0 Char: #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]
const INVALID_XML_CHAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function assertXmlText(value: string, context: string): string {
  if (INVALID_XML_CHAR.test(value)) {
    throw new XmlInvalidCharacterError(context);
  }
  return value;
}

export type XmlBuilder = {
  doc: Document;
  root: Element;
  /** Pridá element s textom (text sa escapuje knižnicou). */
  text: (parent: Element, qname: `cbc:${string}`, value: string, attrs?: Record<string, string>) => Element;
  /** Pridá agregát (cac:*) a vráti ho. */
  group: (parent: Element, qname: `cac:${string}`) => Element;
  serialize: () => string;
};

export function createUblDocument(rootName: "Invoice" | "CreditNote"): XmlBuilder {
  const rootNs = rootName === "Invoice" ? NS.invoice : NS.creditNote;
  const doc = new DOMImplementation().createDocument(rootNs, rootName, null);
  const root = doc.documentElement as Element;
  root.setAttributeNS(XMLNS, "xmlns:cac", NS.cac);
  root.setAttributeNS(XMLNS, "xmlns:cbc", NS.cbc);

  const text: XmlBuilder["text"] = (parent, qname, value, attrs) => {
    const el = doc.createElementNS(NS.cbc, qname);
    if (attrs) {
      for (const key of Object.keys(attrs)) {
        el.setAttribute(key, assertXmlText(attrs[key], `${qname}@${key}`));
      }
    }
    el.appendChild(doc.createTextNode(assertXmlText(value, qname)));
    parent.appendChild(el);
    return el;
  };

  const group: XmlBuilder["group"] = (parent, qname) => {
    const el = doc.createElementNS(NS.cac, qname);
    parent.appendChild(el);
    return el;
  };

  const serialize = () => `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(doc)}\n`;

  return { doc, root, text, group, serialize };
}
