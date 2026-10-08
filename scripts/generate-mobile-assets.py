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


def icon(source: str) -> None:
    if not source or not os.path.exists(source):
        sys.exit("CHÝBA VSTUP: 1024×1024 Esblu master ikona (--source). Nič sa nezapísalo.")
    master = Image.open(source)
    if master.width != master.height or master.width < 1024:
        sys.exit(f"NEPLATNÝ VSTUP: potrebný štvorec ≥ 1024×1024, dodané {master.width}×{master.height}. Nič sa nezapísalo.")
    rgba = master.convert("RGBA")
    ios = Image.new("RGB", rgba.size, BACKGROUND)
    ios.paste(rgba, (0, 0), rgba)  # App Store: bez alfa kanála
    ios.resize((1024, 1024), Image.LANCZOS).save(os.path.join(IOS_ASSETS, "AppIcon.appiconset", "AppIcon-512@2x.png"))
    for density, size in ANDROID_ICON_SIZES.items():
        folder = os.path.join(ANDROID_RES, f"mipmap-{density}")
        for name in ("ic_launcher.png", "ic_launcher_round.png"):
            rgba.resize((size, size), Image.LANCZOS).save(os.path.join(folder, name))
    for density, size in ANDROID_FOREGROUND_SIZES.items():
        canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        inner = int(size * 0.62)  # adaptive icon safe zone (66 % priemeru)
        canvas.paste(rgba.resize((inner, inner), Image.LANCZOS), ((size - inner) // 2, (size - inner) // 2))
        canvas.save(os.path.join(ANDROID_RES, f"mipmap-{density}", "ic_launcher_foreground.png"))
    print("ikony vygenerované (iOS 1024 + Android mipmap)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["splash", "icon"])
    parser.add_argument("--source")
    args = parser.parse_args()
    splash() if args.mode == "splash" else icon(args.source)
