import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import { db } from "../firebase";

// ---------------------------------------------------------------------------
// Полное удаление группы — для владельца группы (ChatWindow.jsx -> экран
// управления) и для администратора (AdminPanel.jsx -> команда group-delete).
//
// В отличие от "удалить чат у себя" (hiddenFor/clearedFor, см. firestore.rules)
// это удаление НАСОВСЕМ и для всех: сообщений больше нет ни у кого, группа
// исчезает из списка у всех участников.
//
// Firestore не удаляет подколлекции вместе с документом: удалив только
// chats/{id}, мы оставили бы все сообщения висеть в базе — они перестали бы
// быть доступны (правила читают чат, которого уже нет), но продолжали бы
// занимать место и жрать квоту. Бэкенда, который прибрал бы их потом, у
// проекта нет (весь расчёт на клиент + правила), поэтому чистим здесь же и
// строго в таком порядке: сначала сообщения, потом сам чат. Если процесс
// оборвётся посередине — чат ещё на месте, и удаление можно просто повторить.
// ---------------------------------------------------------------------------

// Firestore разрешает не больше 500 операций в одном батче; берём с запасом.
const BATCH_SIZE = 400;
// Предохранитель от бесконечного цикла, если удаление вдруг перестанет
// уменьшать коллекцию (нет прав — вернётся та же страница снова и снова).
const MAX_ROUNDS = 200;

/**
 * Удаляет сообщения чата пачками. Возвращает, сколько удалено.
 * onProgress вызывается после каждой пачки — чтобы показывать счётчик на
 * больших группах, где это занимает заметное время.
 */
export async function deleteChatMessages(chatId, onProgress) {
  let deleted = 0;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const snap = await getDocs(
      query(collection(db, "chats", chatId, "messages"), limit(BATCH_SIZE))
    );
    if (snap.empty) break;
    const batch = writeBatch(db);
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    deleted += snap.size;
    onProgress?.(deleted);
    // Страница пришла неполной — значит это была последняя.
    if (snap.size < BATCH_SIZE) break;
  }
  return deleted;
}

/**
 * Гасит незавершённые звонки этой группы. Делается ДО удаления самого чата:
 * правила звонков читают документ группы, и после её удаления закрыть звонок
 * не смог бы уже никто — комната осталась бы "живой" навсегда.
 */
async function endLiveGroupCalls(chatId) {
  try {
    const snap = await getDocs(
      query(
        collection(db, "groupCalls"),
        where("chatId", "==", chatId),
        where("status", "==", "live")
      )
    );
    await Promise.all(
      snap.docs.map((d) =>
        updateDoc(d.ref, {
          participants: [],
          invited: [],
          status: "ended",
          updatedAt: serverTimestamp(),
        }).catch(() => {})
      )
    );
  } catch {
    /* нет индекса/прав — не повод срывать удаление самой группы */
  }
}

/**
 * Удаляет группу целиком: звонки -> сообщения -> сам чат.
 * Бросает исключение, если чат не найден или это не группа.
 */
export async function deleteGroupChat(chatId, onProgress) {
  const snap = await getDoc(doc(db, "chats", chatId));
  if (!snap.exists()) throw new Error("not-found");
  if (!snap.data().isGroup) throw new Error("not-a-group");

  await endLiveGroupCalls(chatId);
  const deleted = await deleteChatMessages(chatId, onProgress);
  await deleteDoc(doc(db, "chats", chatId));
  return { name: snap.data().name || chatId, messages: deleted };
}
