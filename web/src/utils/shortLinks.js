import { collection, deleteDoc, doc, getDoc, getDocs, runTransaction, setDoc } from "firebase/firestore";
import { db } from "../firebase";

// Ссылки-переходники (см. firestore.rules -> shortLinks/{code},
// AdminPanel.jsx -> link create/delete/list, ShortLink.jsx -> маршрут
// /r/{code}). Простой публичный редирект на внешний сайт по короткому коду
// — например, для рекламы или рассылок вне мессенджера, тем же принципом,
// что и ссылка-приглашение в группу (/invite/{chatId}), только ведёт не
// внутрь MyPeal, а наружу. Выпускает и удаляет ТОЛЬКО администратор
// через консоль — никакого самообслуживания, как и у ключей ботов/email.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"; // без похожих друг на друга символов (0/O, 1/l/I)

function randomCode(len = 6) {
  let out = "";
  for (let i = 0; i < len; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

function normalizeUrl(raw) {
  const url = String(raw || "").trim();
  if (!/^https?:\/\/.+/i.test(url)) {
    throw new Error("Ссылка должна начинаться с http:// или https://");
  }
  return url;
}

// Создаёт переходник на url. Если code не задан — генерируется случайный
// (6 символов, ничтожный шанс коллизии, отдельная проверка на
// существование не нужна — create в правилах и так требует, чтобы
// документа ещё не было). Если code задан явно — используется как есть
// (в верхнем регистре), позволяя админу сделать запоминающуюся ссылку.
// maxUses — необязательный лимит "только для нескольких пользователей":
// null/не задан — обычный переходник без ограничений. Если задан (целое
// число 1..100000) — после того как по ссылке перейдёт столько же РАЗНЫХ
// посетителей (см. claimShortLinkUse), она удаляется сама, без участия
// администратора (см. firestore.rules -> shortLinks/{code}).
// showWarning — показывать ли страницу-предупреждение "вы покидаете
// MyPeal" перед переходом (по умолчанию true, как и раньше). false —
// ShortLink.jsx сразу редиректит на url, без единого клика от посетителя.
export async function createShortLink(rawUrl, uid, code, maxUses, showWarning = true) {
  const url = normalizeUrl(rawUrl);
  const finalCode = (code || randomCode()).trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(finalCode)) {
    throw new Error("Код ссылки может содержать только буквы, цифры, _ и - (до 32 символов)");
  }
  let normalizedMaxUses = null;
  if (maxUses !== undefined && maxUses !== null) {
    const n = Number(maxUses);
    if (!Number.isInteger(n) || n <= 0 || n > 100000) {
      throw new Error("Лимит переходов должен быть целым числом от 1 до 100000");
    }
    normalizedMaxUses = n;
  }
  const existing = await getDoc(doc(db, "shortLinks", finalCode));
  if (existing.exists()) {
    throw new Error(`Код "${finalCode}" уже занят — выберите другой`);
  }
  await setDoc(doc(db, "shortLinks", finalCode), {
    url,
    createdAt: new Date(),
    createdBy: uid,
    maxUses: normalizedMaxUses,
    uses: 0,
    showWarning: !!showWarning,
  });
  return finalCode;
}

// Удаляет переходник НАВСЕГДА — без "отзыва", как у ключей ботов/email:
// после удаления документ пропадает, и ShortLink.jsx покажет "ссылка не
// найдена" любому, кто попробует ей воспользоваться.
export async function deleteShortLink(code) {
  await deleteDoc(doc(db, "shortLinks", code));
}

export async function listShortLinks() {
  const snap = await getDocs(collection(db, "shortLinks"));
  return snap.docs
    .map((d) => ({ code: d.id, ...d.data() }))
    .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
}

// Читает один переходник по коду — используется публичной страницей
// ShortLink.jsx (доступна и без входа в аккаунт, см. firestore.rules ->
// shortLinks/{code} allow read: if true).
export async function getShortLink(code) {
  const snap = await getDoc(doc(db, "shortLinks", code));
  return snap.exists() ? { code: snap.id, ...snap.data() } : null;
}

// true, если у переходника задан лимит и он уже исчерпан (столько людей уже
// перешло, сколько было разрешено) — такую ссылку показываем как
// недействительную, даже если сам документ ещё физически не удалился.
export function isShortLinkExhausted(link) {
  return !!link && link.maxUses != null && (link.uses || 0) >= link.maxUses;
}

// Показывать ли страницу-предупреждение перед переходом. Переходники,
// созданные до появления этой настройки, не имеют поля showWarning вовсе —
// для них (как и явно showWarning: true) считаем, что предупреждение
// нужно, чтобы старые ссылки не поменяли поведение задним числом.
export function shortLinkShowsWarning(link) {
  return !link || link.showWarning !== false;
}

// Погашает один слот лимитированного переходника при реальном переходе по
// нему (см. ShortLink.jsx). Для обычных, безлимитных ссылок (maxUses ==
// null) вызывать не нужно — переход происходит напрямую, без записи в базу.
// Атомарно (транзакция) увеличивает uses на 1, только если лимит ещё не
// исчерпан — это и есть единственное, что разрешает соответствующее правило
// в firestore.rules. Если после этого перехода лимит исчерпан (uses стало
// == maxUses) — тут же (по возможности) удаляет документ навсегда: сервера
// с фоновыми задачами тут нет (Spark-план), поэтому "автоудаление" делает
// сам клиент, зашедший последним по разрешённой квоте.
// Возвращает { ok: true } при успешном переходе или { ok: false } если
// ссылка уже не существует / лимит уже был исчерпан кем-то ещё раньше.
export async function claimShortLinkUse(code) {
  const ref = doc(db, "shortLinks", code);
  const outcome = await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return { ok: false };
    const data = snap.data();
    if (data.maxUses == null) return { ok: true };
    const uses = data.uses || 0;
    if (uses >= data.maxUses) return { ok: false };
    const nextUses = uses + 1;
    tx.update(ref, { uses: nextUses });
    return { ok: true, exhausted: nextUses >= data.maxUses };
  });
  if (outcome.exhausted) {
    // подчистка навсегда — не блокирует сам переход, если вдруг не выйдет
    // (например, пропала сеть): в следующий раз документ подчистит уже
    // следующий посетитель, а до тех пор isShortLinkExhausted() всё равно
    // покажет ссылку как недействительную.
    deleteDoc(ref).catch(() => {});
  }
  return outcome;
}
