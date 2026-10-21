// Diner sign-in with Firebase Authentication: Google (free) and phone number with an SMS code.
// Signing in is optional; guests still join with just a first name.
import { app } from "./firebase.js";
import {
  getAuth, initializeAuth, inMemoryPersistence, onAuthStateChanged, GoogleAuthProvider,
  signInWithPopup, RecaptchaVerifier, signInWithPhoneNumber, signOut, deleteUser,
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";

// On the demo stage several "phones" share one browser. Each keeps its sign-in in memory only,
// so two simulated diners are never signed in as the same person.
const demoFrame = new URLSearchParams(location.search).has("as");
export const auth = demoFrame ? initializeAuth(app, { persistence: inMemoryPersistence }) : getAuth(app);

export const onUser = (f) => onAuthStateChanged(auth, f);
export const googleSignIn = () => signInWithPopup(auth, new GoogleAuthProvider());
export const signOutUser = () => signOut(auth);
export const deleteMe = () => deleteUser(auth.currentUser);

// Tanzanian numbers: 0748 227 000, 748227000 and +255748227000 all become +255748227000.
export function normalisePhone(raw) {
  const d = String(raw || "").replace(/[^\d+]/g, "");
  if (d.startsWith("+")) return d.length >= 10 ? d : null;
  const n = d.replace(/^0+/, "");
  if (n.startsWith("255") && n.length === 12) return "+" + n;
  return n.length === 9 ? "+255" + n : null;
}

// Phone sign-in is two steps: send the code, then confirm it. The invisible reCAPTCHA (Firebase's
// abuse check) lives in a fixed element outside the redrawn screen.
let verifier = null, confirmation = null;
export async function phoneStart(number) {
  try {
    if (!verifier) verifier = new RecaptchaVerifier(auth, "recaptcha", { size: "invisible" });
    confirmation = await signInWithPhoneNumber(auth, number, verifier);
  } catch (e) { try { verifier && verifier.clear(); } catch {} verifier = null; throw e; }
}
// Once the code is confirmed the robot check is no longer needed: remove it from the page.
export async function phoneConfirm(code) {
  const r = await confirmation.confirm(code);
  try { verifier && verifier.clear(); } catch {} verifier = null; confirmation = null;
  return r;
}

// Plain-language messages for the errors diners actually hit.
export function authMessage(e) {
  const c = (e && e.code) || "";
  if (c.includes("invalid-verification-code")) return "That code isn't right. Check the SMS and try again.";
  if (c.includes("code-expired")) return "That code has expired. Send a new one.";
  if (c.includes("too-many-requests")) return "Too many tries. Wait a few minutes, then try again.";
  if (c.includes("invalid-phone-number")) return "That doesn't look like a phone number. Try 0748 227 000.";
  if (c.includes("popup-closed") || c.includes("cancelled-popup")) return "Sign-in was closed before it finished.";
  if (c.includes("popup-blocked")) return "Your browser blocked the sign-in window. Allow pop-ups, or use your phone number.";
  if (c.includes("unauthorized-domain") || c.includes("operation-not-allowed") || c.includes("billing"))
    return "Sign-in isn't switched on for this restaurant yet. Join with your first name for now.";
  if (c.includes("requires-recent-login")) return "For your safety, sign in again, then delete your account.";
  return "Sign-in didn't work. Check your connection and try again.";
}
