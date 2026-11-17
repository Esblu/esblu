#!/bin/bash
# Snímky aplikácie pre verejný web (public/images/landing/*).
# Skutočné UI Esblu (next dev) + syntetická demo firma z handlers.js —
# všetky volania Supabase sú zachytené Playwrightom a obslúžené lokálne,
# žiadna databáza (ani staging, ani produkcia) sa nepoužije.
#
# Použitie (z koreňa repa):
#   PLAYWRIGHT_MODULE=/cesta/k/playwright GEIST_DIR=/cesta/ku/geist-sans \
#     scripts/landing-screenshots/run.sh / out-desktop.png 1440 900 / out-mobile.png 390 780
#   NOSESSION=1 … = verejný web bez prihlásenia; FULL=1 … = celá stránka.
# Potom: WebP (q86) do public/images/landing/ — pozri docs/open-registration-2026-11-17.md.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export NEXT_PUBLIC_SUPABASE_URL=https://mock.supabase.test NEXT_PUBLIC_SUPABASE_ANON_KEY=mock NEXT_TELEMETRY_DISABLED=1
if ! curl -s -o /dev/null --noproxy localhost http://localhost:3100/login; then
  (npx next dev -p 3100 > "${TMPDIR:-/tmp}/esblu-shots-dev.log" 2>&1 &)
  for _ in $(seq 1 90); do curl -s -o /dev/null --noproxy localhost http://localhost:3100/login && break; sleep 2; done
fi
export PW_TEST_SCREENSHOT_NO_FONTS_READY=1 NO_PROXY=localhost,127.0.0.1
while [ $# -gt 0 ]; do node "$HERE/rig.js" "$1" "$2" "$3" "$4" "$2.requests.log"; shift 4; done
