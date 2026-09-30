/* =============================================================================
 * Esblu — service worker IBA pre push notifikácie.
 *
 * Žiadne offline cache ani zachytávanie požiadaviek (appka sa správa presne
 * ako doteraz). Iba:
 *   push              → zobrazí notifikáciu (text už pripravil server v jazyku
 *                       zariadenia, všeobecný — žiadne sumy ani mená),
 *   notificationclick → otvorí obrazovku z ALLOWLISTU (screen + id), nikdy
 *                       URL z payloadu; appka si pri otvorení vyžiada
 *                       prihlásenie ako vždy.
 * Tabuľka obrazoviek = lib/push/deep-link.ts (test ich porovnáva).
 * ============================================================================= */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

var PUSH_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pushTargetPath(data) {
  var screen = data && typeof data.screen === "string" ? data.screen : "";
  var id = data && typeof data.id === "string" && PUSH_UUID.test(data.id) ? data.id.toLowerCase() : "";
  switch (screen) {
    case "chat":
      return id ? "/chat/" + id : "/";
    case "chat_index":
      return "/chat";
    case "vehicle":
      return id ? "/vozidla/" + id : "/";
    case "machine":
      return id ? "/stroje/" + id : "/";
    case "settings":
      return "/nastavenia";
    default:
      return "/";
  }
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === "string" && data.title ? data.title : "Esblu";
  const options = {
    body: typeof data.body === "string" ? data.body : "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: typeof data.tag === "string" ? data.tag : "esblu",
    // Uložia sa iba overené polia cieľa; cesta sa skladá až pri kliknutí.
    data: { screen: typeof data.screen === "string" ? data.screen : "home", id: typeof data.id === "string" ? data.id : "" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(pushTargetPath(event.notification.data), self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (client.url.startsWith(self.location.origin) && "focus" in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
