// firebase.js — поднимает Firebase один раз и отдаёт auth и db остальным модулям.
// Всё остальное в проекте импортирует отсюда, а не из CDN напрямую.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth }       from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore }  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { firebaseConfig } from "./config.js";

export const isConfigured = Boolean(firebaseConfig.apiKey);

let auth = null;
let db   = null;

if (isConfigured){
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db   = getFirestore(app);
  auth.languageCode = "ru";   // письма о сбросе пароля приходят на русском
}

export { auth, db };
