/**
 * Создаёт первый аккаунт администратора MyPeal.
 *
 * Использование:
 *   1. Скачайте service account key: Firebase Console → Project settings →
 *      Service accounts → Generate new private key → сохраните как
 *      scripts/serviceAccountKey.json (этот файл в .gitignore, никогда не коммитьте).
 *   2. Задайте email и пароль через переменные окружения (чтобы не хранить их в коде):
 *        ADMIN_EMAIL='you@example.com' ADMIN_PASSWORD='...' node scripts/seedAdmin.js
 */

const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const serviceAccount = require("./serviceAccountKey.json");

const ADMIN_TAG = process.env.ADMIN_TAG || "admin";
const ADMIN_NAME = process.env.ADMIN_NAME || "Владелец";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD;

if (!ADMIN_EMAIL || !password) {
  console.error(
    "Задайте ADMIN_EMAIL и ADMIN_PASSWORD через переменные окружения, например:\n" +
      "  ADMIN_EMAIL='you@example.com' ADMIN_PASSWORD='...' node scripts/seedAdmin.js"
  );
  process.exit(1);
}

initializeApp({ credential: cert(serviceAccount) });
const auth = getAuth();
const db = getFirestore();

async function main() {
  let user;
  try {
    user = await auth.getUserByEmail(ADMIN_EMAIL);
    console.log("Пользователь уже существует, обновляю пароль...");
    await auth.updateUser(user.uid, { password });
  } catch (e) {
    user = await auth.createUser({
      email: ADMIN_EMAIL,
      password,
      emailVerified: true,
    });
    console.log("Создан новый пользователь:", user.uid);
  }

  const now = Timestamp.now();

  await db.collection("users").doc(user.uid).set(
    {
      email: ADMIN_EMAIL,
      name: ADMIN_NAME,
      bio: null,
      birthdate: null,
      tag: ADMIN_TAG,
      verified: true,
      isAdmin: true,
      banned: false,
      profileComplete: true,
      createdAt: now,
    },
    { merge: true }
  );

  await db.collection("tags").doc(ADMIN_TAG).set({ uid: user.uid, createdAt: now });

  console.log(`Готово. Админ-аккаунт: ${ADMIN_EMAIL} / тег @${ADMIN_TAG}`);
}

main().then(() => process.exit(0));
