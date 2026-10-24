// Ringing staff phones with the screen off (Android Chrome; iPhone only when added to the home screen).
// The phone asks once for notification permission, gets a push address from Firebase Cloud Messaging and
// saves it to restaurants/{rid}/push/{uid}. When a diner calls, asks for the bill or sits at a new table,
// or an order is marked ready, that phone pings the ring service (worker/ring.js), which checks it in the
// database and rings the right waiters. sw.js shows the notification.
import { setDoc } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";

// Web Push public key: Firebase console → Project settings → Cloud Messaging → Web Push certificates.
// Empty means ringing isn't switched on yet, and the waiter screen doesn't offer it.
export const VAPID_KEY = "";
// The ring service (worker/ring.js on Cloudflare), e.g. "https://wasabi-ring.NAME.workers.dev".
// Empty: nothing is sent. The staging site uses its own copy (wasabi-ring-staging).
const RING_LIVE = "";
export const RING_URL = RING_LIVE && /staging|localhost/.test(location.hostname) ? RING_LIVE.replace("//wasabi-ring.", "//wasabi-ring-staging.") : RING_LIVE;

const SW_URL = new URL("./sw.js", import.meta.url);
let reg = null, messaging = null;

export function pushAvailable() {
  return !!VAPID_KEY && window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}
// "on" (allowed), "off" (not asked yet), "blocked" (refused in browser settings) or "unsupported".
export function pushState() {
  if (!pushAvailable()) return "unsupported";
  return Notification.permission === "granted" ? "on" : Notification.permission === "denied" ? "blocked" : "off";
}
async function ready(app) {
  if (!reg) reg = await navigator.serviceWorker.register(SW_URL, { scope: new URL("./", SW_URL).pathname });
  if (!messaging) {
    const m = await import("https://www.gstatic.com/firebasejs/13.0.0/firebase-messaging.js");
    if (!(await m.isSupported())) throw Object.assign(new Error("unsupported"), { code: "unsupported" });
    messaging = { m, inst: m.getMessaging(app) };
  }
  return messaging;
}
// Save (or refresh) this phone's push address. `ref` is the phone's push document; `url` is the screen
// a tap on the notification opens.
async function save(app, ref, url) {
  const { m, inst } = await ready(app);
  const token = await m.getToken(inst, { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
  if (!token) throw new Error("No push address");
  await setDoc(ref, { token, t: Date.now(), url: String(url).slice(0, 500) });
  return token;
}
// Called from a tap: asks for permission, then saves. Resolves to the new state.
export async function enablePush(app, ref, url) {
  if (!pushAvailable()) return "unsupported";
  const p = await Notification.requestPermission();
  if (p !== "granted") return p === "denied" ? "blocked" : "off";
  await save(app, ref, url);
  return "on";
}
// On each visit with permission already given: keep the address fresh (it can change). Never prompts.
export async function refreshPush(app, ref, url) {
  if (pushState() !== "on") return false;
  try { await save(app, ref, url); return true; } catch (e) { console.warn("push refresh", e); return false; }
}
// A ring shown by this phone itself, so the waiter can hear and see what it will be like.
export async function testRing(name) {
  if (!reg) reg = await navigator.serviceWorker.register(SW_URL, { scope: new URL("./", SW_URL).pathname });
  await navigator.serviceWorker.ready;
  await reg.showNotification("Test · Table 4 · Call waiter", {
    body: `${name ? name + ", this" : "This"} is how the phone rings when the screen is off.`, tag: "wasabi-test", renotify: true,
    vibrate: [600, 200, 600, 200, 600], icon: new URL("./img/brand/wasabi-icon-192.png", SW_URL).href,
    badge: new URL("./img/brand/wasabi-badge-96.png", SW_URL).href, data: { url: location.href },
  });
}

// Ask the ring service to ring the waiters for this alert, ready order or new table. Fire and forget:
// the service checks the document itself, so this only says where to look. `count` is how many dishes
// became ready together. Sent as plain text so the browser doesn't need a pre-flight request.
export function ringFor(path, count) {
  if (!RING_URL || !path) return;
  try { fetch(RING_URL, { method: "POST", keepalive: true, mode: "no-cors", headers: { "content-type": "text/plain" }, body: JSON.stringify({ path, count: count || 1 }) }).catch(() => {}); } catch {}
}
