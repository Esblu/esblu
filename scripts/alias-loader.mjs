// =============================================================================
// Minimálny resolver pre testy v Node (`--experimental-strip-types`).
//
// Moduly appky importujú cez alias `@/…` a často bez prípony (tak, ako to
// chce bundler). Node sám nevie ani jedno. Tento hook iba preloží cestu na
// skutočný súbor — nič nekompiluje a nič nemení na obsahu.
//
// Použitie:  node --experimental-strip-types --import ./scripts/alias-loader.mjs <test>
// =============================================================================
import { register } from "node:module";

register(
  "data:text/javascript," +
    encodeURIComponent(`
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = ${JSON.stringify(process.cwd())};
const EXTS = [".ts", ".tsx", "/index.ts"];

export async function resolve(specifier, context, next) {
  let base = null;
  if (specifier.startsWith("@/")) base = path.join(ROOT, specifier.slice(2));
  else if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
    if (!/\\.[a-z]+$/i.test(specifier)) base = path.join(path.dirname(fileURLToPath(context.parentURL)), specifier);
  }
  if (base) {
    for (const ext of EXTS) {
      if (existsSync(base + ext)) return next(pathToFileURL(base + ext).href, context);
    }
  }
  return next(specifier, context);
}
`),
  import.meta.url
);
