// The company running Wasabi: shown to restaurants for sign-up, renewals and support.
export const COMPANY = {
  name: "Wasabi",
  contact: "Vandan Mamlani",
  phone: "0748 227 000",
  email: "vandanmamlani@gmail.com",
  monthly: 130000,   // TSh per month
  yearly: 1300000,   // TSh per year
  graceDays: 7,      // days after the paid-until date before a restaurant stops (must match firestore.rules)
};

// Pilot mode (19 Nov 2026): until the business name (BRELA) and PDPC registration are done, Wasabi
// collects as little personal data as possible and takes no public sign-ups. Switch each back to true
// after registration; nothing else needs changing (the code and database rules stay in place).
// - dinerAccounts: diners sign in (Google or phone), My account, saved visits, "Offers for you" and the
//   WhatsApp number. Off: diners order with a first name only; Sign in is for restaurants and Wasabi.
// - phoneSignIn: signing in with a phone number (SMS) anywhere. Off: Google only.
// - publicSignup: the "Register your restaurant" page. Off: restaurants are added from the company page.
export const OPEN = { dinerAccounts: false, phoneSignIn: false, publicSignup: false };
export const WA_TALK = "https://wa.me/255748227000?text=Hi%2C%20I%27d%20like%20to%20hear%20about%20Wasabi%20for%20my%20place";
