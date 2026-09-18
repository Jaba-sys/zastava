import { deleteUser } from "firebase/auth";
import { releaseDeviceClaim } from "./deviceTrust";

// ---------------------------------------------------------------------------
// "Незавершённая" регистрация — аккаунт, который создан в Firebase Auth, но
// так и не подтвердил почту.
//
// Правило проекта: пока почта не подтверждена, аккаунта как бы НЕТ —
// профиль users/{uid} не создаётся вообще (см. Register.jsx, VerifyEmail.jsx
// и firestore.rules -> users/{uid} create), поэтому такой человек не виден в
// поиске, не может писать, не занимает место в базе и не попадает в админку.
//
// Сам Auth-аккаунт при этом какое-то время всё же существует (иначе ссылка
// из письма было бы некому подтверждать) и держит email занятым. Чтобы он не
// висел вечно, его удаляем:
//   1. сразу — если человек сам ушёл с экрана подтверждения ("Выйти", см.
//      VerifyEmail.jsx);
//   2. при следующей попытке входа — если почта всё ещё не подтверждена, а
//      с момента создания прошло больше UNVERIFIED_GRACE_MS (см. Login.jsx).
// После удаления email снова свободен для регистрации.
//
// Cloud Functions не используются (бесплатный Spark-план), поэтому удаление
// делает сам клиент — deleteUser() работает только для СВОЕГО аккаунта и
// только вскоре после входа, чего в обоих сценариях выше достаточно.
// ---------------------------------------------------------------------------

// Сколько живёт неподтверждённый аккаунт, прежде чем его удалят при
// следующей попытке входа.
export const UNVERIFIED_GRACE_MS = 60 * 60 * 1000; // 1 час

export function accountAgeMs(user) {
  const created = user?.metadata?.creationTime;
  if (!created) return 0;
  const ts = Date.parse(created);
  if (Number.isNaN(ts)) return 0;
  return Date.now() - ts;
}

export function isExpiredUnverified(user) {
  return !user?.emailVerified && accountAgeMs(user) > UNVERIFIED_GRACE_MS;
}

// Удаляет неподтверждённый аккаунт. Возвращает true, если аккаунт
// действительно удалён (email освободился). false — если Firebase не дал
// удалить (например auth/requires-recent-login): тогда вызывающий код просто
// выходит из аккаунта, а удаление случится при следующем входе.
export async function deleteUnverifiedAccount(user) {
  if (!user || user.emailVerified) return false;
  // Сначала снимаем отметку "с этого браузера уже создан аккаунт", если она
  // была поставлена этим же аккаунтом (см. deviceTrust.js) — иначе брошенная
  // регистрация навсегда заблокировала бы браузер для новых аккаунтов.
  await releaseDeviceClaim(user.uid);
  try {
    await deleteUser(user);
    return true;
  } catch {
    return false;
  }
}
