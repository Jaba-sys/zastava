/**
 * Полностью удаляет аккaунт MyPeal:
 *   - сам аккаунт в Firebase Auth (логин по этому email больше не работает)
 *   - документ users/{uid} в Firestore
 *   - его тег в tags/{tag} (освобождается для повторного использования)
 *   - отметки deviceRegistrations (браузер снова свободен для регистрации)
 *   - все его заявки в друзья (отправленные и полученные)
 *   - все чаты, в которых он состоял, вместе со всеми сообщениями в них
 *
 * Из соображений безопасности скрипт отказывается удалять аккаунт с
 * правами администратора (isAdmin: true) — админа нужно сначала лишить
 * прав вручную через Firebase Console, если это осознанное решение.
 *
 * Обычный способ запуска — вкладка "Actions" на GitHub → workflow
 * "Delete user account" → "Run workflow" → ввести email.
 *
 * Локальный запуск (нужен scripts/serviceAccountKey.json — см. README):
 *   TARGET_EMAIL='user@example.com' node scripts/deleteAccount.js
 */

const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");
const serviceAccount = require("./serviceAccountKey.json");

const TARGET_EMAIL = process.env.TARGET_EMAIL;

if (!TARGET_EMAIL) {
  console.error(
    "Задайте TARGET_EMAIL через переменную окружения, например:\n" +
      "  TARGET_EMAIL='user@example.com' node scripts/deleteAccount.js"
  );
  process.exit(1);
}

initializeApp({ credential: cert(serviceAccount) });
const auth = getAuth();
const db = getFirestore();

async function deleteChatAndMessages(chatId) {
  const messagesSnap = await db.collection("chats").doc(chatId).collection("messages").get();

  const BATCH_SIZE = 400;
  let batch = db.batch();
  let count = 0;
  for (const doc of messagesSnap.docs) {
    batch.delete(doc.ref);
    count++;
    if (count === BATCH_SIZE) {
      await batch.commit();
      batch = db.batch();
      count = 0;
    }
  }
  if (count > 0) await batch.commit();

  await db.collection("chats").doc(chatId).delete();
}

async function main() {
  let user;
  try {
    user = await auth.getUserByEmail(TARGET_EMAIL);
  } catch (e) {
    console.error(`Пользователь с email ${TARGET_EMAIL} не найден в Firebase Auth.`);
    process.exit(1);
  }

  const uid = user.uid;
  console.log(`Найден пользователь: uid=${uid}`);

  const userDoc = await db.collection("users").doc(uid).get();
  const userData = userDoc.exists ? userDoc.data() : null;

  if (userData?.isAdmin) {
    console.error(
      "Отказ: этот аккаунт имеет права администратора (isAdmin: true).\n" +
        "Скрипт не удаляет админ-аккаунты автоматически — сначала снимите права\n" +
        "вручную через Firebase Console (Firestore → users → этот документ), если\n" +
        "это осознанное решение, и запустите скрипт ещё раз."
    );
    process.exit(1);
  }

  if (userData?.tag) {
    await db.collection("tags").doc(userData.tag).delete();
    console.log(`Тег @${userData.tag} освобождён.`);
  }

  const [sentReq, receivedReq] = await Promise.all([
    db.collection("friendRequests").where("from", "==", uid).get(),
    db.collection("friendRequests").where("to", "==", uid).get(),
  ]);
  for (const doc of [...sentReq.docs, ...receivedReq.docs]) {
    await doc.ref.delete();
  }
  console.log(`Удалено заявок в друзья: ${sentReq.size + receivedReq.size}`);

  const chatsSnap = await db.collection("chats").where("members", "array-contains", uid).get();
  for (const chatDoc of chatsSnap.docs) {
    await deleteChatAndMessages(chatDoc.id);
  }
  console.log(`Удалено чатов (вместе с сообщениями): ${chatsSnap.size}`);

  // Анти-абьюзная отметка "на этом браузере уже есть аккаунт". Её надо снять
  // обязательно: иначе браузер удалённого пользователя остаётся навсегда
  // занятым его несуществующим uid, и зарегистрироваться там заново не выйдет
  // (см. firestore.rules -> deviceRegistrations). Отметок может быть
  // несколько — по одной на каждое устройство, где человек заходил.
  const devicesSnap = await db
    .collection("deviceRegistrations")
    .where("uid", "==", uid)
    .get();
  for (const deviceDoc of devicesSnap.docs) {
    await deviceDoc.ref.delete();
  }
  console.log(`Снято отметок "аккаунт на устройстве": ${devicesSnap.size}`);

  if (userDoc.exists) {
    await db.collection("users").doc(uid).delete();
  }

  await auth.deleteUser(uid);

  console.log(`Готово. Аккаунт ${TARGET_EMAIL} (uid ${uid}) полностью удалён.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
