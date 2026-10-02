// =============================================================================
// Testový loader pre .tsx v Node (`--experimental-strip-types` .tsx nevie).
//
// Iba pre testy prezentačných komponentov (SSR cez react-dom/server):
// .tsx súbor sa preloží cez `typescript.transpileModule` (jsx: react-jsx).
// Nič iné nemení. Používa sa SPOLU s alias-loader.mjs:
//   node --experimental-strip-types --import ./scripts/alias-loader.mjs \
//        --import ./scripts/tsx-loader.mjs <test>
// =============================================================================
import { register } from "node:module";

register(
  "data:text/javascript," +
    encodeURIComponent(`
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(path.join(${JSON.stringify(process.cwd())}, "package.json"));
const ts = require("typescript");

export async function load(url, context, next) {
  if (!url.startsWith("file:") || !url.endsWith(".tsx")) return next(url, context);
  const source = readFileSync(fileURLToPath(url), "utf8");
  const out = ts.transpileModule(source, {
    fileName: fileURLToPath(url),
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      verbatimModuleSyntax: false,
      isolatedModules: true,
      sourceMap: false,
    },
  });
  return { format: "module", source: out.outputText, shortCircuit: true };
}
`),
  import.meta.url
);
