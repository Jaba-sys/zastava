// mypeal-auth.js — вход в игру через MyPeal.
//
// ---------------------------------------------------------------------------
// Зачем всё так устроено
//
// Игра и мессенджер — разные сайты. Браузер хранит вход отдельно для каждого
// сайта, поэтому "он же уже вошёл в мессенджер" внутри игры не работает: для
// zastava.web.app это чужая вкладка, её сессию не видно.
//
// Сервера у нас нет (бесплатный план Firebase), а значит некому выдать игре
// подпись "это точно он". Поэтому делаем то же, что делает любой вход "через
// Google" — только вручную и на своей базе:
//
//   1. Игра заводит себе АНОНИМНУЮ сессию Firebase. Это не аккаунт игрока, а
//      просто "эта вкладка этого браузера" — нужна, чтобы вообще иметь право
//      что-то прочитать.
//   2. Игра отправляет человека в мессенджер на страницу /authorize. Там он
//      либо уже вошёл, либо входит/регистрируется обычным путём.
//   3. Мессенджер спрашивает разрешение и, если человек согласился, кладёт в
//      базу ПРОПУСК: authTickets/{случайный id} с его uid, именем и тегом.
//      Ключевое: записать пропуск может только он сам, правило требует
//      uid == request.auth.uid. Подделать чужой пропуск нельзя.
//   4. Мессенджер возвращает человека в игру, передав номер пропуска в адресе.
//   5. Игра предъявляет пропуск: пишет authLinks/{id анонимной сессии} =
//      { uid, ticket }. Правило само читает пропуск и проверяет, что он живой,
//      не потрачен и выписан именно на этот uid. Вот здесь и происходит
//      настоящая проверка личности — на стороне базы, а не на слово клиенту.
//   6. Дальше всё, что игра пишет о человеке (очки, статистика), правила
//      пропускают только если authLinks этой сессии указывает на него.
//
// Это ровно тот же приём, что и пропуск на вступление в группу по ссылке в
// самом мессенджере: правила не умеют принимать параметр, поэтому параметр
// кладётся в базу отдельным документом, и там же проверяется.
//
// Номер пропуска живёт три минуты и сгорает при первом использовании, так что
// подсмотренный адрес из чужой адресной строки уже ничего не даст.
// ---------------------------------------------------------------------------

import { auth, db } from "./firebase.js";
import { MYPEAL_ORIGIN, APP_ID } from "./config.js";
import {
  signInAnonymously, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import {
  doc, getDoc, setDoc, updateDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

const STATE_KEY = "zastava.authState";

/** Дожидается анонимной сессии. Без неё нельзя прочитать даже пропуск. */
export function anonymousSession(){
  return new Promise((resolve, reject) => {
    const stop = onAuthStateChanged(auth, user => {
      if (user){ stop(); resolve(user); }
    }, reject);
    signInAnonymously(auth).catch(reject);
  });
}

/** Случайная строка: и для state, и как запасной генератор. */
function randomToken(){
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Уводит человека в мессенджер за пропуском.
 *
 * state — защита от подлога: случайная строка, которую мы кладём себе в
 * sessionStorage и ждём обратно. Если вернулся не тот state, значит переход
 * затеяли не мы, и пропуск мы не примем.
 */
export function goToMyPeal(){
  const state = randomToken();
  try { sessionStorage.setItem(STATE_KEY, state); } catch { /* приватный режим */ }

  // Возвращаться будем на этот же адрес, но без старых параметров — иначе
  // при втором заходе к нему прицепится второй ticket.
  const back = location.origin + location.pathname;

  const url = new URL("/authorize", MYPEAL_ORIGIN);
  url.searchParams.set("app", APP_ID);
  url.searchParams.set("redirect", back);
  url.searchParams.set("state", state);
  location.href = url.toString();
}

/** Есть ли в адресе пропуск, с которым мы вернулись из мессенджера. */
export function hasReturnTicket(){
  return new URLSearchParams(location.search).has("ticket");
}

/**
 * Предъявляет пропуск и связывает анонимную сессию с аккаунтом MyPeal.
 * Возвращает { uid, name, tag } или бросает ошибку с человеческим текстом.
 */
export async function claimReturnTicket(sessionUid){
  const params = new URLSearchParams(location.search);
  const ticketId = params.get("ticket");
  const state    = params.get("state");

  let expected = null;
  try { expected = sessionStorage.getItem(STATE_KEY); } catch { /* ignore */ }
  // Если sessionStorage недоступен, expected будет null — тогда проверить
  // нечего, и мы не заворачиваем человека только из-за приватного режима.
  if (expected && state !== expected){
    throw new Error("Переход пришёл не с того адреса, с которого начинался. На всякий случай не пускаем — попробуй войти заново.");
  }
  try { sessionStorage.removeItem(STATE_KEY); } catch { /* ignore */ }

  const snap = await getDoc(doc(db, "authTickets", ticketId));
  if (!snap.exists()) throw new Error("Пропуск не найден. Скорее всего он уже сгорел — войди ещё раз.");

  const ticket = snap.data();
  if (ticket.app !== APP_ID) throw new Error("Пропуск выписан для другого приложения.");
  if (ticket.expiresAt?.toMillis() <= Date.now()) throw new Error("Пропуск просрочен. Войди ещё раз, это займёт секунду.");
  if (ticket.usedBy && ticket.usedBy !== sessionUid) throw new Error("Пропуск уже использован. Войди ещё раз.");

  // Сама связка. Правило перечитает пропуск само и не поверит нам на слово.
  await setDoc(doc(db, "authLinks", sessionUid), {
    uid: ticket.uid,
    ticket: ticketId,
    at: serverTimestamp()
  });

  // Гасим пропуск, чтобы второй раз его никто не предъявил. Если не вышло —
  // не страшно, он всё равно сгорит по сроку; ронять из-за этого вход глупо.
  if (!ticket.usedBy){
    updateDoc(doc(db, "authTickets", ticketId), { usedBy: sessionUid }).catch(() => {});
  }

  // Убираем ticket и state из адресной строки: перезагрузка страницы не
  // должна пытаться предъявить уже потраченный пропуск.
  history.replaceState(null, "", location.origin + location.pathname);

  return { uid: ticket.uid, name: ticket.name, tag: ticket.tag };
}

/**
 * Кем эта вкладка уже представилась раньше. Анонимная сессия живёт в браузере
 * долго, поэтому при повторном заходе мессенджер дёргать не нужно.
 */
export async function existingLink(sessionUid){
  const snap = await getDoc(doc(db, "authLinks", sessionUid));
  return snap.exists() ? snap.data().uid : null;
}

/**
 * Полный вход. Возвращает uid игрока в MyPeal или null, если человек ещё не
 * проходил через мессенджер (тогда страница показывает кнопку входа).
 */
export async function resolvePlayer(){
  const session = await anonymousSession();

  if (hasReturnTicket()){
    const claimed = await claimReturnTicket(session.uid);
    return { sessionUid: session.uid, uid: claimed.uid, fresh: claimed };
  }

  const uid = await existingLink(session.uid);
  return { sessionUid: session.uid, uid, fresh: null };
}

/** Выход: рвём связку, анонимную сессию оставляем — она ничего не значит. */
export async function forgetPlayer(sessionUid){
  const { deleteDoc } = await import("https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js");
  await deleteDoc(doc(db, "authLinks", sessionUid)).catch(() => {});
}
