import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { initializeFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// ---------------------------------------------------------------------------
// Транспорт Firestore.
//
// По умолчанию подписки идут через WebChannel — один постоянно открытый поток.
// Это самый быстрый вариант: обновление прилетает сразу, и от него напрямую
// зависят и доставка сообщений, и звонки (весь обмен offer/answer/ICE идёт
// через те же подписки — если они тормозят, собеседник не успевает ответить
// до таймаута дозвона).
//
// Есть устройства и сети, где этот поток молча не поднимается: тогда
// приложение выглядит рабочим, но новые сообщения не приходят, а свои висят в
// локальной очереди и до собеседника не доходят. У нас это воспроизвелось на
// iPhone (Safari/iOS). Лечится переключением на long-polling — он работает
// везде, но каждое обновление стоит отдельного запроса, поэтому заметно
// медленнее.
//
// Поэтому включаем автоопределение ТОЛЬКО там, где проблема реально есть —
// на iOS. Раньше оно стояло для всех, и из-за этого на обычных устройствах
// появилась задержка и у сообщений, и у звонков ("нажал ответить, висит
// 'Соединяем…' и сбрасывается по таймауту"). На всех остальных платформах
// остаётся быстрый поток по умолчанию.
// ---------------------------------------------------------------------------
function isAppleMobile() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS с 13-й версии по умолчанию представляется настольным Safari на Mac —
  // отличить можно только по наличию сенсорного ввода.
  return /Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1;
}

export const db = isAppleMobile()
  ? initializeFirestore(app, { experimentalAutoDetectLongPolling: true })
  : initializeFirestore(app, {});
