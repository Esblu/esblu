#!/usr/bin/env python3
"""
Generovanie natívnych ikon a splash obrazoviek z REPO brand assetov (Mobile Platform 2026-10-08).

  python3 scripts/generate-mobile-assets.py splash
      Splash (iOS + Android) zo schváleného public/icons/icon-512.png (PWA ikona),
      vycentrovaný bez zväčšenia na bielom pozadí (rohy ikony sú biele). Rozmery sa berú
      z existujúcich súborov, takže sa nemení konfigurácia natívnych projektov.

  python3 scripts/generate-mobile-assets.py icon --source <cesta-k-1024x1024.png>
      App ikony (iOS AppIcon 1024 bez alfa kanála + Android mipmap ic_launcher,
      ic_launcher_round, ic_launcher_foreground). FAIL CLOSED: bez zdroja
      ≥ 1024×1024 (štvorec) nič nezapíše — žiadne zväčšovanie 512 px ikony
      ani vymýšľanie brandu. Chýbajúci vstup: 1024×1024 Esblu master ikona.
"""
import argparse
import glob
import os
import sys

from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BRAND_ICON = os.path.join(ROOT, "public", "icons", "icon-512.png")
BACKGROUND = (0xFF, 0xFF, 0xFF)  # rohy schválenej ikony sú biele (nie priehľadné)
IOS_ASSETS = os.path.join(ROOT, "mobile", "ios", "App", "App", "Assets.xcassets")
ANDROID_RES = os.path.join(ROOT, "mobile", "android", "app", "src", "main", "res")


def splash() -> None:
    icon = Image.open(BRAND_ICON).convert("RGBA")
    targets = glob.glob(os.path.join(IOS_ASSETS, "Splash.imageset", "*.png")) + glob.glob(
        os.path.join(ANDROID_RES, "drawable*", "splash.png")
    )
    for path in targets:
        width, height = Image.open(path).size
        canvas = Image.new("RGB", (width, height), BACKGROUND)
        # Ikona max. 40 % kratšej strany, nikdy nie väčšia ako originál (bez rozmazania).
        side = min(icon.width, int(min(width, height) * 0.4))
        scaled = icon.resize((side, side), Image.LANCZOS) if side != icon.width else icon
        canvas.paste(scaled, ((width - side) // 2, (height - side) // 2), scaled)
        canvas.save(path, optimize=True)
        print(f"splash {width}x{height} -> {os.path.relpath(path, ROOT)}")


ANDROID_ICON_SIZES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
ANDROID_FOREGROUND_SIZES = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}
NOTIFICATION_SIZES = {"mdpi": 24, "hdpi": 36, "xhdpi": 48, "xxhdpi": 72, "xxxhdpi": 96}
# Adaptive icon: launcher maskuje 108dp vrstvu; garantovane viditelny je kruh
# s priemerom 66dp (polomer 0.3056 vrstvy). Obsah mastra (symbol + "Esblu")
# siaha do polomeru ~0.389 → master sa vo foreground zmensi na 0.77, aby sa
# nic z obsahu neorezalo ani pri kruhovej maske. Artwork sa NEMENI.
ADAPTIVE_SCALE = 0.77
PROPOSALS = os.path.join(ROOT, "mobile", "icon-source", "proposals")


def _content_box(rgb):
    """Bbox symbolu a textu (modré + tmavé pixely), na overenie a návrhy."""
    w, h = rgb.size
    px = rgb.load()
    xs, ys = [], []
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            r, g, b = px[x, y]
            if (b > 180 and r < 160) or (r < 90 and g < 90):
                xs.append(x)
                ys.append(y)
    return min(xs), min(ys), max(xs), max(ys)


def icon(source: str) -> None:
    if not source or not os.path.exists(source):
        sys.exit("CHÝBA VSTUP: 1024×1024 Esblu master ikona (--source). Nič sa nezapísalo.")
    master = Image.open(source)
    if master.width != master.height or master.width < 1024:
        sys.exit(f"NEPLATNÝ VSTUP: potrebný štvorec ≥ 1024×1024, dodané {master.width}×{master.height}. Nič sa nezapísalo.")
    rgb = master.convert("RGB")  # master je nepriehľadný; App Store aj tak vyžaduje bez alfa
    # iOS: jediná 1024 univerzálna ikona (Xcode z nej vygeneruje všetky veľkosti).
    rgb.resize((1024, 1024), Image.LANCZOS).save(os.path.join(IOS_ASSETS, "AppIcon.appiconset", "AppIcon-512@2x.png"))
    # Android legacy (API 24–25) + round: celý master.
    circle_mask = Image.new("L", (1024, 1024), 0)
    from PIL import ImageDraw
    ImageDraw.Draw(circle_mask).ellipse((0, 0, 1023, 1023), fill=255)
    for density, size in ANDROID_ICON_SIZES.items():
        folder = os.path.join(ANDROID_RES, f"mipmap-{density}")
        rgb.resize((size, size), Image.LANCZOS).save(os.path.join(folder, "ic_launcher.png"))
        round_icon = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
        round_icon.paste(rgb.resize((1024, 1024), Image.LANCZOS), (0, 0), circle_mask)
        round_icon.resize((size, size), Image.LANCZOS).save(os.path.join(folder, "ic_launcher_round.png"))
    # Android adaptive foreground (API 26+): master zmenšený do safe zóny, pozadie biele (values/ic_launcher_background.xml).
    for density, size in ANDROID_FOREGROUND_SIZES.items():
        canvas = Image.new("RGB", (size, size), BACKGROUND)
        inner = round(size * ADAPTIVE_SCALE)
        canvas.paste(rgb.resize((inner, inner), Image.LANCZOS), ((size - inner) // 2, (size - inner) // 2))
        canvas.save(os.path.join(ANDROID_RES, f"mipmap-{density}", "ic_launcher_foreground.png"))
    print("ikony vygenerované: iOS AppIcon 1024 + Android mipmap (legacy, round, adaptive foreground)")
    proposals(rgb)


def proposals(rgb) -> None:
    """NÁVRHY (nezapojené): symbol-only fallback pre notifikácie + náhľady čitateľnosti."""
    os.makedirs(PROPOSALS, exist_ok=True)
    w, h = rgb.size
    # Symbol = modré pixely nad textom → biela silueta s alfou (Android status bar ikona musí byť monochrómna).
    px = rgb.load()
    x0, y0, x1, y1 = _content_box(rgb)
    text_top = next(y for y in range(y0, y1) if any(px[x, y][0] < 90 and px[x, y][1] < 90 for x in range(x0, x1, 3)))
    sym = Image.new("L", (w, h), 0)
    sp = sym.load()
    for y in range(y0, text_top - 10):
        for x in range(x0, x1 + 1):
            r, g, b = px[x, y]
            if b > 180 and r < 200 and (b - r) > 40:
                sp[x, y] = 255
    bbox = sym.getbbox()
    sym = sym.crop(bbox)
    side = max(sym.size)
    square = Image.new("L", (side, side), 0)
    square.paste(sym, ((side - sym.width) // 2, (side - sym.height) // 2))
    for density, size in NOTIFICATION_SIZES.items():
        out = Image.new("RGBA", (size, size), (255, 255, 255, 0))
        pad = max(1, size // 12)
        alpha = square.resize((size - 2 * pad, size - 2 * pad), Image.LANCZOS)
        layer = Image.new("RGBA", alpha.size, (255, 255, 255, 255))
        layer.putalpha(alpha)
        out.paste(layer, (pad, pad), layer)
        out.save(os.path.join(PROPOSALS, f"ic_stat_esblu-{density}.png"))
    # Náhľad čitateľnosti: master v launcher veľkostiach (dp pri 1x hustote aj px pri 3x).
    sizes = [192, 144, 96, 72, 48, 29]
    sheet = Image.new("RGB", (sum(sizes) + 20 * (len(sizes) + 1), 220), (230, 233, 238))
    x = 20
    for size in sizes:
        sheet.paste(rgb.resize((size, size), Image.LANCZOS), (x, 10))
        x += size + 20
    # adaptive kruhová maska (najprísnejšia) — nič z obsahu nesmie byť orezané
    fg = Image.new("RGB", (216, 216), BACKGROUND)
    inner = round(216 * ADAPTIVE_SCALE)
    fg.paste(rgb.resize((inner, inner), Image.LANCZOS), ((216 - inner) // 2, (216 - inner) // 2))
    view = fg.crop((36, 36, 180, 180))  # 72dp viewport z 108dp vrstvy
    mask = Image.new("L", view.size, 0)
    from PIL import ImageDraw
    ImageDraw.Draw(mask).ellipse((0, 0, view.width - 1, view.height - 1), fill=255)
    bg = Image.new("RGB", view.size, (230, 233, 238))
    bg.paste(view, (0, 0), mask)
    big = Image.new("RGB", (sheet.width, sheet.height + 170), (230, 233, 238))
    big.paste(sheet, (0, 0))
    big.paste(bg, (20, 225))
    big.save(os.path.join(PROPOSALS, "legibility-preview.png"))
    print(f"návrhy: {os.path.relpath(PROPOSALS, ROOT)} (symbol-only notifikačná ikona + náhľad čitateľnosti) — NEZAPOJENÉ")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["splash", "icon"])
    parser.add_argument("--source")
    args = parser.parse_args()
    splash() if args.mode == "splash" else icon(args.source)
