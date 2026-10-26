// Service worker: makes staff phones ring when the screen is off or Chrome is closed.
// The server (functions/index.js) sends a push through Firebase Cloud Messaging; Android wakes this
// worker, which shows a notification with sound and a long buzz. Tapping it opens the waiter screen.
// It does nothing else: no caching, so pages always load fresh.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let msg = {};
  try { const p = event.data ? event.data.json() : {}; msg = p.data || p; } catch { msg = {}; }
  const title = msg.title || "Wasabi";
  const opts = {
    body: msg.body || "Something needs you",
    tag: msg.tag || "wasabi",           // one notification per table and kind, replaced not stacked
    renotify: true,                     // …but it still rings again each time
    requireInteraction: true,           // stays until the waiter taps it
    vibrate: [600, 200, 600, 200, 600, 200, 600],
    icon: msg.icon || "img/brand/wasabi-icon-192.png",
    badge: "img/brand/wasabi-badge-96.png",
    timestamp: Number(msg.t) || Date.now(),
    data: { url: msg.url || "/" },
  };
  event.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const target = new URL(url, self.location.origin);
    // An open waiter screen for the same restaurant: bring it forward instead of opening another.
    const same = all.find((c) => { try { const u = new URL(c.url); return u.origin === target.origin && u.pathname === target.pathname && u.search === target.search; } catch { return false; } });
    if (same) { try { await same.focus(); return; } catch {} }
    await self.clients.openWindow(target.href);
  })());
});
