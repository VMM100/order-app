// Looks up a friend's 4-digit table code (invites/{code}) for the QR scanner's code box, so a wrong code
// can be shown right there instead of on a separate page. Loaded only when someone types a code.
import { db } from "./firebase.js";
import { ensureUser } from "./account.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";

// Returns { rid } for a restaurant table, { demo } for a live demo room, or null when no table is open with it.
export async function findInvite(code) {
  await ensureUser();   // invites are readable by any signed-in visitor (a quiet sign-in, no account)
  const d = await getDoc(doc(db, "invites", String(code)));
  return d.exists() ? d.data() : null;
}
