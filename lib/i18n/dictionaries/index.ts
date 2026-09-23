import type { Locale } from "../locales";
import sk from "./sk.ts";
import de from "./de.ts";
import en from "./en.ts";

export const dictionaries: Record<Locale, typeof sk> = { sk, de, en };
