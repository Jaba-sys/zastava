import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { collection, doc, getDoc, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../contexts/AuthContext";
import { isOnline } from "../utils/presence";
import { firstChar } from "../utils/text";
import VerifiedBadge from "../components/VerifiedBadge";
import UserAvatar from "../components/UserAvatar";
import NicknameText from "../components/NicknameText";
import { useLanguage } from "../i18n/LanguageContext";

// Чат скрыт у пользователя ("Удалить чат"), пока после скрытия не появилось
// новой активности — тогда он сам возвращается в список.
function isHiddenForMe(chat, uid) {
  const hiddenAt = chat.hiddenFor?.[uid];
  if (!hiddenAt) return false;
  const hiddenMs = hiddenAt.toMillis ? hiddenAt.toMillis() : 0;
  const updatedMs = chat.updatedAt?.toMillis ? chat.updatedAt.toMillis() : 0;
  return updatedMs <= hiddenMs;
}

// Текст превью последнего сообщения — с учётом "Очистить историю": если всё,
// что было в чате, попало под очистку, показываем заглушку вместо текста.
function previewText(chat, uid, t) {
  const clearedAt = chat.clearedFor?.[uid];
  if (clearedAt) {
    const clearedMs = clearedAt.toMillis ? clearedAt.toMillis() : 0;
    const lastMs = chat.lastMessage?.createdAt?.toMillis ? chat.lastMessage.createdAt.toMillis() : 0;
    if (!chat.lastMessage || lastMs <= clearedMs) return t("chatsList.historyCleared");
  }
  return chat.lastMessage ? chat.lastMessage.text : t("chatsList.noMessages");
}

export default function ChatsList() {
  const { user, profile } = useAuth();
  const { t } = useLanguage();
  const [chats, setChats] = useState([]);
  const [now, setNow] = useState(() => Date.now());
  const navigate = useNavigate();

  // Обновляем "текущее время" раз в 15 секунд, чтобы статус "в сети" не
  // зависал устаревшим между обновлениями списка чатов.
  useEffect(() => {
    const t2 = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t2);
  }, []);

  useEffect(() => {
    if (!user) return;
    const q = query(
      collection(db, "chats"),
      where("members", "array-contains", user.uid),
      orderBy("updatedAt", "desc")
    );
    const unsub = onSnapshot(q, async (snap) => {
      const items = await Promise.all(
        snap.docs.map(async (d) => {
          const data = d.data();
          if (data.isGroup || data.isSystem) return { id: d.id, ...data, other: null };
          const otherUid = data.members.find((m) => m !== user.uid);
          const otherSnap = await getDoc(doc(db, "users", otherUid));
          if (otherSnap.exists()) return { id: d.id, ...data, other: otherSnap.data() };
          // Бот без настоящего Firebase Auth аккаунта (свой бот из
          // MyBotsView.jsx или системный @kazino_bot, см. utils/kazinoBot.js) —
          // в users/{uid} его нет, профиль лежит в bots/{botId}. Тот же
          // fallback, что уже есть в ChatWindow.jsx для открытого чата —
          // без него такой чат в списке слева показывался бы безымянным
          // "?" вместо имени и аватарки бота.
          if (data.isBotChat && data.botUid === otherUid) {
            const botSnap = await getDoc(doc(db, "bots", otherUid));
            return { id: d.id, ...data, other: botSnap.exists() ? { id: botSnap.id, ...botSnap.data() } : null };
          }
          return { id: d.id, ...data, other: null };
        })
      );
      const visible = items.filter((c) => !isHiddenForMe(c, user.uid));
      // "Системные сообщения" всегда закреплены сверху, как в Telegram —
      // независимо от времени последнего сообщения.
      const sysIdx = visible.findIndex((c) => c.isSystem);
      const ordered =
        sysIdx > 0 ? [visible[sysIdx], ...visible.slice(0, sysIdx), ...visible.slice(sysIdx + 1)] : visible;
      setChats(ordered);
    });
    return unsub;
  }, [user]);

  // Если человек перешёл по ссылке-приглашению в группу до того, как вошёл
  // в аккаунт (или до того, как закончил регистрацию), ссылка запоминается
  // в localStorage — как только он оказался здесь (значит, уже полностью
  // авторизован), возвращаем его обратно на экран вступления в группу.
  useEffect(() => {
    try {
      // Новый ключ хранит готовый путь (/join/... или /invite/...), старый —
      // только id группы; читаем оба, иначе переход потеряется у тех, кто
      // открыл ссылку до обновления.
      // Вход в стороннее приложение (см. pages/Authorize.jsx) прерывается тем
      // же способом: человека уводят логиниться, а вернуть его надо ровно на
      // тот же экран с теми же параметрами, иначе пропуск не выпишется.
      const pendingAuth = localStorage.getItem("pendingAuthorizePath");
      if (pendingAuth) {
        localStorage.removeItem("pendingAuthorizePath");
        navigate(pendingAuth);
        return;
      }
      const pendingPath = localStorage.getItem("pendingInvitePath");
      const pendingChat = localStorage.getItem("pendingInviteChatId");
      if (pendingPath) {
        localStorage.removeItem("pendingInvitePath");
        navigate(pendingPath);
      } else if (pendingChat) {
        localStorage.removeItem("pendingInviteChatId");
        navigate(`/invite/${pendingChat}`);
      }
    } catch {
      // localStorage недоступен — просто пропускаем
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="panel">
      <div className="chats-title-row">
        <h2>{t("chatsList.title")}</h2>
        <div className="stars-banner" title={t("layout.starsTitle")}>
          ⭐ {profile?.stars || 0}
        </div>
      </div>
      {chats.length === 0 && <p className="muted">{t("chatsList.empty")}</p>}
      {chats.map((chat) => (
        <div key={chat.id} className="chat-row" onClick={() => navigate(`/chat/${chat.id}`)}>
          {chat.isSystem || chat.isGroup ? (
            <div className="avatar">{chat.isSystem ? "🔔" : "👥"}</div>
          ) : (
            <UserAvatar
              profile={chat.other}
              fallback={firstChar(chat.other?.name)}
              online={isOnline(chat.other?.lastActive, now)}
            />
          )}
          <div className="chat-row-body">
            <b>
              {chat.isSystem ? (
                t("chatsList.systemChatName")
              ) : chat.isGroup ? (
                chat.name
              ) : (
                <NicknameText profile={chat.other}>{chat.other?.name}</NicknameText>
              )}
              <VerifiedBadge show={chat.isGroup ? chat.verifiedBadge : chat.other?.verifiedBadge} />
            </b>
            <span className="muted">{previewText(chat, user.uid, t)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
