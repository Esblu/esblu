/* =============================================================================
 * Esblu — service worker IBA pre push notifikácie.
 *
 * Žiadne offline cache ani zachytávanie požiadaviek (appka sa správa presne
 * ako doteraz). Iba:
 *   push              → zobrazí notifikáciu (text už pripravil server,
 *                       všeobecný — žiadne sumy ani mená),
 *   notificationclick → otvorí RELATÍVNU cestu v Esblu; appka si pri
 *                       otvorení vyžiada prihlásenie ako vždy.
 * ============================================================================= */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

function safeUrl(url) {
  return typeof url === "string" && /^\/(?!\/)[A-Za-z0-9\-._~/?=&%]*$/.test(url) && url.indexOf("..") === -1 ? url : "/";
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
    data: { url: safeUrl(data.url) },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(safeUrl(event.notification.data && event.notification.data.url), self.location.origin).href;
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
