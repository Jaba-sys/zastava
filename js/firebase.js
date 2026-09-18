// firebase.js — поднимает Firebase один раз и отдаёт остальным модулям.
// Всё в проекте импортирует отсюда, а не из CDN напрямую: так версия SDK
// задана в одном месте и не разъедется между файлами.

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getAuth }       from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import { getFirestore }  from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { getDatabase }   from "https://www.gstatic.com/firebasejs/12.18.0/firebase-database.js";

import { firebaseConfig } from "./config.js";

export const isConfigured = Boolean(firebaseConfig.apiKey);
// Отдельный признак: ключи вписаны, а вот Realtime Database ещё не создана.
// Разделено сознательно — на входе и в лобби это разные беды с разными
// подсказками, а сваленные в одну "что-то не настроено" они бесполезны.
export const hasRealtimeDb = Boolean(firebaseConfig.databaseURL);

let auth = null;
let db   = null;
let rtdb = null;

if (isConfigured){
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db   = getFirestore(app);
  auth.languageCode = "ru";
  if (hasRealtimeDb) rtdb = getDatabase(app);
}

export { auth, db, rtdb };
