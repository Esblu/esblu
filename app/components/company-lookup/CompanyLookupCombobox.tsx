"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { formatDate } from "@/lib/i18n/format";
import { docField, docLabel } from "@/app/components/document/DocumentLayout";
import { getCompanyDetail, searchCompanies } from "@/lib/company-lookup/client";
import { parseLookupQuery } from "@/lib/company-lookup/normalize";
import type { CompanyCandidate, CompanyDetailResponseBody } from "@/lib/company-lookup/types";

// =============================================================================
// CompanyLookupCombobox — znovupoužiteľné vyhľadávanie firmy v registri.
// =============================================================================
// Používateľ píše názov alebo IČO → debounce 300 ms → návrhy (RPO) → výber
// → detail (RPO + RÚZ DIČ) → onSelect(detail). Komponent sám NIČ neukladá
// a nemení formulár — rozhoduje volajúci (predvyplní a človek potvrdí).
//
// Prístupnosť: WAI-ARIA combobox (input + listbox), šípky, Enter, Escape,
// aria-activedescendant, stav v aria-live. Ručné zadanie ostáva vždy možné:
// pri chybe/výpadku sa iba zobrazí hláška, formulár sa neblokuje.
// =============================================================================

const DEBOUNCE_MS = 300;

type SearchState =
  | { kind: "idle" }
  | { kind: "hint" }
  | { kind: "loading" }
  | { kind: "results"; results: CompanyCandidate[] }
  | { kind: "empty" }
  | { kind: "error"; code: string };

export default function CompanyLookupCombobox({
  onSelect,
  disabled = false,
  autoFocus = false,
}: {
  onSelect: (detail: CompanyDetailResponseBody) => void;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const { t, locale } = useLocale();
  const baseId = useId();
  const inputId = `${baseId}-input`;
  const listboxId = `${baseId}-listbox`;
  const statusId = `${baseId}-status`;

  const [query, setQuery] = useState("");
  const [state, setState] = useState<SearchState>({ kind: "idle" });
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");

  const searchAbort = useRef<AbortController | null>(null);
  const detailAbort = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      searchAbort.current?.abort();
      detailAbort.current?.abort();
    },
    []
  );

  function scheduleSearch(value: string) {
    if (timer.current) clearTimeout(timer.current);
    searchAbort.current?.abort();
    setActiveIndex(-1);
    setDetailError("");

    if (!value.trim()) {
      setState({ kind: "idle" });
      setOpen(false);
      return;
    }
    const parsed = parseLookupQuery(value);
    if (parsed.kind === "error") {
      setState(parsed.code === "QUERY_TOO_SHORT" ? { kind: "hint" } : { kind: "error", code: parsed.code });
      setOpen(true);
      return;
    }

    setState({ kind: "loading" });
    setOpen(true);
    timer.current = setTimeout(async () => {
      const controller = new AbortController();
      searchAbort.current = controller;
      const result = await searchCompanies(value.trim(), controller.signal);
      if (controller.signal.aborted || "aborted" in result) return;
      if (!result.ok) {
        setState({ kind: "error", code: result.code });
        return;
      }
      setState(result.body.results.length ? { kind: "results", results: result.body.results } : { kind: "empty" });
    }, DEBOUNCE_MS);
  }

  async function choose(candidate: CompanyCandidate) {
    detailAbort.current?.abort();
    const controller = new AbortController();
    detailAbort.current = controller;
    setOpen(false);
    setActiveIndex(-1);
    setDetailLoading(true);
    setDetailError("");
    const result = await getCompanyDetail(candidate.ico, controller.signal);
    if (controller.signal.aborted || "aborted" in result) return;
    setDetailLoading(false);
    if (!result.ok) {
      setDetailError(t(`companyLookup.errors.${result.code}`));
      return;
    }
    setQuery("");
    setState({ kind: "idle" });
    onSelect(result.body);
  }

  const results = state.kind === "results" ? state.results : [];
  const expanded = open && state.kind !== "idle";

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      if (!results.length) return;
      event.preventDefault();
      setOpen(true);
      setActiveIndex((index) => (index + 1) % results.length);
    } else if (event.key === "ArrowUp") {
      if (!results.length) return;
      event.preventDefault();
      setOpen(true);
      setActiveIndex((index) => (index <= 0 ? results.length - 1 : index - 1));
    } else if (event.key === "Enter") {
      if (expanded && activeIndex >= 0 && results[activeIndex]) {
        event.preventDefault();
        void choose(results[activeIndex]);
      }
    } else if (event.key === "Escape") {
      if (expanded) {
        event.preventDefault();
        setOpen(false);
        setActiveIndex(-1);
      }
    }
  }

  const statusText =
    detailLoading
      ? t("companyLookup.loadingDetail")
      : state.kind === "loading"
        ? t("companyLookup.loading")
        : state.kind === "hint"
          ? t("companyLookup.tooShort")
          : state.kind === "empty"
            ? t("companyLookup.empty")
            : state.kind === "error"
              ? t(`companyLookup.errors.${state.code}`)
              : state.kind === "results"
                ? t("companyLookup.resultsCount", { count: results.length })
                : "";

  return (
    <div className="relative">
      <label className={docLabel} htmlFor={inputId}>
        {t("companyLookup.label")}
      </label>
      <input
        id={inputId}
        type="text"
        role="combobox"
        autoComplete="off"
        spellCheck={false}
        autoFocus={autoFocus}
        className={docField}
        placeholder={t("companyLookup.placeholder")}
        value={query}
        disabled={disabled}
        maxLength={120}
        aria-autocomplete="list"
        aria-expanded={expanded && results.length > 0}
        aria-controls={listboxId}
        aria-activedescendant={activeIndex >= 0 ? `${listboxId}-opt-${activeIndex}` : undefined}
        aria-describedby={statusId}
        onChange={(event) => {
          setQuery(event.target.value);
          scheduleSearch(event.target.value);
        }}
        onKeyDown={onKeyDown}
        onFocus={() => {
          if (state.kind !== "idle") setOpen(true);
        }}
        onBlur={() => {
          // Klik do zoznamu (onMouseDown) predbehne blur, takže sa dá vybrať myšou.
          setOpen(false);
        }}
      />

      <ul
        id={listboxId}
        role="listbox"
        aria-label={t("companyLookup.label")}
        className={
          expanded && results.length > 0
            ? "absolute z-20 mt-1 max-h-80 w-full overflow-auto rounded-doc-sm border border-doc-border bg-surface-1 py-1 shadow-lg"
            : "hidden"
        }
      >
        {results.map((candidate, index) => {
          const active = index === activeIndex;
          return (
            <li
              key={`${candidate.registryRef}-${candidate.ico}`}
              id={`${listboxId}-opt-${index}`}
              role="option"
              aria-selected={active}
              className={`cursor-pointer px-3 py-2 text-sm ${active ? "bg-surface-hover" : ""}`}
              onMouseDown={(event) => {
                event.preventDefault();
                void choose(candidate);
              }}
              onMouseEnter={() => setActiveIndex(index)}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-primary">{candidate.name}</span>
                {candidate.status === "terminated" && (
                  <span className="rounded-full border border-danger/30 bg-danger-soft px-2 py-0.5 text-xs font-semibold text-danger">
                    {candidate.terminatedOn
                      ? t("companyLookup.terminatedSince", { date: formatDate(candidate.terminatedOn, locale) })
                      : t("companyLookup.terminatedBadge")}
                  </span>
                )}
              </div>
              <div className="text-xs text-secondary">
                {t("companyLookup.icoPrefix")} {candidate.ico}
                {candidate.city ? ` · ${candidate.city}` : ""}
              </div>
            </li>
          );
        })}
      </ul>

      <p
        id={statusId}
        role="status"
        aria-live="polite"
        className={`mt-1 text-xs ${state.kind === "error" || detailError ? "font-medium text-danger" : "text-muted-esblu"}`}
      >
        {detailError || statusText || t("companyLookup.hint")}
      </p>
      <p className="mt-0.5 text-[11px] text-muted-esblu">{t("companyLookup.sourceRpo")}</p>
    </div>
  );
}
