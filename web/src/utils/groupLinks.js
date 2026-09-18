import {
  Timestamp,
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import { db } from "../firebase";

// ---------------------------------------------------------------------------
// Ссылки-приглашения в группу.
//
// Раньше ссылка была просто адресом /invite/{id группы}: вечная, работала у
// кого угодно и отозвать её было нельзя — кто угодно, кому она однажды
// попалась, мог зайти в группу спустя месяцы. Теперь ссылка — отдельный
// документ groupInviteLinks/{linkId} со сроком жизни, возможным адресатом и
// признаком отзыва, а адрес выглядит как /join/{linkId}.
//
// Вступление идёт в ДВА шага, и это не усложнение ради усложнения: правила
// Firestore не умеют принимать "параметр" при обновлении документа, поэтому
// проверить ссылку прямо в правиле на chats/{id} невозможно — оно не знает,
// какую именно ссылку предъявил человек. Поэтому сначала пишется "пропуск"
// chats/{chatId}/joinPasses/{uid} с номером ссылки (вот его правило ссылку и
// проверяет), и только потом — добавление себя в участники, которое требует
// наличия этого пропуска. См. firestore.rules.
// ---------------------------------------------------------------------------

// Варианты срока жизни ссылки. null — бессрочная.
export const LINK_DURATIONS = [
  { key: "30m", minutes: 30 },
  { key: "1h", minutes: 60 },
  { key: "1d", minutes: 60 * 24 },
  { key: "1w", minutes: 60 * 24 * 7 },
  { key: "1mo", minutes: 60 * 24 * 30 },
  { key: "forever", minutes: null },
];

export function expiryFromKey(key) {
  const found = LINK_DURATIONS.find((d) => d.key === key);
  if (!found || found.minutes == null) return null;
  return Timestamp.fromMillis(Date.now() + found.minutes * 60 * 1000);
}

export function linkUrl(linkId) {
  return `${window.location.origin}/join/${linkId}`;
}

/** Ссылка ещё действует? Используется и для показа, и перед вступлением. */
export function isLinkActive(link, uid) {
  if (!link) return false;
  if (link.revoked) return false;
  if (link.expiresAt && link.expiresAt.toMillis() <= Date.now()) return false;
  if (link.forUid && uid && link.forUid !== uid) return false;
  return true;
}

/** Почему ссылка не подошла — чтобы показать человеку внятную причину. */
export function linkProblem(link, uid) {
  if (!link) return "missing";
  if (link.revoked) return "revoked";
  if (link.expiresAt && link.expiresAt.toMillis() <= Date.now()) return "expired";
  if (link.forUid && uid && link.forUid !== uid) return "wrongUser";
  return null;
}

export async function createInviteLink(chatId, uid, { durationKey, forUid }) {
  const ref = await addDoc(collection(db, "groupInviteLinks"), {
    chatId,
    createdBy: uid,
    createdAt: serverTimestamp(),
    expiresAt: expiryFromKey(durationKey),
    forUid: forUid || null,
    revoked: false,
  });
  return ref.id;
}

export async function revokeInviteLink(linkId) {
  await updateDoc(doc(db, "groupInviteLinks", linkId), { revoked: true });
}

/**
 * Ссылки одной группы, новые сверху.
 *
 * Сортировка СПЕЦИАЛЬНО сделана на клиенте, а не через orderBy: запрос
 * "where chatId + orderBy createdAt" потребовал бы составного индекса, а его
 * пришлось бы отдельно выкатывать в проект — забытый индекс превратился бы в
 * пустой список со странной ошибкой в консоли. Ссылок у группы единицы,
 * сортировать их в памяти ничего не стоит.
 */
export async function listInviteLinks(chatId) {
  const snap = await getDocs(
    query(collection(db, "groupInviteLinks"), where("chatId", "==", chatId))
  );
  const links = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  links.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
  return links;
}

export async function getInviteLink(linkId) {
  const snap = await getDoc(doc(db, "groupInviteLinks", linkId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

/**
 * Пропуск в группу. Пишется ПЕРЕД добавлением себя в участники — именно его
 * правило и проверяет саму ссылку (срок, отзыв, адресата). via:
 *   "link"   — обычная ссылка-приглашение, ref = id ссылки;
 *   "invite" — принятое приглашение по тегу, ref = id документа groupInvites.
 */
export async function writeJoinPass(chatId, uid, via, ref) {
  await setDoc(doc(db, "chats", chatId, "joinPasses", uid), {
    via,
    ref,
    at: serverTimestamp(),
  });
}
