#!/usr/bin/env python3
"""
Generovanie natívnych ikon a splash obrazoviek z REPO brand assetov (Mobile Platform 2026-10-08).

  python3 scripts/generate-mobile-assets.py splash [--source mobile/icon-source/esblu-master-icon.png]
      Splash (iOS + Android) z finálnej master ikony (bez --source: public/icons/icon-512.png),
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


def splash(source: str | None = None) -> None:
    icon = Image.open(source or BRAND_ICON).convert("RGBA")
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
# s priemerom 66dp (polomer 0.3056 vrstvy). Biely symbol + "Esblu" finalnej
# master ikony siaha do polomeru ~0.410 → master sa vo foreground zmensi na
# 0.74 (nic sa neoreze ani kruhovou maskou). Artwork sa NEMENI.
ADAPTIVE_SCALE = 0.74
PROPOSALS = os.path.join(ROOT, "mobile", "icon-source", "proposals")


def _is_mark(rgb_pixel):
    # Biely / svetlomodrý symbol a text (r > 150) vs. modrá dlaždica (r < ~70).
    r, g, b = rgb_pixel
    return r > 150 and g > 200 and b > 220


def _tile_box(rgb):
    """Modrá dlaždica mastra (biely symbol a text sú VNÚTRI nej)."""
    px = rgb.load()
    w, h = rgb.size
    pts = [(x, y) for y in range(0, h, 3) for x in range(0, w, 3) if px[x, y][2] > 200 and px[x, y][0] < 120]
    return min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts)


def _mark_bands(rgb):
    """Pásy riadkov s bielym symbolom/textom vo vnútri dlaždice; lesk a odlesky (nízke pásy) sa ignorujú."""
    px = rgb.load()
    x0, y0, x1, y1 = _tile_box(rgb)
    inset = int((x1 - x0) * 0.06)
    rows = [y for y in range(y0 + inset, y1 - inset) if sum(1 for x in range(x0 + inset, x1 - inset, 3) if _is_mark(px[x, y])) > 2]
    bands, start, prev = [], rows[0], rows[0]
    for y in rows[1:]:
        if y - prev > 12:
            bands.append((start, prev))
            start = y
        prev = y
    bands.append((start, prev))
    h = rgb.size[1]
    bands = [b for b in bands if b[1] - b[0] > h * 0.05]
    symbol = max(bands, key=lambda b: b[1] - b[0])
    text = next((b for b in bands if b[0] > symbol[1]), None)
    return (x0 + inset, x1 - inset), symbol, text


def icon(source: str) -> None:
    if not source or not os.path.exists(source):
        sys.exit("CHÝBA VSTUP: 1024×1024 Esblu master ikona (--source). Nič sa nezapísalo.")
    master = Image.open(source)
    if master.width != master.height or master.width < 1024:
        sys.exit(f"NEPLATNÝ VSTUP: potrebný štvorec ≥ 1024×1024, dodané {master.width}×{master.height}. Nič sa nezapísalo.")
    rgb = master.convert("RGB")  # master je nepriehľadný; App Store vyžaduje bez alfa
    from PIL import ImageDraw
    # iOS: jediná 1024 univerzálna ikona (Xcode z nej odvodí všetky veľkosti).
    rgb.resize((1024, 1024), Image.LANCZOS).save(os.path.join(IOS_ASSETS, "AppIcon.appiconset", "AppIcon-512@2x.png"))
    # Android legacy (API 24–25) + round: celý master.
    big = rgb.resize((1024, 1024), Image.LANCZOS)
    circle_mask = Image.new("L", (1024, 1024), 0)
    ImageDraw.Draw(circle_mask).ellipse((0, 0, 1023, 1023), fill=255)
    for density, size in ANDROID_ICON_SIZES.items():
        folder = os.path.join(ANDROID_RES, f"mipmap-{density}")
        big.resize((size, size), Image.LANCZOS).save(os.path.join(folder, "ic_launcher.png"))
        round_icon = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
        round_icon.paste(big, (0, 0), circle_mask)
        round_icon.resize((size, size), Image.LANCZOS).save(os.path.join(folder, "ic_launcher_round.png"))
    # Android adaptive foreground (API 26+): master zmenšený do safe zóny na bielom
    # pozadí (values/ic_launcher_background.xml = #FFFFFF, rovnaké ako okraj mastra).
    for density, size in ANDROID_FOREGROUND_SIZES.items():
        canvas = Image.new("RGB", (size, size), (255, 255, 255))
        inner = round(size * ADAPTIVE_SCALE)
        canvas.paste(rgb.resize((inner, inner), Image.LANCZOS), ((size - inner) // 2, (size - inner) // 2))
        canvas.save(os.path.join(ANDROID_RES, f"mipmap-{density}", "ic_launcher_foreground.png"))
    notification_icon(rgb)
    print("ikony vygenerované: iOS AppIcon 1024 + Android mipmap (legacy, round, adaptive) + notifikačná ikona")
    legibility_preview(rgb)


def notification_icon(rgb) -> None:
    """Android status bar ikona: IBA biely symbol (bez textu) ako silueta s alfou — z mastra, bez úprav tvaru."""
    px = rgb.load()
    (xa, xb), (sy0, sy1), _ = _mark_bands(rgb)
    w, h = rgb.size
    sym = Image.new("L", (w, h), 0)
    sp = sym.load()
    for y in range(sy0, sy1 + 1):
        for x in range(xa, xb + 1):
            if _is_mark(px[x, y]):
                sp[x, y] = 255
    from PIL import ImageFilter
    # Uzavretie drobných dier po tieňovaní ťahov (closing), potom iba ťahy symbolu.
    sym = sym.filter(ImageFilter.MaxFilter(11)).filter(ImageFilter.MinFilter(11))
    sym = _fill_holes(_drop_small_components(sym.crop(sym.getbbox())))
    side = max(sym.size)
    square = Image.new("L", (side, side), 0)
    square.paste(sym, ((side - sym.width) // 2, (side - sym.height) // 2))
    for density, size in NOTIFICATION_SIZES.items():
        folder = os.path.join(ANDROID_RES, f"drawable-{density}")
        os.makedirs(folder, exist_ok=True)
        out = Image.new("RGBA", (size, size), (255, 255, 255, 0))
        pad = max(1, size // 12)
        alpha = square.resize((size - 2 * pad, size - 2 * pad), Image.LANCZOS)
        layer = Image.new("RGBA", alpha.size, (255, 255, 255, 255))
        layer.putalpha(alpha)
        out.paste(layer, (pad, pad), layer)
        out.save(os.path.join(folder, "ic_stat_esblu.png"))


def _fill_holes(mask):
    """Vyplní diery vnútri ťahov (pozadie nedosiahnuteľné z okraja) — silueta bez bodiek."""
    w, h = mask.size
    framed = Image.new("L", (w + 2, h + 2), 0)
    framed.paste(mask, (1, 1))
    px = framed.load()
    seen = bytearray((w + 2) * (h + 2))
    stack = [(0, 0)]
    seen[0] = 1
    while stack:
        x, y = stack.pop()
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < w + 2 and 0 <= ny < h + 2 and not seen[ny * (w + 2) + nx] and px[nx, ny] < 128:
                seen[ny * (w + 2) + nx] = 1
                stack.append((nx, ny))
    out = mask.copy()
    op = out.load()
    for y in range(h):
        for x in range(w):
            if op[x, y] < 128 and not seen[(y + 1) * (w + 2) + x + 1]:
                op[x, y] = 255
    return out


def _drop_small_components(mask):
    """Odstráni drobné zvyšky (lesk, okraj textu) — ponechá iba ťahy symbolu (komponenty ≥ 3 % plochy)."""
    w, h = mask.size
    px = mask.load()
    seen = bytearray(w * h)
    comps = []
    for y0 in range(h):
        for x0 in range(w):
            if px[x0, y0] < 128 or seen[y0 * w + x0]:
                continue
            stack, comp = [(x0, y0)], []
            seen[y0 * w + x0] = 1
            while stack:
                x, y = stack.pop()
                comp.append((x, y))
                for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                    if 0 <= nx < w and 0 <= ny < h and not seen[ny * w + nx] and px[nx, ny] >= 128:
                        seen[ny * w + nx] = 1
                        stack.append((nx, ny))
            comps.append(comp)
    total = sum(len(c) for c in comps) or 1
    out = Image.new("L", (w, h), 0)
    op = out.load()
    for comp in comps:
        if len(comp) / total >= 0.03:
            for x, y in comp:
                op[x, y] = 255
    return out.crop(out.getbbox())


def legibility_preview(rgb) -> None:
    """Náhľad čitateľnosti (launcher veľkosti + kruhová adaptive maska) — iba na kontrolu, nie do buildu."""
    from PIL import ImageDraw
    os.makedirs(PROPOSALS, exist_ok=True)
    sizes = [192, 144, 96, 72, 48, 29]
    sheet = Image.new("RGB", (sum(sizes) + 20 * (len(sizes) + 1), 400), (230, 233, 238))
    x = 20
    for size in sizes:
        sheet.paste(rgb.resize((size, size), Image.LANCZOS), (x, 10))
        x += size + 20
    fg = Image.new("RGB", (216, 216), (255, 255, 255))
    inner = round(216 * ADAPTIVE_SCALE)
    fg.paste(rgb.resize((inner, inner), Image.LANCZOS), ((216 - inner) // 2, (216 - inner) // 2))
    view = fg.crop((36, 36, 180, 180))
    for i, shape in enumerate(("circle", "squircle")):
        mask = Image.new("L", view.size, 0)
        d = ImageDraw.Draw(mask)
        if shape == "circle":
            d.ellipse((0, 0, view.width - 1, view.height - 1), fill=255)
        else:
            d.rounded_rectangle((0, 0, view.width - 1, view.height - 1), radius=36, fill=255)
        sheet.paste(view, (20 + i * 170, 225), mask)
    stat = Image.open(os.path.join(ANDROID_RES, "drawable-xxxhdpi", "ic_stat_esblu.png"))
    dark = Image.new("RGBA", (96, 96), (40, 40, 40, 255))
    dark.alpha_composite(stat)
    sheet.paste(dark.convert("RGB"), (400, 225))
    sheet.save(os.path.join(PROPOSALS, "legibility-preview.png"))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["splash", "icon"])
    parser.add_argument("--source")
    args = parser.parse_args()
    splash(args.source) if args.mode == "splash" else icon(args.source)
