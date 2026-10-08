# Deep link šablóny (NENASADENÉ)

Šablóny **nie sú v `public/`**, takže sa nedostanú na web, kým to výslovne neschváliš. Nasadenie na `https://www.esblu.com/.well-known/` znamená web deploy.

| Súbor | Placeholder | Kto ho dodá |
|---|---|---|
| `apple-app-site-association.template.json` | `__APPLE_TEAM_ID__` (10 znakov) | APPLE USER ACTION — Apple Developer → Membership |
| `assetlinks.template.json` | `__GOOGLE_PLAY_APP_SIGNING_SHA256__` | GOOGLE USER ACTION — Play Console → App integrity → App signing key certificate |

Prvý fingerprint v `assetlinks.template.json` je existujúci upload certifikát z produkčného `public/.well-known/assetlinks.json`.

## Vygenerovanie

```bash
node scripts/render-deep-link-files.mjs --team-id ABCDE12345 --play-sha256 AA:BB:...
```

Skript zapíše do `mobile/deep-link-templates/out/` (ignorované Gitom).

Nasadenie:

- `apple-app-site-association` bez prípony, `Content-Type: application/json`, bez presmerovania;
- `assetlinks.json`.

Oba súbory sa nasadzujú iba so súhlasom.

Skript odmietne neplatný Team ID aj fingerprint (fail closed). Výstup preto nikdy neobsahuje placeholder.
