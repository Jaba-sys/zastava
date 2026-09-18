import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { collection, doc, getDoc, getDocs, limit, orderBy, query, updateDoc } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../contexts/AuthContext";
import { sendSystemNotification } from "../utils/systemChat";
import { deductStars, grantStars, setStarsBlocked } from "../utils/stars";
import { adminDeleteGift } from "../utils/gifts";
import { ITEM_CATALOG, findCatalogItem, isItemOwned, grantCatalogItem, revokeCatalogItem } from "../utils/adminGrants";
import { createBotKey, listBotKeys, reactivateBotKey, revokeBotKey } from "../utils/botKeys";
import { createEmailKey, listEmailKeys, reactivateEmailKey, revokeEmailKey } from "../utils/emailKeys";
import { createShortLink, deleteShortLink, listShortLinks } from "../utils/shortLinks";
import { deleteGroupChat } from "../utils/groupDelete";
import { useLanguage } from "../i18n/LanguageContext";

// Админ-панель как консоль (см. обсуждение с пользователем — раньше здесь
// были обычные вкладки/кнопки, теперь ВЕСЬ функционал доступен только
// командами, набранными в терминале, как в консоли Windows). Логика команд
// — прямые переиспользования тех же функций, что раньше вызывали кнопки
// старой панели (grantStars/deductStars/setStarsBlocked из utils/stars.js,
// adminDeleteGift из utils/gifts.js, обычные updateDoc для бана/бейджей) —
// изменился только интерфейс, не бизнес-логика и не правила Firestore.
//
// Тексты самих команд и их вывода сознательно НЕ прогоняются через t() (в
// отличие от статичной "рамки" — шапки, подсказки, кнопки): это внутренний
// инструмент для одного администратора, тот же подход уже используется в
// проекте для системных уведомлений (см. web/src/utils/stars.js — тексты
// вроде "Администрация начислила вам N звёзд" тоже зашиты по-русски).
const HELP_LINES = [
  "help                                       — список команд",
  "users [запрос]                             — список/поиск пользователей (тег, имя, email)",
  "user <tag|id>                              — подробная карточка пользователя",
  "chats [запрос]                             — список/поиск чатов",
  "chat <id>                                  — открыть чат, показать последние сообщения",
  "ban <tag|id> [until=ГГГГ-ММ-ДД] [причина]  — забанить пользователя (без until — навсегда)",
  "unban <tag|id>                             — разбанить пользователя",
  "account delete <tag|id|email>              — забанить + инструкция по полному удалению через GitHub Actions",
  "verify <tag|id>                            — вкл/выкл бейдж «подтверждён» у пользователя",
  "verifygroup <id чата>                      — вкл/выкл бейдж «подтверждён» у группы",
  "group-delete <id чата> --yes               — удалить группу и всю её переписку НАВСЕГДА (у всех участников)",
  "gifts <tag|id>                             — подарки пользователя",
  "gift-delete <tag|id> <instanceId>          — удалить подарок пользователя",
  "item list [фильтр]                         — список выдаваемых предметов магазина (ключ — название)",
  "item grant <tag|id> <ключ>                 — выдать предмет бесплатно (не покупка — видно в магазине)",
  "item revoke <tag|id> <ключ>                — забрать выданный ИЛИ купленный предмет",
  "stars grant <tag|id> <кол-во>              — начислить звёзды",
  "stars deduct <tag|id> <кол-во>             — списать звёзды",
  "stars block <tag|id>                       — заблокировать начисление звёзд",
  "stars unblock <tag|id>                     — разблокировать начисление звёзд",
  "announce [--pin] <текст>                   — разослать объявление всем пользователям",
  "botkey create <botId|@тег бота>            — выпустить ключ для пользовательского бота",
  "botkey revoke <code>                       — отозвать ключ (привилегия сразу отключается)",
  "botkey reactivate <code>                   — снова включить ранее отозванный ключ",
  "botkey list [botId|@тег бота]              — список ключей (все или только этого бота)",
  "emailkey create <email>                    — выпустить ключ обхода письма при регистрации",
  "emailkey revoke <code>                     — отозвать ключ",
  "emailkey reactivate <code>                 — снова включить ранее отозванный ключ",
  "emailkey list [email]                      — список ключей (все или только этого email)",
  "link create <url> [код|-] [лимит|-|0] [0|1] — создать переходник (лимит — только для N переходов; 0|1 — показывать предупреждение перед переходом, по умолчанию 1)",
  "link delete <код>                          — удалить переходник НАВСЕГДА",
  "link list                                  — список всех переходников",
  "clear                                      — очистить экран",
  "exit                                       — вернуться в мессенджер",
];

function fmtUser(u) {
  const flags = [u.banned && "BAN", u.isAdmin && "ADMIN", u.verifiedBadge && "✓", u.starsBlocked && "★blocked"]
    .filter(Boolean)
    .join(" ");
  return `@${u.tag || "-"}  ${u.name || "(без имени)"}  ${u.email || "-"}  ⭐${u.stars || 0}${flags ? "  [" + flags + "]" : ""}`;
}

export default function AdminPanel() {
  const { user, profile, signOut } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();

  const [lines, setLines] = useState([]);
  const [inputValue, setInputValue] = useState("");
  const [busy, setBusy] = useState(false);
  const historyRef = useRef([]);
  const historyIndexRef = useRef(null);
  const outputRef = useRef(null);
  const inputRef = useRef(null);
  const lineSeqRef = useRef(0);

  function print(text, kind = "output") {
    lineSeqRef.current += 1;
    setLines((prev) => [...prev, { id: lineSeqRef.current, kind, text }]);
  }

  useEffect(() => {
    print("MyPeal Console v1.0");
    print(`Добро пожаловать, ${profile?.name || "администратор"} (@${profile?.tag || "?"}).`);
    print('Введите "help" для списка команд.');
    inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [lines]);

  // --- Помощники поиска ---------------------------------------------------
  async function fetchUsers() {
    const snap = await getDocs(collection(db, "users"));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  function resolveUser(users, raw) {
    if (!raw) return null;
    const q = raw.trim().replace(/^@/, "").toLowerCase();
    return (
      users.find((u) => (u.tag || "").toLowerCase() === q) ||
      users.find((u) => u.id === raw.trim()) ||
      users.find((u) => (u.email || "").toLowerCase() === q) ||
      null
    );
  }

  // --- Команды --------------------------------------------------------------
  function showHelp() {
    print(HELP_LINES.join("\n"));
  }

  async function listUsers(q) {
    const users = await fetchUsers();
    const query_ = (q || "").trim().toLowerCase().replace(/^@/, "");
    const filtered = query_
      ? users.filter(
          (u) =>
            (u.tag || "").toLowerCase().includes(query_) ||
            (u.name || "").toLowerCase().includes(query_) ||
            (u.email || "").toLowerCase().includes(query_)
        )
      : users;
    if (!filtered.length) {
      print("Пользователи не найдены.", "info");
      return;
    }
    print(`Найдено: ${filtered.length}\n` + filtered.map(fmtUser).join("\n"));
  }

  async function showUser(target) {
    if (!target) {
      print("Использование: user <tag|id>", "error");
      return;
    }
    const users = await fetchUsers();
    const u = resolveUser(users, target);
    if (!u) {
      print(`Пользователь не найден: ${target}`, "error");
      return;
    }
    const rows = [
      `id: ${u.id}`,
      `тег: @${u.tag || "-"}`,
      `имя: ${u.name || "-"}`,
      `email: ${u.email || "-"}`,
      `звёзды: ${u.stars || 0}`,
      `подтверждён: ${u.verifiedBadge ? "да" : "нет"}`,
      `админ: ${u.isAdmin ? "да" : "нет"}`,
      `звёзды заблокированы: ${u.starsBlocked ? "да" : "нет"}`,
      `видео в звонках: ${u.videoCallUnlocked ? "куплено" : "нет"}`,
      `забанен: ${
        u.banned ? `да (${u.banReason || "без причины"}, ${u.bannedUntil ? "до " + u.bannedUntil : "навсегда"})` : "нет"
      }`,
      `подарков: ${(u.ownedGifts || []).length}`,
      `выдано администрацией: ${Object.keys(u.grantedItems || {}).length ? Object.keys(u.grantedItems || {}).join(", ") : "нет"}`,
    ];
    print(rows.join("\n"));
  }

  async function listChats(q) {
    const [chatsSnap, users] = await Promise.all([getDocs(collection(db, "chats")), fetchUsers()]);
    const usersById = Object.fromEntries(users.map((u) => [u.id, u]));
    function title(c) {
      if (c.isGroup) return `👥 ${c.name || "Группа"} (${c.members?.length || 0})`;
      return (c.members || []).map((uid) => usersById[uid]?.name || usersById[uid]?.tag || uid).join(" ↔ ");
    }
    let chats = chatsSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.updatedAt?.toMillis?.() || 0) - (a.updatedAt?.toMillis?.() || 0))
      .map((c) => ({ ...c, _title: title(c) }));
    const query_ = (q || "").trim().toLowerCase();
    if (query_) {
      chats = chats.filter((c) => c._title.toLowerCase().includes(query_) || c.id.toLowerCase().includes(query_));
    }
    if (!chats.length) {
      print("Чаты не найдены.", "info");
      return;
    }
    print(
      `Найдено: ${chats.length}\n` +
        chats.map((c) => `${c.id}  ${c._title}${c.isGroup && c.verifiedBadge ? " [✓]" : ""}`).join("\n")
    );
  }

  async function showChat(chatId) {
    if (!chatId) {
      print("Использование: chat <id>", "error");
      return;
    }
    const chatSnap = await getDoc(doc(db, "chats", chatId));
    if (!chatSnap.exists()) {
      print(`Чат не найден: ${chatId}`, "error");
      return;
    }
    const [msgsSnap, users] = await Promise.all([
      getDocs(query(collection(db, "chats", chatId, "messages"), orderBy("createdAt", "asc"), limit(50))),
      fetchUsers(),
    ]);
    const usersById = Object.fromEntries(users.map((u) => [u.id, u]));
    const msgs = msgsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (!msgs.length) {
      print("Сообщений нет.", "info");
      return;
    }
    const rows = msgs.map((m) => {
      const sender = usersById[m.senderId]?.name || m.senderId;
      const body = m.audio
        ? "[голосовое сообщение]"
        : m.fileMeta
          ? `[файл: ${m.fileMeta.name}]`
          : m.text || `[${m.type || "событие"}]`;
      return `${sender}: ${body}`;
    });
    print(`Последние сообщения (${msgs.length}):\n` + rows.join("\n"));
  }

  async function banUser(args) {
    const target = args[0];
    if (!target) {
      print("Использование: ban <tag|id> [until=ГГГГ-ММ-ДД] [причина]", "error");
      return;
    }
    let rest = args.slice(1);
    let until = null;
    if (rest[0] && /^until=\d{4}-\d{2}-\d{2}$/.test(rest[0])) {
      until = rest[0].slice("until=".length);
      rest = rest.slice(1);
    }
    const reason = rest.join(" ") || null;
    const users = await fetchUsers();
    const u = resolveUser(users, target);
    if (!u) {
      print(`Пользователь не найден: ${target}`, "error");
      return;
    }
    if (u.isAdmin) {
      print("Нельзя забанить администратора.", "error");
      return;
    }
    await updateDoc(doc(db, "users", u.id), { banned: true, banReason: reason, bannedUntil: until });
    print(`Пользователь @${u.tag || u.id} забанен${until ? " до " + until : " навсегда"}${reason ? ", причина: " + reason : ""}.`);
  }

  async function unbanUser(target) {
    if (!target) {
      print("Использование: unban <tag|id>", "error");
      return;
    }
    const users = await fetchUsers();
    const u = resolveUser(users, target);
    if (!u) {
      print(`Пользователь не найден: ${target}`, "error");
      return;
    }
    await updateDoc(doc(db, "users", u.id), { banned: false, banReason: null, bannedUntil: null });
    print(`Пользователь @${u.tag || u.id} разбанен.`);
  }

  // --- Удаление аккаунта -----------------------------------------------
  // Полное удаление (аккаунт Firebase Auth + все чаты/сообщения + тег +
  // документ users/{uid}) требует прав Firebase Admin SDK, обходящих
  // firestore.rules целиком — с клиента так не сделать в принципе (см.
  // firestore.rules: users/{uid} и chats/{chatId} -> allow delete: if false,
  // без исключения для админа, tags/{tag} delete — только владельцем).
  // Поэтому эта команда с клиента только банит аккаунт (мгновенная блокировка
  // входа — App.jsx рендерит экран "забанен" вместо мессенджера) и печатает
  // готовую инструкцию для реального удаления через GitHub Actions
  // (.github/workflows/delete-account.yml -> scripts/deleteAccount.js),
  // единственное место в проекте с привилегиями Admin SDK — запускается
  // вручную владельцем репозитория, ключ сервисного аккаунта никогда не
  // попадает в браузерный бандл.
  async function deleteAccount(target) {
    if (!target) {
      print("Использование: account delete <tag|id|email>", "error");
      return;
    }
    const users = await fetchUsers();
    const u = resolveUser(users, target);
    if (!u) {
      print(`Пользователь не найден: ${target}`, "error");
      return;
    }
    if (u.isAdmin) {
      print("Нельзя удалить администратора — сначала снимите права isAdmin в Firebase Console.", "error");
      return;
    }
    if (!u.email) {
      print(`У пользователя @${u.tag || u.id} не указан email — удаление через GitHub Actions требует email.`, "error");
      return;
    }
    if (!u.banned) {
      await updateDoc(doc(db, "users", u.id), {
        banned: true,
        banReason: "Аккаунт удалён администратором",
        bannedUntil: null,
      });
    }
    print(
      `Аккаунт @${u.tag || u.id} (${u.email}) забанен — вход в мессенджер заблокирован немедленно.\n` +
        "Это ещё НЕ полное удаление: с клиента нельзя удалить аккаунт Firebase Auth, чаты/сообщения и занятый тег — " +
        "firestore.rules это прямо запрещает даже администратору.\n" +
        "Чтобы удалить аккаунт полностью и НЕОБРАТИМО, запустите workflow вручную:\n" +
        `  GitHub → репозиторий → вкладка "Actions" → "Delete user account" → "Run workflow" → email: ${u.email}\n` +
        "Он безвозвратно удалит: аккаунт Firebase Auth, документ пользователя, тег, все чаты и сообщения с его участием."
    );
  }

  async function handleAccount(args) {
    const sub = (args[0] || "").toLowerCase();
    if (sub !== "delete") {
      print("Использование: account delete <tag|id|email>", "error");
      return;
    }
    await deleteAccount(args[1]);
  }

  async function verifyUser(target) {
    if (!target) {
      print("Использование: verify <tag|id>", "error");
      return;
    }
    const users = await fetchUsers();
    const u = resolveUser(users, target);
    if (!u) {
      print(`Пользователь не найден: ${target}`, "error");
      return;
    }
    await updateDoc(doc(db, "users", u.id), { verifiedBadge: !u.verifiedBadge });
    print(`Бейдж «подтверждён» у @${u.tag || u.id}: ${!u.verifiedBadge ? "выдан" : "снят"}.`);
  }

  async function verifyGroup(chatId) {
    if (!chatId) {
      print("Использование: verifygroup <id чата>", "error");
      return;
    }
    const snap = await getDoc(doc(db, "chats", chatId));
    if (!snap.exists() || !snap.data().isGroup) {
      print(`Группа не найдена: ${chatId}`, "error");
      return;
    }
    const c = snap.data();
    await updateDoc(doc(db, "chats", chatId), { verifiedBadge: !c.verifiedBadge });
    print(`Бейдж «подтверждён» у группы «${c.name || chatId}»: ${!c.verifiedBadge ? "выдан" : "снят"}.`);
  }

  // Снос группы целиком. Требует явного --yes: команда необратима, а id
  // чатов длинные и похожи друг на друга — промахнуться на одну букву и
  // снести не ту группу слишком легко.
  async function deleteGroup(args) {
    const chatId = args[0];
    const confirmed = args.includes("--yes");
    if (!chatId) {
      print("Использование: group-delete <id чата> --yes", "error");
      return;
    }
    const snap = await getDoc(doc(db, "chats", chatId));
    if (!snap.exists() || !snap.data().isGroup) {
      print(`Группа не найдена: ${chatId}`, "error");
      return;
    }
    const c = snap.data();
    if (!confirmed) {
      print(`Группа «${c.name || chatId}», участников: ${(c.members || []).length}.`);
      print("Удаление НЕОБРАТИМО и затронет всех участников.", "error");
      print(`Повторите с подтверждением: group-delete ${chatId} --yes`);
      return;
    }
    print(`Удаляем «${c.name || chatId}»...`);
    try {
      const res = await deleteGroupChat(chatId, (n) => print(`  удалено сообщений: ${n}`, "info"));
      print(`Группа «${res.name}» удалена. Сообщений удалено: ${res.messages}.`);
    } catch (err) {
      print(`Не удалось удалить группу: ${err.message}`, "error");
    }
  }

  async function listGifts(target) {
    if (!target) {
      print("Использование: gifts <tag|id>", "error");
      return;
    }
    const users = await fetchUsers();
    const u = resolveUser(users, target);
    if (!u) {
      print(`Пользователь не найден: ${target}`, "error");
      return;
    }
    const gifts = u.ownedGifts || [];
    if (!gifts.length) {
      print("Подарков нет.", "info");
      return;
    }
    print(gifts.map((g) => `${g.instanceId}  ${g.giftId}${g.fromName ? "  от " + g.fromName : ""}`).join("\n"));
  }

  async function deleteGift(target, instanceId) {
    if (!target || !instanceId) {
      print("Использование: gift-delete <tag|id> <instanceId>", "error");
      return;
    }
    const users = await fetchUsers();
    const u = resolveUser(users, target);
    if (!u) {
      print(`Пользователь не найден: ${target}`, "error");
      return;
    }
    await adminDeleteGift(u.id, u, instanceId);
    print(`Подарок ${instanceId} удалён у @${u.tag || u.id}.`);
  }

  // --- Выдача/отзыв предметов магазина (см. utils/adminGrants.js) ---------
  // "Выдать" — это НЕ покупка: звёзды не списываются, но у пользователя в
  // магазине предмет становится доступен так же, как купленный, только с
  // пометкой "получено не купив". "Забрать" отменяет и выдачу, и обычную
  // покупку — предмет снова закрыт как будто его никогда не было.
  function formatItemList(filter) {
    const q = (filter || "").trim().toLowerCase();
    const items = q
      ? ITEM_CATALOG.filter((it) => it.key.toLowerCase().includes(q) || it.label.toLowerCase().includes(q))
      : ITEM_CATALOG;
    if (!items.length) return "Ничего не найдено.";
    return items.map((it) => `${it.key}  —  ${it.label}`).join("\n");
  }

  async function handleItem(args) {
    const sub = (args[0] || "").toLowerCase();
    if (!["grant", "revoke", "list"].includes(sub)) {
      print("Использование: item grant|revoke|list ...", "error");
      return;
    }
    if (sub === "list") {
      print(formatItemList(args.slice(1).join(" ")), "info");
      return;
    }
    const target = args[1];
    const key = args[2];
    if (!target || !key) {
      print(`Использование: item ${sub} <tag|id> <ключ>`, "error");
      return;
    }
    const item = findCatalogItem(key);
    if (!item) {
      print(`Неизвестный ключ предмета: "${key}". Введите "item list" для списка.`, "error");
      return;
    }
    const users = await fetchUsers();
    const u = resolveUser(users, target);
    if (!u) {
      print(`Пользователь не найден: ${target}`, "error");
      return;
    }
    if (sub === "grant") {
      const alreadyOwned = isItemOwned(u, item);
      await grantCatalogItem(u.id, u, key);
      print(
        `«${item.label}» выдано пользователю @${u.tag || u.id} бесплатно` +
          (alreadyOwned
            ? " (уже было куплено — теперь помечено как выданное администрацией)."
            : " — в магазине отображается как «получено не купив».")
      );
    } else {
      const owned = isItemOwned(u, item);
      await revokeCatalogItem(u.id, u, key);
      print(
        owned
          ? `«${item.label}» отозвано у @${u.tag || u.id} — предмет снова закрыт как непокупленный.`
          : `У @${u.tag || u.id} и так не было «${item.label}» — на всякий случай пометка выдачи снята.`
      );
    }
  }

  async function handleStars(args) {
    const sub = (args[0] || "").toLowerCase();
    if (!["grant", "deduct", "block", "unblock"].includes(sub)) {
      print("Использование: stars grant|deduct|block|unblock <tag|id> [кол-во]", "error");
      return;
    }
    const target = args[1];
    if (!target) {
      print("Использование: stars grant|deduct|block|unblock <tag|id> [кол-во]", "error");
      return;
    }
    const users = await fetchUsers();
    const u = resolveUser(users, target);
    if (!u) {
      print(`Пользователь не найден: ${target}`, "error");
      return;
    }
    if (sub === "grant" || sub === "deduct") {
      const amount = Number(args[2]);
      if (!Number.isFinite(amount) || amount <= 0) {
        print("Некорректное количество звёзд.", "error");
        return;
      }
      if (sub === "grant") {
        await grantStars(user.uid, u.id, u, amount);
        print(`Начислено ${amount} ⭐ пользователю @${u.tag || u.id}.`);
      } else {
        await deductStars(user.uid, u.id, u, amount);
        print(`Списано у @${u.tag || u.id} (было ${u.stars || 0} ⭐, запрошено ${amount} ⭐).`);
      }
    } else {
      const blocked = sub === "block";
      await setStarsBlocked(user.uid, u.id, blocked);
      print(`Начисление звёзд для @${u.tag || u.id}: ${blocked ? "заблокировано" : "разблокировано"}.`);
    }
  }

  // --- Пользовательские боты (см. utils/customBots.js) — только поиск для
  // botkey-команд ниже, редактировать содержимое бота отсюда нельзя (это
  // по-прежнему делает только сам владелец, см. MyBotsView.jsx).
  async function fetchBots() {
    const snap = await getDocs(collection(db, "bots"));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  function resolveBot(bots, raw) {
    if (!raw) return null;
    const q = raw.trim().replace(/^@/, "").toLowerCase();
    return bots.find((b) => (b.tag || "").toLowerCase() === q) || bots.find((b) => b.id === raw.trim()) || null;
  }

  async function handleBotKey(args) {
    const sub = (args[0] || "").toLowerCase();
    if (!["create", "revoke", "reactivate", "list"].includes(sub)) {
      print("Использование: botkey create|revoke|reactivate|list ...", "error");
      return;
    }
    if (sub === "list") {
      const target = args[1];
      let botId = null;
      if (target) {
        const bots = await fetchBots();
        const b = resolveBot(bots, target);
        if (!b) {
          print(`Бот не найден: ${target}`, "error");
          return;
        }
        botId = b.id;
      }
      const keys = await listBotKeys(botId);
      if (!keys.length) {
        print("Ключей нет.", "info");
        return;
      }
      print(keys.map((k) => `${k.code}  bot=${k.botId}  ${k.active ? "активен" : "ОТОЗВАН"}`).join("\n"));
      return;
    }
    if (sub === "create") {
      const target = args[1];
      if (!target) {
        print("Использование: botkey create <botId|@тег бота>", "error");
        return;
      }
      const bots = await fetchBots();
      const b = resolveBot(bots, target);
      if (!b) {
        print(`Бот не найден: ${target}`, "error");
        return;
      }
      const code = await createBotKey(b.id);
      print(
        `Ключ создан для бота «${b.name}» (${b.id}): ${code}\n` +
          "Передайте этот код владельцу бота — он вводит его в разделе «Разработка», в форме бота, поле «Ключ»."
      );
      return;
    }
    // revoke / reactivate — по самому коду ключа, не по боту
    const code = (args[1] || "").trim().toUpperCase();
    if (!code) {
      print(`Использование: botkey ${sub} <code>`, "error");
      return;
    }
    if (sub === "revoke") {
      await revokeBotKey(code);
      print(`Ключ ${code} отозван — привилегированные возможности бота отключаются немедленно.`);
    } else {
      await reactivateBotKey(code);
      print(`Ключ ${code} снова активен.`);
    }
  }

  // --- Ключи обхода письма-подтверждения при регистрации (см.
  // utils/emailKeys.js, firestore.rules -> emailKeys/{code}, Register.jsx) ---
  async function handleEmailKey(args) {
    const sub = (args[0] || "").toLowerCase();
    if (!["create", "revoke", "reactivate", "list"].includes(sub)) {
      print("Использование: emailkey create|revoke|reactivate|list ...", "error");
      return;
    }
    if (sub === "list") {
      const emailFilter = args[1];
      const keys = await listEmailKeys(emailFilter);
      if (!keys.length) {
        print("Ключей нет.", "info");
        return;
      }
      print(
        keys
          .map((k) => `${k.code}  ${k.email}  ${k.active ? "активен" : "ОТОЗВАН"}${k.used ? "  (использован)" : ""}`)
          .join("\n")
      );
      return;
    }
    if (sub === "create") {
      const email = (args[1] || "").trim().toLowerCase();
      if (!email || !email.includes("@")) {
        print("Использование: emailkey create <email>", "error");
        return;
      }
      const code = await createEmailKey(email);
      print(
        `Ключ создан для ${email}: ${code}\n` +
          "Передайте этот код человеку — при регистрации именно с этим email он вставляет его в поле «Ключ» вместо ожидания письма."
      );
      return;
    }
    // revoke / reactivate — по самому коду ключа, не по email
    const code = (args[1] || "").trim().toUpperCase();
    if (!code) {
      print(`Использование: emailkey ${sub} <code>`, "error");
      return;
    }
    if (sub === "revoke") {
      await revokeEmailKey(code);
      print(`Ключ ${code} отозван.`);
    } else {
      await reactivateEmailKey(code);
      print(`Ключ ${code} снова активен.`);
    }
  }

  // --- Ссылки-переходники (см. utils/shortLinks.js, firestore.rules ->
  // shortLinks/{code}, web/src/pages/ShortLink.jsx -> маршрут /r/{code}) ---
  async function handleLink(args) {
    const sub = (args[0] || "").toLowerCase();
    if (!["create", "delete", "list"].includes(sub)) {
      print("Использование: link create|delete|list ...", "error");
      return;
    }
    if (sub === "list") {
      const links = await listShortLinks();
      if (!links.length) {
        print("Переходников нет.", "info");
        return;
      }
      print(
        links
          .map((l) => {
            const limitInfo = l.maxUses != null ? ` (использован ${l.uses || 0} из ${l.maxUses})` : "";
            const warnInfo = l.showWarning === false ? " [без предупреждения]" : "";
            return `${window.location.origin}/r/${l.code}  →  ${l.url}${limitInfo}${warnInfo}`;
          })
          .join("\n")
      );
      return;
    }
    if (sub === "create") {
      const url = args[1];
      // Аргументы после url — все необязательные, каждый можно пропустить
      // символом "-", чтобы задать следующий: код (или "-" для случайного),
      // лимит переходов ("только для нескольких пользователей" — после
      // того как по ссылке перейдёт столько же разных людей, она удалится
      // сама; "-" ИЛИ "0" — без лимита), и наконец 0|1 — показывать ли перед
      // переходом предупреждение "вы покидаете MyPeal" (по умолчанию 1 —
      // показывать; 0 — сразу редиректить без единого клика). "0" в позиции
      // лимита тоже трактуется как "без лимита" — по аналогии с 0|1 у
      // предупреждения это частая опечатка (человек путает позиции
      // аргументов), проще принять оба написания, чем каждый раз объяснять.
      let code = args[2];
      if (code === "-") code = undefined;
      let limitArg = args[3];
      if (limitArg === "-" || limitArg === "0") limitArg = undefined;
      const warnArg = args[4];
      if (!url) {
        print("Использование: link create <url> [код|-] [лимит|-|0] [0|1]", "error");
        return;
      }
      let maxUses;
      if (limitArg !== undefined) {
        const n = Number(limitArg);
        if (!Number.isInteger(n) || n <= 0) {
          print("Лимит переходов должен быть положительным целым числом (или \"-\"/\"0\" — без лимита).", "error");
          return;
        }
        maxUses = n;
      }
      let showWarning = true;
      if (warnArg !== undefined) {
        if (warnArg !== "0" && warnArg !== "1") {
          print("Последний аргумент — 0 (без предупреждения) или 1 (с предупреждением).", "error");
          return;
        }
        showWarning = warnArg === "1";
      }
      const finalCode = await createShortLink(url, user.uid, code, maxUses, showWarning);
      const limitNote = maxUses
        ? `\nЛимит переходов: ${maxUses} (после этого ссылка удалится автоматически)`
        : "";
      const warnNote = showWarning
        ? ""
        : "\nПредупреждение перед переходом отключено — ссылка сразу редиректит на сайт.";
      print(
        `Переходник создан: ${window.location.origin}/r/${finalCode}\n` +
          `Ведёт на: ${url}${limitNote}${warnNote}`
      );
      return;
    }
    // delete — навсегда, без возможности восстановить (в отличие от
    // botkey/emailkey revoke, которые просто отключают ключ)
    const code = args[1];
    if (!code) {
      print("Использование: link delete <код>", "error");
      return;
    }
    await deleteShortLink(code);
    print(`Переходник "${code}" удалён навсегда.`);
  }

  async function announce(argsStr) {
    if (!argsStr) {
      print("Использование: announce [--pin] <текст>", "error");
      return;
    }
    let pin = false;
    let text = argsStr;
    if (text.startsWith("--pin")) {
      pin = true;
      text = text.slice("--pin".length).trim();
    }
    if (!text) {
      print("Текст объявления не может быть пустым.", "error");
      return;
    }
    const users = await fetchUsers();
    let sent = 0;
    await Promise.all(
      users.map(async (u) => {
        try {
          await sendSystemNotification(u.id, {
            type: "site_update",
            text: `📢 ${text}`,
            fromName: profile?.name || "MyPeal",
            actorUid: user.uid,
            pinned: pin,
          });
          sent += 1;
        } catch {
          // пропускаем этого пользователя — остальным всё равно уйдёт
        }
      })
    );
    print(`Объявление отправлено ${sent}/${users.length} пользователям${pin ? " (закреплено)" : ""}.`);
  }

  async function execute(raw) {
    const firstSpace = raw.indexOf(" ");
    const cmd = (firstSpace === -1 ? raw : raw.slice(0, firstSpace)).toLowerCase();
    const argsStr = firstSpace === -1 ? "" : raw.slice(firstSpace + 1).trim();
    const args = argsStr ? argsStr.split(/\s+/) : [];

    switch (cmd) {
      case "help":
        showHelp();
        break;
      case "users":
        await listUsers(argsStr);
        break;
      case "user":
        await showUser(args[0]);
        break;
      case "chats":
        await listChats(argsStr);
        break;
      case "chat":
        await showChat(args[0]);
        break;
      case "ban":
        await banUser(args);
        break;
      case "unban":
        await unbanUser(args[0]);
        break;
      case "verify":
        await verifyUser(args[0]);
        break;
      case "verifygroup":
        await verifyGroup(args[0]);
        break;
      case "group-delete":
        await deleteGroup(args);
        break;
      case "gifts":
        await listGifts(args[0]);
        break;
      case "gift-delete":
        await deleteGift(args[0], args[1]);
        break;
      case "stars":
        await handleStars(args);
        break;
      case "item":
        await handleItem(args);
        break;
      case "announce":
        await announce(argsStr);
        break;
      case "botkey":
        await handleBotKey(args);
        break;
      case "emailkey":
        await handleEmailKey(args);
        break;
      case "link":
        await handleLink(args);
        break;
      case "account":
        await handleAccount(args);
        break;
      default:
        print(`Неизвестная команда: "${cmd}". Введите "help" для списка команд.`, "error");
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy) return;
    const raw = inputValue;
    if (!raw.trim()) return;
    setInputValue("");
    historyRef.current = [...historyRef.current, raw];
    historyIndexRef.current = null;
    print(raw, "input");
    const trimmed = raw.trim();
    const lower = trimmed.toLowerCase();
    if (lower === "clear") {
      setLines([]);
      return;
    }
    if (lower === "exit") {
      navigate("/");
      return;
    }
    setBusy(true);
    try {
      await execute(trimmed);
    } catch (err) {
      print("Ошибка: " + (err?.message || String(err)), "error");
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  function handleKeyDown(e) {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const h = historyRef.current;
      if (!h.length) return;
      const idx = historyIndexRef.current === null ? h.length - 1 : Math.max(0, historyIndexRef.current - 1);
      historyIndexRef.current = idx;
      setInputValue(h[idx]);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const h = historyRef.current;
      if (historyIndexRef.current === null) return;
      const idx = historyIndexRef.current + 1;
      if (idx >= h.length) {
        historyIndexRef.current = null;
        setInputValue("");
      } else {
        historyIndexRef.current = idx;
        setInputValue(h[idx]);
      }
    }
  }

  if (!profile?.isAdmin) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="console-page">
      <div className="admin-top-bar console-top-bar">
        <Link to="/" className="link-btn">
          ← {t("adminPanel.backToApp")}
        </Link>
        <span className="console-title">{t("adminConsole.title")}</span>
        <button type="button" className="secondary" onClick={signOut}>
          {t("profileView.signOut")}
        </button>
      </div>
      <div className="console-screen" ref={outputRef} onClick={() => inputRef.current?.focus()}>
        {lines.map((l) => (
          <pre key={l.id} className={"console-line console-line-" + l.kind}>
            {l.kind === "input" ? `> ${l.text}` : l.text}
          </pre>
        ))}
        {busy && <pre className="console-line console-line-info">…</pre>}
      </div>
      <form className="console-input-row" onSubmit={handleSubmit}>
        <span className="console-prompt">admin@mymessage:~$</span>
        <input
          ref={inputRef}
          className="console-input"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={busy}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder={t("adminConsole.inputPlaceholder")}
        />
      </form>
    </div>
  );
}
