import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  serverTimestamp,
  where,
} from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../contexts/AuthContext";
import VerifiedBadge from "../components/VerifiedBadge";
import { searchUsersByTagPrefix } from "../utils/tagSearch";
import { sendSystemNotification } from "../utils/systemChat";
import { chatIdFor, ensureChatExists } from "../utils/requestActions";
import { useLanguage } from "../i18n/LanguageContext";
import { claimFirstFriendBonus, ensureBotChat, STARS_BOT_UID } from "../utils/stars";
import { ensureCustomBotChat, searchBotsByTagPrefix } from "../utils/customBots";
import { ensureKazinoBotChat, KAZINO_BOT_ID } from "../utils/kazinoBot";
import { clearContactRemoval } from "../utils/contacts";

export default function FriendsSearch() {
  const { user, profile } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();
  const [openingBot, setOpeningBot] = useState(false);

  // Раньше эта функция ничего не принимала и всегда открывала чат с ботом
  // Stars (ensureBotChat жёстко использует STARS_BOT_UID) — из-за этого
  // клик по ЛЮБОМУ найденному "настоящему" боту (isBot === true), включая
  // @stiller_bot, всегда уводил именно в чат со Stars. У @stiller_bot нет
  // своего отдельного "бот-чата" с фиксированными кнопками — это обычный
  // человек-аккаунт, просто с isBot: true, а его команды /kazik и /wheel
  // работают в ЛЮБОМ обычном чате (см. utils/stillerBot.js), поэтому для
  // него самого достаточно открыть самый обычный личный чат. @kazino_bot —
  // отдельный случай (см. utils/kazinoBot.js): "виртуальный" бот без
  // настоящего users/{uid}, ему нужен ensureKazinoBotChat (isBotChat +
  // botUid), а не обычный ensureChatExists.
  async function openBotChat(botUid) {
    setOpeningBot(true);
    try {
      const chatId =
        botUid === STARS_BOT_UID
          ? await ensureBotChat(user.uid)
          : botUid === KAZINO_BOT_ID
            ? await ensureKazinoBotChat(user.uid)
            : chatIdFor(user.uid, botUid);
      if (botUid !== STARS_BOT_UID && botUid !== KAZINO_BOT_ID) {
        await ensureChatExists(user.uid, botUid);
      }
      navigate(`/chat/${chatId}`);
    } finally {
      setOpeningBot(false);
    }
  }

  // То же самое, но для ЧЬЕГО-ТО пользовательского бота (см. utils/
  // customBots.js) — botId у него не захардкожен, а берётся из найденного
  // профиля (foundUser.id для bots/{id}).
  async function openCustomBotChat(botId) {
    setOpeningBot(true);
    try {
      const chatId = await ensureCustomBotChat(user.uid, botId);
      navigate(`/chat/${chatId}`);
    } finally {
      setOpeningBot(false);
    }
  }
  const [searchTag, setSearchTag] = useState("");
  const [foundUser, setFoundUser] = useState(null);
  const [searchError, setSearchError] = useState("");
  const [searching, setSearching] = useState(false);
  const [sendMsg, setSendMsg] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  // Взаимная блокировка между мной и найденным человеком — firestore.rules
  // не даёт создать friendRequests, пока действует блокировка хоть в одну
  // сторону (см. match /friendRequests/{requestId} -> allow create). Раньше
  // попытка отправить заявку такому человеку просто падала с "Missing or
  // insufficient permissions" без объяснений — теперь проверяем это ЗАРАНЕЕ
  // и, если заблокировал Я, предлагаем сразу и разблокировать, и отправить
  // заявку одной кнопкой.
  const [blockStatus, setBlockStatus] = useState({ iBlockedThem: false, theyBlockedMe: false });
  const [unblocking, setUnblocking] = useState(false);

  // Самовосстановление: если у уже принятой ранее заявки (в обе стороны)
  // почему-то нет чата (например, из-за прошлого сбоя при создании), тихо
  // досоздаём его в фоне, не трогая существующие чаты.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const [asRecipient, asSender] = await Promise.all([
          getDocs(
            query(
              collection(db, "friendRequests"),
              where("to", "==", user.uid),
              where("status", "==", "accepted")
            )
          ),
          getDocs(
            query(
              collection(db, "friendRequests"),
              where("from", "==", user.uid),
              where("status", "==", "accepted")
            )
          ),
        ]);
        const pairs = new Map();
        [...asRecipient.docs, ...asSender.docs].forEach((d) => {
          const { from, to } = d.data();
          pairs.set(chatIdFor(from, to), [from, to]);
        });
        for (const [, [a, b]] of pairs) {
          if (cancelled) return;
          await ensureChatExists(a, b);
        }
      } catch {
        // ничего страшного — попробуем ещё раз при следующем открытии страницы
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  // Бонус за первого друга (см. utils/stars.js -> claimFirstFriendBonus) —
  // один раз, как только обнаруживается хотя бы одна принятая заявка в
  // друзья (в любую сторону — и у того, кто принял, и у того, кто отправил
  // заявку изначально). Отдельный эффект от самолечения чатов выше, чтобы
  // корректно реагировать на смену profile (пока бонус ещё не начислен).
  useEffect(() => {
    if (!user || !profile) return;
    if (profile.starsProgress?.firstFriendBonusClaimed) return;
    let cancelled = false;
    (async () => {
      try {
        const [asRecipient, asSender] = await Promise.all([
          getDocs(
            query(
              collection(db, "friendRequests"),
              where("to", "==", user.uid),
              where("status", "==", "accepted"),
              limit(1)
            )
          ),
          getDocs(
            query(
              collection(db, "friendRequests"),
              where("from", "==", user.uid),
              where("status", "==", "accepted"),
              limit(1)
            )
          ),
        ]);
        if (cancelled) return;
        if (!asRecipient.empty || !asSender.empty) {
          await claimFirstFriendBonus(user.uid, profile);
        }
      } catch {
        // не критично — попробуем при следующем открытии страницы
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, profile]);

  // Живые подсказки по мере ввода тега, как в Telegram — сразу с первой
  // буквы показываем совпадающих пользователей (см. utils/tagSearch.js).
  useEffect(() => {
    const tag = searchTag.trim().replace(/^@/, "").toLowerCase();
    if (!tag) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        // Живые подсказки ищут сразу и людей, и пользовательских ботов —
        // тег общий на оба типа (см. firestore.rules -> tags/{tag}), так что
        // человек не должен гадать, где искать нужное имя.
        const [users, bots] = await Promise.all([
          searchUsersByTagPrefix(tag),
          searchBotsByTagPrefix(tag, 4),
        ]);
        if (!cancelled) setSuggestions([...users, ...bots]);
      } catch {
        // тихо игнорируем — есть кнопка "Найти" как запасной вариант
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [searchTag]);

  // Как только найден реальный человек (не бот — ботов нельзя заблокировать
  // через этот экран, у них своя кнопка "Открыть чат"), смотрим, нет ли
  // между нами блокировки в любую сторону.
  useEffect(() => {
    setBlockStatus({ iBlockedThem: false, theyBlockedMe: false });
    if (!user || !foundUser || foundUser.isBot || foundUser.isCustomBot) return;
    let cancelled = false;
    (async () => {
      try {
        // Запросами, а не чтением конкретных документов: правило blocks/{id}
        // смотрит на resource.data, поэтому чтение НЕСУЩЕСТВУЮЩЕГО документа
        // (обычный случай — блокировки нет) отклоняется с permission-denied.
        // Запрос же просто возвращает пусто. См. тот же приём в ChatWindow.jsx.
        const [mine, theirs] = await Promise.all([
          getDocs(
            query(
              collection(db, "blocks"),
              where("blockerId", "==", user.uid),
              where("blockedId", "==", foundUser.id)
            )
          ),
          getDocs(
            query(
              collection(db, "blocks"),
              where("blockerId", "==", foundUser.id),
              where("blockedId", "==", user.uid)
            )
          ),
        ]);
        if (!cancelled) {
          setBlockStatus({ iBlockedThem: !mine.empty, theyBlockedMe: !theirs.empty });
        }
      } catch {
        // не критично — попытка отправить заявку и так покажет ошибку,
        // если блокировка всё-таки есть
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, foundUser]);

  async function unblockAndAdd() {
    if (!foundUser) return;
    setUnblocking(true);
    setSendMsg("");
    try {
      await deleteDoc(doc(db, "blocks", `${user.uid}_${foundUser.id}`));
      setBlockStatus((s) => ({ ...s, iBlockedThem: false }));
      await sendRequest();
    } catch (err) {
      setSendMsg(t("friendsSearch.genericError", { message: err.message }));
    } finally {
      setUnblocking(false);
    }
  }

  function pickSuggestion(u) {
    setFoundUser(u);
    setSuggestions([]);
    setSearchTag(u.tag || "");
    setSearchError("");
    setSendMsg("");
  }

  async function handleSearch(e) {
    e.preventDefault();
    setFoundUser(null);
    setSearchError("");
    setSendMsg("");
    setSuggestions([]);
    const tag = searchTag.trim().replace(/^@/, "").toLowerCase();
    if (!tag) return;
    setSearching(true);
    try {
      const tagDoc = await getDoc(doc(db, "tags", tag));
      if (!tagDoc.exists()) {
        setSearchError(t("chatWindow.userNotFound"));
        return;
      }
      const ownerUid = tagDoc.data().uid;
      const userDoc = await getDoc(doc(db, "users", ownerUid));
      if (userDoc.exists()) {
        setFoundUser({ id: userDoc.id, ...userDoc.data() });
        return;
      }
      // Тег занят не человеком, а чьим-то пользовательским ботом (см. utils/
      // customBots.js -> setBotTag) — тот же общий поиск, только профиль
      // лежит в bots/{id}, а не в users/{id}.
      const botDoc = await getDoc(doc(db, "bots", ownerUid));
      if (botDoc.exists()) {
        setFoundUser({ id: botDoc.id, ...botDoc.data() });
        return;
      }
      setSearchError(t("chatWindow.userNotFound"));
    } catch (err) {
      setSearchError(err.message);
    } finally {
      setSearching(false);
    }
  }

  async function sendRequest() {
    setSendMsg("");
    try {
      if (foundUser.id === user.uid) {
        setSendMsg(t("friendsSearch.selfRequestError"));
        return;
      }
      if (foundUser.acceptingRequests === false) {
        setSendMsg(t("friendsSearch.notAcceptingError"));
        return;
      }
      const existing = await getDocs(
        query(
          collection(db, "friendRequests"),
          where("from", "==", user.uid),
          where("to", "==", foundUser.id),
          where("status", "==", "pending"),
          limit(1)
        )
      );
      if (!existing.empty) {
        setSendMsg(t("friendsSearch.alreadySent"));
        return;
      }
      const reqRef = await addDoc(collection(db, "friendRequests"), {
        from: user.uid,
        to: foundUser.id,
        status: "pending",
        createdAt: serverTimestamp(),
      });
      try {
        await sendSystemNotification(foundUser.id, {
          type: "friend_request",
          text: `🤝 ${profile?.name || t("common.unknownUser")} отправил(а) вам заявку в друзья`,
          fromName: profile?.name,
          actorUid: user.uid,
          refId: reqRef.id,
        });
      } catch {
        // необязательно — сама заявка уже отправлена, принять её можно из
        // "Системные сообщения" (см. ChatWindow.jsx — SystemActionMessage)
      }
      // Если раньше мы удаляли этого человека из друзей (utils/contacts.js),
      // а теперь дружим заново — снимаем старую пометку. Best-effort, не
      // должно мешать уже отправленной заявке при любой ошибке.
      clearContactRemoval(user.uid, foundUser.id);
      setSendMsg(t("friendsSearch.sentSuccess"));
    } catch (err) {
      setSendMsg(t("friendsSearch.genericError", { message: err.message }));
    }
  }

  return (
    <div className="panel">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0 }}>{t("friendsSearch.title")}</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <Link to="/bots">
            <button type="button" className="secondary" style={{ margin: 0, width: "auto", padding: "8px 14px", fontSize: 13 }}>
              {t("customBots.myBotsLink")}
            </button>
          </Link>
          <Link to="/create-group">
            <button type="button" style={{ margin: 0, width: "auto", padding: "8px 14px", fontSize: 13 }}>
              {t("friendsSearch.createGroup")}
            </button>
          </Link>
        </div>
      </div>
      <form onSubmit={handleSearch} className="search-row" style={{ position: "relative" }}>
        <input
          value={searchTag}
          onChange={(e) => setSearchTag(e.target.value)}
          placeholder={t("friendsSearch.searchPlaceholder")}
        />
        <button type="submit" disabled={searching}>
          {t("friendsSearch.findButton")}
        </button>
        {suggestions.length > 0 && (
          <div className="suggestions-dropdown">
            {suggestions.map((u) => (
              <div key={u.id} className="suggestion-row" onClick={() => pickSuggestion(u)}>
                <b>
                  {u.name}
                  <VerifiedBadge show={u.verifiedBadge} />
                </b>{" "}
                <span className="muted">@{u.tag}</span>
              </div>
            ))}
          </div>
        )}
      </form>
      {searchError && <div className="error">{searchError}</div>}
      {foundUser && (
        <div className="user-card">
          <div>
            <b>
              {foundUser.name}
              <VerifiedBadge show={foundUser.verifiedBadge} />
            </b>{" "}
            <span className="muted">@{foundUser.tag}</span>
            {foundUser.bio && <p className="muted">{foundUser.bio}</p>}
            {blockStatus.theyBlockedMe && (
              <p className="error" style={{ fontSize: 12 }}>{t("friendsSearch.theyBlockedMeError")}</p>
            )}
            {blockStatus.iBlockedThem && !blockStatus.theyBlockedMe && (
              <p className="muted" style={{ fontSize: 12 }}>{t("friendsSearch.iBlockedThemHint")}</p>
            )}
          </div>
          {foundUser.isCustomBot ? (
            <button onClick={() => openCustomBotChat(foundUser.id)} disabled={openingBot}>
              {t("customBots.openChatBtn")}
            </button>
          ) : foundUser.isBot ? (
            <button onClick={() => openBotChat(foundUser.id)} disabled={openingBot}>
              {t("friendsSearch.openBotChat")}
            </button>
          ) : blockStatus.theyBlockedMe ? null : blockStatus.iBlockedThem ? (
            <button onClick={unblockAndAdd} disabled={unblocking}>
              {t("friendsSearch.unblockAndAdd")}
            </button>
          ) : (
            <button onClick={sendRequest}>{t("friendsSearch.addFriend")}</button>
          )}
        </div>
      )}
      {sendMsg && <div className="info">{sendMsg}</div>}

      <p className="muted" style={{ marginTop: 24, fontSize: 13 }}>
        {t("friendsSearch.systemChatHint")}
      </p>
    </div>
  );
}
