// Firebase connection. This config is meant to be public; access is controlled by Firestore security rules.
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyA1AC8HPl9IZxf9tlb3fjoLB_mpCSx8L3g",
  authDomain: "order-app-47367.firebaseapp.com",
  projectId: "order-app-47367",
  storageBucket: "order-app-47367.firebasestorage.app",
  messagingSenderId: "151565820125",
  appId: "1:151565820125:web:4dc266a4bb5fa6ae793b34"
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
