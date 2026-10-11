#!/usr/bin/env python3
"""
Esblu — generátor modulových ilustrácií nástenky (soft 3D / izometria).

Jedna vizuálna rodina pre všetky moduly:
  - spoločná tmavá podstava (izometrická doska) s brand hranou,
  - objekt z brand gradientov (vrch svetlý, ľavá stena stredná, pravá tmavá),
  - papier/svetlé detaily #EAF4FF, akcent nebeská modrá #38BDF8,
  - jemná kruhová žiara a tieň pod objektom.

Farby pochádzajú výhradne z Esblu tokenov (app/globals.css):
  brand-200 #9DCBFF, brand-300 #66AEFF, brand-400 #2F93FF, brand-500 #0181FD,
  brand-600 #0A6BE0, brand-700 #0B5ED0, brand-deep #1236C8, brand-sky #38BDF8.

Výstup: public/images/modules/<key>.svg (vektor, ~2–5 kB, ostrý na každom DPI,
žiadne cudzie/stiahnuté obrázky). Spustenie:

    python3 scripts/generate-module-illustrations.py
"""
from __future__ import annotations

import math
import os

OUT = os.path.join(os.path.dirname(__file__), "..", "public", "images", "modules")

U = 4.0  # px na jednotku
CX, CY = 80.0, 104.0  # projekčný stred
C30, S30 = math.cos(math.radians(30)), math.sin(math.radians(30))


def iso(x: float, y: float, z: float) -> tuple[float, float]:
    return (CX + (x - y) * C30 * U, CY + (x + y) * S30 * U - z * U)


def num(v: float) -> str:
    text = f"{v:.1f}"
    return text[:-2] if text.endswith(".0") else text


def pts(points) -> str:
    return " ".join(f"{num(px)},{num(py)}" for px, py in points)


def pts_compact(points) -> str:
    """Kompaktné súradnice (bez zbytočných núl) — menšie SVG bez straty ostrosti."""
    return " ".join(f"{num(px)},{num(py)}" for px, py in points)


def poly(points, fill: str, extra: str = "") -> str:
    # stroke rovnakej farby zalepí subpixelové škáry medzi stenami (anti-aliasing)
    return f'<polygon points="{pts_compact(points)}" fill="{fill}" stroke="{fill}" stroke-width=".6" stroke-linejoin="round"{extra}/>'


def edge(a, b, opacity: float = 0.5) -> str:
    """Svetlá hrana (jednotné svetlo zľava zhora) — „soft 3D" detail celej rodiny."""
    return f'<path d="M{pts_compact([a])}L{pts_compact([b])}" stroke="#EAF4FF" stroke-opacity="{opacity}" stroke-width=".9" stroke-linecap="round"/>'


def box(x, y, z, w, d, h, top="url(#top)", left="url(#left)", right="url(#right)", highlight: bool = True) -> str:
    t = [iso(x, y, z + h), iso(x + w, y, z + h), iso(x + w, y + d, z + h), iso(x, y + d, z + h)]
    lf = [iso(x, y + d, z), iso(x + w, y + d, z), iso(x + w, y + d, z + h), iso(x, y + d, z + h)]
    rt = [iso(x + w, y, z), iso(x + w, y + d, z), iso(x + w, y + d, z + h), iso(x + w, y, z + h)]
    out = poly(lf, left) + poly(rt, right) + poly(t, top)
    if highlight and w > 1.5 and d > 1.5:
        # predná hrana vrchu (smer k svetlu) + zvislá hrana na nároží
        out += edge(iso(x, y + d, z + h), iso(x + w, y + d, z + h), 0.55)
        out += edge(iso(x + w, y + d, z + h), iso(x + w, y, z + h), 0.3)
    return out


def face_rect_y(x0, x1, z0, z1, y, fill) -> str:
    """Obdĺžnik na stene orientovanej na +y (ľavá viditeľná stena)."""
    return poly([iso(x0, y, z0), iso(x1, y, z0), iso(x1, y, z1), iso(x0, y, z1)], fill)


def face_rect_x(y0, y1, z0, z1, x, fill) -> str:
    """Obdĺžnik na stene orientovanej na +x (pravá viditeľná stena)."""
    return poly([iso(x, y0, z0), iso(x, y1, z0), iso(x, y1, z1), iso(x, y0, z1)], fill)


def top_rect(x0, x1, y0, y1, z, fill) -> str:
    return poly([iso(x0, y0, z), iso(x1, y0, z), iso(x1, y1, z), iso(x0, y1, z)], fill)


def wheel_y(cx, cz, y, r, fill, hub) -> str:
    """Koleso na rovine x–z (stena +y): presná izometrická elipsa ako polygón."""
    ring = [iso(cx + r * math.cos(t), y, cz + r * math.sin(t)) for t in [i * math.pi / 18 for i in range(36)]]
    inner = [iso(cx + r * 0.45 * math.cos(t), y + 0.01, cz + r * 0.45 * math.sin(t)) for t in [i * math.pi / 18 for i in range(36)]]
    return poly(ring, fill) + poly(inner, hub)


def disc(cx, cy, z, r, fill) -> str:
    ring = [iso(cx + r * math.cos(t), cy + r * math.sin(t), z) for t in [i * math.pi / 18 for i in range(36)]]
    return poly(ring, fill)


def cylinder(cx, cy, z, r, h, side, top) -> str:
    """Zvislý valec (minca): bočná plocha + vrchná elipsa."""
    n = 36
    angles = [i * 2 * math.pi / n for i in range(n)]
    bottom = [iso(cx + r * math.cos(a), cy + r * math.sin(a), z) for a in angles]
    upper = [iso(cx + r * math.cos(a), cy + r * math.sin(a), z + h) for a in angles]
    # viditeľná polovica plášťa: body s najväčším x+y
    order = sorted(range(n), key=lambda i: math.cos(angles[i]) + math.sin(angles[i]), reverse=True)
    vis = sorted(order[: n // 2 + 1])
    # súvislý oblúk od min po max uhla v prednej polovici (−45°..135°)
    front = [i for i in range(n) if math.cos(angles[i] - math.pi / 4) >= -0.01]
    front.sort(key=lambda i: (angles[i] - (-math.pi / 4)) % (2 * math.pi))
    hull = [bottom[i] for i in front] + [upper[i] for i in reversed(front)]
    del vis
    return poly(hull, side) + poly(upper, top)


def sparkle(x, y, s, fill) -> str:
    p = [(x, y - s), (x + s * 0.28, y - s * 0.28), (x + s, y), (x + s * 0.28, y + s * 0.28), (x, y + s), (x - s * 0.28, y + s * 0.28), (x - s, y), (x - s * 0.28, y - s * 0.28)]
    return f'<polygon points="{pts(p)}" fill="{fill}"/>'


DEFS = """
<defs>
  <radialGradient id="glow" cx="50%" cy="46%" r="50%">
    <stop offset="0" stop-color="#2F93FF" stop-opacity="0.42"/>
    <stop offset="0.55" stop-color="#1236C8" stop-opacity="0.16"/>
    <stop offset="1" stop-color="#1236C8" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="shadow" cx="50%" cy="50%" r="50%">
    <stop offset="0" stop-color="#000814" stop-opacity="0.55"/>
    <stop offset="1" stop-color="#000814" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="top" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#B8DAFF"/>
    <stop offset="1" stop-color="#5AA9FF"/>
  </linearGradient>
  <linearGradient id="left" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#2F93FF"/>
    <stop offset="1" stop-color="#0A6BE0"/>
  </linearGradient>
  <linearGradient id="right" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#0B5ED0"/>
    <stop offset="1" stop-color="#1236C8"/>
  </linearGradient>
  <linearGradient id="paperTop" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#FFFFFF"/>
    <stop offset="1" stop-color="#D6E9FF"/>
  </linearGradient>
  <linearGradient id="paperSide" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#B7D3F5"/>
    <stop offset="1" stop-color="#8FB5E6"/>
  </linearGradient>
  <linearGradient id="baseTop" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#1A2B4A"/>
    <stop offset="1" stop-color="#0F1B31"/>
  </linearGradient>
  <linearGradient id="glass" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#9FE4FF"/>
    <stop offset="1" stop-color="#38BDF8"/>
  </linearGradient>
</defs>
"""


def base() -> str:
    """Spoločná podstava rodiny (tmavá izometrická doska + brand hrana)."""
    out = '<ellipse cx="80" cy="84" rx="74" ry="66" fill="url(#glow)"/>'
    out += box(-11, -11, -2.2, 22, 22, 2.2, top="url(#baseTop)", left="#0B1426", right="#081020", highlight=False)
    # brand hrana dosky
    out += poly([iso(-11, 11, 0), iso(11, 11, 0), iso(11, 11, -0.35), iso(-11, 11, -0.35)], "#0181FD", ' opacity="0.55"')
    out += poly([iso(11, -11, 0), iso(11, 11, 0), iso(11, 11, -0.35), iso(11, -11, -0.35)], "#0181FD", ' opacity="0.35"')
    return out


def floor_shadow(w=13, d=13) -> str:
    cx, cy = iso(0, 0, 0)
    return f'<ellipse cx="{num(cx)}" cy="{num(cy)}" rx="{num(w * U * 1.5)}" ry="{num(d * U * 0.75)}" fill="url(#shadow)"/>'


def svg(body: str, label: str) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160" width="160" height="160" role="img" aria-label="{label}">'
        + DEFS
        + body
        + "</svg>"
    )


# ----------------------------------------------------------------------------- moduly


def inbox() -> str:
    b = base() + floor_shadow()
    # podnos (otvorená krabica)
    b += box(-7, -7, 0, 14, 14, 3.2)
    b += top_rect(-6, 6, -6, 6, 3.2, "#0A4FB8")
    # stoh dokladov
    b += box(-5.2, -5.6, 3.2, 10, 11, 0.9, top="url(#paperTop)", left="url(#paperSide)", right="#9DBFEA")
    b += box(-4.6, -6.2, 4.1, 10, 11, 0.9, top="url(#paperTop)", left="url(#paperSide)", right="#9DBFEA")
    b += box(-4.0, -6.8, 5.0, 10, 11, 0.9, top="url(#paperTop)", left="url(#paperSide)", right="#9DBFEA")
    # riadky textu na vrchnom doklade
    for i, length in enumerate([7.2, 6.0, 7.2, 4.4]):
        y0 = -5.6 + i * 2.1
        b += top_rect(-2.8, -2.8 + length, y0, y0 + 0.55, 5.91, "#7FB4F2")
    # AI iskra
    b += sparkle(118, 40, 11, "#38BDF8") + sparkle(132, 60, 5, "#9DCBFF")
    return svg(b, "Inbox")


def invoices() -> str:
    b = base() + floor_shadow()
    # doklad (hrubší list)
    b += box(-8, -6, 0, 12, 15, 1.4, top="url(#paperTop)", left="url(#paperSide)", right="#9DBFEA")
    # hlavička a riadky
    b += top_rect(-6.4, -1.0, -4.6, -2.6, 1.41, "#0181FD")
    for i, length in enumerate([8.8, 7.4, 8.8, 6.2]):
        y0 = -1.2 + i * 2.0
        b += top_rect(-6.4, -6.4 + length, y0, y0 + 0.55, 1.41, "#8DBCF0")
    # súčtový pruh
    b += top_rect(-0.6, 2.6, 6.6, 7.8, 1.41, "#0A6BE0")
    # stĺpec mincí
    for k in range(4):
        b += cylinder(6.2, -4.2, 0 + k * 1.5, 3.2, 1.3, "url(#right)", "url(#top)")
    b += disc(6.2, -4.2, 6.01, 1.7, "#EAF4FF")
    b += sparkle(36, 44, 6, "#38BDF8")
    return svg(b, "Faktúry")


def vehicles() -> str:
    b = base() + floor_shadow(15, 12)
    # karoséria dodávky
    b += box(-9, -4.5, 1.2, 13, 9, 7.5)
    # kabína (nižšia, vpredu na +x)
    b += box(4, -4.5, 1.2, 5.5, 9, 5.2)
    # čelné sklo (stena +x) a bočné okno kabíny (stena +y)
    b += face_rect_x(-3.6, 3.6, 3.6, 5.9, 9.5, "url(#glass)")
    b += face_rect_y(4.6, 8.6, 3.6, 5.9, 4.5, "url(#glass)")
    # brand pás na boku
    b += face_rect_y(-8.4, 3.6, 4.4, 5.3, 4.5, "#38BDF8")
    # kolesá (stena +y)
    b += wheel_y(-5.5, 1.3, 4.6, 1.9, "#0B1426", "#9DCBFF")
    b += wheel_y(6.2, 1.3, 4.6, 1.9, "#0B1426", "#9DCBFF")
    # svetlo
    b += face_rect_x(2.4, 3.6, 2.0, 2.8, 9.51, "#FFF4C2")
    return svg(b, "Vozidlá")


def machines() -> str:
    b = base() + floor_shadow(15, 13)
    # pásy
    b += box(-8, -5.5, 0, 12, 3.2, 2.4, top="#33415C", left="#1C2740", right="#151E33")
    b += box(-8, 2.3, 0, 12, 3.2, 2.4, top="#33415C", left="#1C2740", right="#151E33")
    for i in range(6):
        x = -7.3 + i * 2.0
        b += face_rect_y(x, x + 0.8, 0.5, 1.9, 5.5, "#2B3956")
    # telo
    b += box(-7, -4.5, 2.4, 9, 9, 3.6)
    # rameno ZA kabínou (rovina x–z pri y = −3.2): výložník hore, násada dolu, lyžica pri zemi
    y = -3.2
    side = 1.4

    def arm(points, front, back):
        out = poly([iso(px, y, pz) for (px, pz) in points], back)
        out += poly([iso(px, y + side, pz) for (px, pz) in points], front)
        return out

    b += arm([(0.6, 6.2), (2.2, 5.8), (9.4, 13.6), (8.0, 14.8)], "url(#left)", "url(#right)")
    b += arm([(8.0, 14.8), (9.4, 13.6), (14.4, 6.4), (13.0, 6.0)], "url(#left)", "#0B5ED0")
    b += arm([(12.2, 6.8), (15.6, 6.2), (15.2, 2.0), (12.6, 2.8)], "#1236C8", "#0A3FA8")
    jx, jy = iso(8.7, y + side, 14.2)
    b += f'<circle cx="{num(jx)}" cy="{num(jy)}" r="1.7" fill="#9DCBFF"/>'
    # kabína (vpredu, na strane pozorovateľa)
    b += box(-3.4, 0.4, 6.0, 4.4, 4.2, 4.6)
    b += face_rect_x(1.0, 3.9, 7.2, 9.9, 1.01, "url(#glass)")
    b += face_rect_y(-2.8, 0.4, 7.2, 9.9, 4.61, "url(#glass)")
    # výstražný maják
    b += box(-1.8, 2.0, 10.6, 1.0, 1.0, 0.8, top="#FFD27A", left="#F59E0B", right="#D98706")
    return svg(b, "Stroje")


def inventory() -> str:
    b = base() + floor_shadow()
    # paleta
    b += box(-8.5, -8.5, 0, 17, 17, 1.4, top="#2A3A58", left="#1A2640", right="#131D33")
    # krabice (zadné → predné)
    crates = [(-7.5, -7.5, 1.4, 7.2), (0.3, -7.5, 1.4, 7.2), (-7.5, 0.3, 1.4, 7.2), (0.3, 0.3, 1.4, 7.2), (-3.6, -3.6, 8.6, 7.2)]
    for (x, y, z, s) in crates:
        b += box(x, y, z, s, s, s * 0.9)
        h = s * 0.9
        # lepiaca páska na vrchu a stenách
        b += top_rect(x + s * 0.42, x + s * 0.58, y, y + s, z + h + 0.01, "#9FE4FF")
        b += face_rect_y(x + s * 0.42, x + s * 0.58, z + h * 0.55, z + h, y + s + 0.01, "#9FE4FF")
    b += sparkle(126, 44, 6, "#38BDF8")
    return svg(b, "Sklad")


def partners() -> str:
    b = base() + floor_shadow(15, 13)

    def tower(x, y, w, d, h):
        out = box(x, y, 0, w, d, h)
        rows = int(h // 2.2)
        for r in range(rows):
            z0 = 1.2 + r * 2.2
            if z0 + 1.1 > h - 0.6:
                break
            for c in range(2):
                x0 = x + 0.9 + c * (w - 1.8) / 2
                out += face_rect_y(x0, x0 + (w - 1.8) / 2 - 0.7, z0, z0 + 1.1, y + d + 0.01, "url(#glass)")
                y0 = y + 0.9 + c * (d - 1.8) / 2
                out += face_rect_x(y0, y0 + (d - 1.8) / 2 - 0.7, z0, z0 + 1.1, x + w + 0.01, "#7FC9F5")
        return out

    # dve firmy vedľa seba (vľavo vyššia, vpravo nižšia) — obe celé viditeľné
    b += tower(2.0, -9.0, 6.2, 6.2, 9.0)
    b += tower(-9.0, 1.6, 6.2, 6.2, 13.0)
    # prepojenie (vzťah firiem): oblúk + uzly nad strechami
    a = iso(-5.9, 4.7, 13.0)
    c = iso(5.1, -5.9, 9.0)
    mx, my = (a[0] + c[0]) / 2, min(a[1], c[1]) - 26
    b += f'<path d="M{num(a[0])},{num(a[1])} Q{num(mx)},{num(my)} {num(c[0])},{num(c[1])}" fill="none" stroke="#38BDF8" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="1 5.5"/>'
    for (px, py) in (a, c):
        b += f'<circle cx="{num(px)}" cy="{num(py)}" r="4.2" fill="#EAF4FF"/><circle cx="{num(px)}" cy="{num(py)}" r="2.1" fill="#0181FD"/>'
    return svg(b, "Obchodní partneri")


MODULES = {
    "inbox": inbox,
    "invoices": invoices,
    "vehicles": vehicles,
    "machines": machines,
    "inventory": inventory,
    "partners": partners,
}


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    for key, build in MODULES.items():
        path = os.path.join(OUT, f"{key}.svg")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(build())
        print(f"{key}: {os.path.getsize(path)} B")


if __name__ == "__main__":
    main()
