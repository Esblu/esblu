#!/bin/bash
# ---------------------------------------------------------------------------
# Príprava produktového demo videa pre landing page Esblu.
#
# Zo zdrojového MP4 vyrobí všetko, čo sekcia #ukazka potrebuje:
#   public/video/esblu-demo-1080p.mp4   – desktop (~26 MB)
#   public/video/esblu-demo-720p.mp4    – mobil   (~7 MB)
#   public/video/esblu-demo-poster.jpg  – poster / OG obrázok
#   public/video/esblu-demo-sk.vtt      – slovenské titulky (ak je SRT)
#
# Použitie:
#   ./scripts/prepare-landing-video.sh <cesta-k-finalnemu.mp4> [cesta-k-titulkom.srt]
#
# Potrebné: ffmpeg
#
# Po dobehnutí skript vypíše presné hodnoty, ktoré treba doplniť do
# lib/landing-video.ts (dĺžka a dátum zverejnenia).
# ---------------------------------------------------------------------------
set -euo pipefail

SRC="${1:-}"
SRT="${2:-}"

if [ -z "$SRC" ] || [ ! -f "$SRC" ]; then
  echo "CHYBA: zadaj cestu k finálnemu MP4."
  echo "Použitie: $0 <video.mp4> [titulky.srt]"
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/public/video"
mkdir -p "$OUT"

echo "Zdroj: $SRC"
ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$SRC" \
  | awk '{printf "Dĺžka: %.0f s (%d:%02d)\n", $1, int($1/60), int($1)%60}'

# --- 1080p pre desktop -----------------------------------------------------
# CRF 26 je pri tmavom UI s pomalým pohybom vizuálne nerozoznateľné od
# originálu a zmenší súbor rádovo na tretinu. +faststart presunie moov atom
# na začiatok, aby sa video dalo prehrávať počas sťahovania.
echo "→ 1080p ..."
ffmpeg -y -i "$SRC" \
  -c:v libx264 -preset medium -crf 26 -pix_fmt yuv420p -profile:v high -level 4.0 \
  -movflags +faststart \
  -c:a aac -b:a 128k -ac 2 \
  "$OUT/esblu-demo-1080p.mp4" -loglevel error

# --- 720p pre mobil --------------------------------------------------------
echo "→ 720p ..."
ffmpeg -y -i "$SRC" \
  -vf scale=1280:-2 \
  -c:v libx264 -preset medium -crf 26 -pix_fmt yuv420p -profile:v high -level 3.1 \
  -movflags +faststart \
  -c:a aac -b:a 96k -ac 2 \
  "$OUT/esblu-demo-720p.mp4" -loglevel error

# --- Poster ----------------------------------------------------------------
# Snímka z 2. sekundy druhej kapitoly (logo + reálne rozhranie appky).
# Ak chceš iný záber, zmeň -ss.
echo "→ poster ..."
ffmpeg -y -ss 48.6 -i "$SRC" -frames:v 1 -q:v 3 \
  "$OUT/esblu-demo-poster.jpg" -loglevel error

# --- Titulky ---------------------------------------------------------------
if [ -n "$SRT" ] && [ -f "$SRT" ]; then
  echo "→ titulky (SRT → VTT) ..."
  # Prehliadače nevedia SRT, potrebujú WebVTT.
  ffmpeg -y -i "$SRT" "$OUT/esblu-demo-sk.vtt" -loglevel error
else
  echo "→ titulky preskočené (SRT nebol zadaný)"
fi

echo
echo "Hotovo. Výsledok:"
ls -lh "$OUT" | awk 'NR>1 {printf "  %-28s %s\n", $9, $5}'

echo
echo "Doplň do lib/landing-video.ts:"
ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$SRC" \
  | awk '{printf "  VIDEO_DURATION_SECONDS = %d\n", $1}'
echo "  VIDEO_PUBLISHED_AT = \"$(date +%F)\""
echo
echo "A over, že časy v VIDEO_CHAPTERS sedia s týmto strihom."
