// Firebase connection. This config is meant to be public; access is controlled by Firestore security rules.
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import { initializeFirestore, persistentLocalCache, persistentSingleTabManager, memoryLocalCache } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyA1AC8HPl9IZxf9tlb3fjoLB_mpCSx8L3g",
  authDomain: "auth.wasabi.co.tz",   // Google sign-in runs on our own address (Firebase Hosting custom domain)
  projectId: "order-app-47367",
  storageBucket: "order-app-47367.firebasestorage.app",
  messagingSenderId: "151565820125",
  appId: "1:151565820125:web:4dc266a4bb5fa6ae793b34"
};

// On the demo stage several "phones" share one browser. Each simulated diner (?as=1, ?as=2) gets
// its own named app, so each keeps its own sign-in, even across reloads.
const as = new URLSearchParams(location.search).get("as");
export const app = as ? initializeApp(firebaseConfig, "as-" + as) : initializeApp(firebaseConfig);
// Speed: keep a copy of what this phone has read (so screens can show it at once next time), and fall
// back to plain requests on networks that stall the live connection (some mobile networks and proxies do).
function makeDb() {
  const base = { experimentalAutoDetectLongPolling: true };
  // One tab keeps the saved copy; any other open tab works on its own (memory only). With a shared cache
  // across tabs, one sleeping background tab could hold up another tab's writes for a long time.
  try { return initializeFirestore(app, { ...base, localCache: persistentLocalCache({ tabManager: persistentSingleTabManager({}) }) }); }
  catch { return initializeFirestore(app, { ...base, localCache: memoryLocalCache() }); }
}
export const db = makeDb();
