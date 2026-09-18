/**
 * Чистка "полуаккаунтов" — тех, кто зарегистрировался, но так и не
 * подтвердил почту.
 *
 * По текущей схеме (см. web/src/pages/Register.jsx, VerifyEmail.jsx,
 * web/src/utils/pendingAccounts.js, firestore.rules -> users/{uid} create)
 * неподтверждённый аккаунт вообще не попадает в базу: документа users/{uid}
 * у него нет. Сам Auth-аккаунт живёт максимум час и удаляется либо кнопкой
 * "Отменить регистрацию", либо при следующей попытке входа.
 *
 * Но клиент удаляет только САМ СЕБЯ: если человек просто закрыл вкладку и
 * больше не вернулся, его Auth-аккаунт остаётся висеть и держит email
 * занятым. Этот скрипт добивает такие остатки — а заодно подчищает старые
 * профили с verified:false, оставшиеся от прежней схемы, когда документ
 * создавался сразу при регистрации.
 *
 * Удаляются только аккаунты, у которых ОДНОВРЕМЕННО:
 *   - emailVerified === false в Firebase Auth,
 *   - нет users/{uid} или в нём verified !== true (аккаунты, подтверждённые
 *     админским ключом, имеют verified:true при emailVerified:false —
 *     их скрипт не трогает),
 *   - с момента создания прошло больше MAX_AGE_HOURS (по умолчанию 1).
 *
 * Обычный способ запуска — вкладка "Actions" на GitHub → workflow
 * "Purge unverified accounts" → "Run workflow".
 *
 * Локальный запуск (нужен scripts/serviceAccountKey.json — см. README):
 *   node scripts/purgeUnverified.js              # только показать (dry-run)
 *   APPLY=1 node scripts/purgeUnverified.js      # реально удалить
 *   APPLY=1 MAX_AGE_HOURS=24 node scripts/purgeUnverified.js
 */

const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");
const serviceAccount = require("./serviceAccountKey.json");

const APPLY = process.env.APPLY === "1" || process.env.APPLY === "true";
const MAX_AGE_HOURS = Number(process.env.MAX_AGE_HOURS || 1);

initializeApp({ credential: cert(serviceAccount) });
const auth = getAuth();
const db = getFirestore();

async function isPendingAccount(user) {
  if (user.emailVerified) return false;

  const createdAt = Date.parse(user.metadata.creationTime);
  const ageHours = (Date.now() - createdAt) / 3600000;
  if (!(ageHours > MAX_AGE_HOURS)) return false;

  const snap = await db.collection("users").doc(user.uid).get();
  // Профиля нет — классический незавершённый аккаунт.
  // Профиль есть, но verified !== true — остаток прежней схемы.
  // Профиль с verified:true — подтверждён админским ключом, не трогаем.
  return !snap.exists || snap.get("verified") !== true;
}

async function main() {
  console.log(
    `Ищем неподтверждённые аккаунты старше ${MAX_AGE_HOURS} ч` +
      (APPLY ? " (режим удаления)" : " (dry-run, ничего не удаляем)")
  );

  const victims = [];
  const liveUids = new Set();
  let pageToken;
  let total = 0;

  do {
    const page = await auth.listUsers(1000, pageToken);
    total += page.users.length;
    for (const user of page.users) {
      liveUids.add(user.uid);
      // eslint-disable-next-line no-await-in-loop
      if (await isPendingAccount(user)) {
        victims.push({ uid: user.uid, email: user.email, created: user.metadata.creationTime });
      }
    }
    pageToken = page.pageToken;
  } while (pageToken);

  // Заодно — "осиротевшие" отметки устройств: их uid уже не существует в
  // Auth (аккаунт удалён самим клиентом из другого браузера, вручную через
  // Console и т.п.). Такая отметка навсегда запрещала бы регистрацию с того
  // браузера, хотя аккаунта, который её поставил, давно нет.
  const claimsSnap = await db.collection("deviceRegistrations").get();
  const orphanClaims = claimsSnap.docs.filter((d) => !liveUids.has(d.get("uid")));

  console.log(`Всего аккаунтов: ${total}, к удалению: ${victims.length}`);
  for (const v of victims) {
    console.log(`  ${v.email || "(без email)"} — создан ${v.created}`);
  }
  console.log(`Осиротевших отметок устройств: ${orphanClaims.length}`);
  for (const d of orphanClaims) {
    console.log(`  deviceRegistrations/${d.id} (uid ${d.get("uid")})`);
  }

  if (!APPLY) {
    console.log("\nDry-run: ничего не удалено. Запустите с APPLY=1, чтобы удалить.");
    return;
  }

  for (const v of victims) {
    // Профиль (если остался от прежней схемы) — вместе с аккаунтом.
    // Тег/чаты у неподтверждённого аккаунта появиться не могли: и то и
    // другое доступно только после verified:true (см. firestore.rules).
    // eslint-disable-next-line no-await-in-loop
    await db.collection("users").doc(v.uid).delete();
    // Отметка "с этого браузера уже создан аккаунт" — иначе она осталась бы
    // висеть с уже несуществующим uid и навсегда заблокировала бы тот
    // браузер для новых регистраций (см. web/src/utils/deviceTrust.js).
    // eslint-disable-next-line no-await-in-loop
    const claims = await db.collection("deviceRegistrations").where("uid", "==", v.uid).get();
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(claims.docs.map((d) => d.ref.delete()));
    // eslint-disable-next-line no-await-in-loop
    await auth.deleteUser(v.uid);
    console.log(`Удалён ${v.email || v.uid}`);
  }

  let claimsRemoved = 0;
  for (const d of orphanClaims) {
    // Перепроверяем прямо перед удалением: список uid собирался во время
    // пагинации listUsers(), и аккаунт, зарегистрированный уже после её
    // начала, мог в него не попасть — такую отметку снимать нельзя.
    // eslint-disable-next-line no-await-in-loop
    const stillGone = await auth
      .getUser(d.get("uid"))
      .then(() => false)
      .catch(() => true);
    if (!stillGone) {
      console.log(`Пропущена отметка ${d.id} — её аккаунт существует`);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await d.ref.delete();
    claimsRemoved++;
    console.log(`Снята отметка устройства ${d.id}`);
  }

  console.log(
    `\nГотово. Удалено аккаунтов: ${victims.length}, снято отметок устройств: ${claimsRemoved}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
