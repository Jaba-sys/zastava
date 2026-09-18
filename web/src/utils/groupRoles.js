// ---------------------------------------------------------------------------
// Роли в группе: владелец → администраторы → участники.
//
// Владелец один (chat.ownerId) и меняться не может. Администраторов он
// назначает сам (chat.admins), и он же решает, что именно им позволено
// (chat.adminRights) — поэтому «администратор» здесь не фиксированный набор
// прав, а роль с настраиваемым объёмом: в одной группе это просто помощник со
// ссылками, в другой — почти второй владелец.
//
// Ровно те же проверки продублированы в firestore.rules (isGroupAdmin,
// adminRight): здесь они нужны, чтобы прятать кнопки, там — чтобы запись
// действительно не прошла. Клиентская проверка без правила защитой не
// является.
// ---------------------------------------------------------------------------

// Ключи прав и значения по умолчанию — если поля adminRights в чате нет
// (старые группы, созданные до этой функции), действуют они.
export const ADMIN_RIGHTS = {
  // Создавать и отзывать ссылки-приглашения.
  links: true,
  // Добавлять участников напрямую по тегу (только своих друзей — это
  // отдельное ограничение, см. ChatWindow.jsx).
  invite: true,
  // Начинать групповые звонки и звать в них людей.
  calls: true,
  // Удалять участников из группы.
  remove: false,
  // Переименовывать группу.
  rename: false,
};

export const ADMIN_RIGHT_KEYS = Object.keys(ADMIN_RIGHTS);

/** Владелец группы. */
export function isGroupOwner(chat, uid) {
  return !!chat && !!uid && chat.ownerId === uid;
}

/** Назначенный администратор (владелец сюда НЕ входит — см. canInGroup). */
export function isGroupAdmin(chat, uid) {
  if (!chat || !uid) return false;
  return Array.isArray(chat.admins) && chat.admins.includes(uid);
}

/** Значение конкретного права администраторов в этой группе. */
export function adminRight(chat, key) {
  const rights = chat?.adminRights;
  if (rights && typeof rights[key] === "boolean") return rights[key];
  return ADMIN_RIGHTS[key] ?? false;
}

/**
 * Главная проверка: может ли человек сделать в этой группе то-то.
 * Владельцу можно всё и всегда, администратору — то, что разрешил владелец.
 */
export function canInGroup(chat, uid, right) {
  if (!chat || !uid) return false;
  if (!Array.isArray(chat.members) || !chat.members.includes(uid)) return false;
  if (isGroupOwner(chat, uid)) return true;
  if (!isGroupAdmin(chat, uid)) return false;
  return adminRight(chat, right);
}

/** Полный набор прав администраторов группы, с подставленными умолчаниями. */
export function groupAdminRights(chat) {
  const out = {};
  for (const key of ADMIN_RIGHT_KEYS) out[key] = adminRight(chat, key);
  return out;
}
