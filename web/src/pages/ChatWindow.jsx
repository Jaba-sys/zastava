import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  addDoc,
  arrayRemove,
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../contexts/AuthContext";
import { useFileTransfer } from "../contexts/FileTransferContext";
import { useCall } from "../contexts/CallContext";
import { useGroupCall } from "../contexts/GroupCallContext";
import CallMemberPicker from "../components/CallMemberPicker";
import {
  MAX_PARTICIPANTS,
  canStartGroupCall,
  canJoinGroupCall,
  shouldRejoinGroupCall,
  hasLiveParticipant,
  isStaleParticipant,
} from "../utils/groupCalls";
import { isOnline, isTyping, TYPING_PING_INTERVAL_MS } from "../utils/presence";
import { firstChar } from "../utils/text";
import { deleteGroupChat } from "../utils/groupDelete";
import { ADMIN_RIGHT_KEYS, canInGroup, groupAdminRights, isGroupAdmin } from "../utils/groupRoles";
import {
  LINK_DURATIONS,
  createInviteLink,
  isLinkActive,
  linkUrl,
  listInviteLinks,
  revokeInviteLink,
  writeJoinPass,
} from "../utils/groupLinks";
import { emailNotificationsOff, notifyNewMessage } from "../utils/emailNotify";
import { extractFirstUrl } from "../utils/linkPreview";
import { handleMessageLinkClick } from "../utils/externalLink";
import { removeContact } from "../utils/contacts";
import { isCooldownActive, markLocalSend, nextMessageTimestamp } from "../utils/antiSpam";
import LinkPreviewCard from "../components/LinkPreviewCard";
import VerifiedBadge from "../components/VerifiedBadge";
import UserAvatar from "../components/UserAvatar";
import NicknameText from "../components/NicknameText";
import StickerPicker from "../components/StickerPicker";
import Sticker from "../stickers/Sticker";
import Gift from "../gifts/Gift";
import { giftPrice } from "../gifts/catalog";
import { searchUsersByTagPrefix } from "../utils/tagSearch";
import { sendSystemNotification } from "../utils/systemChat";
import { ensureChatExists } from "../utils/requestActions";
import { useLanguage } from "../i18n/LanguageContext";
import { equippedTextColor } from "../utils/cosmetics";
import { sendGiftToUser, sendStarsToUser } from "../utils/gifts";
import { InsufficientStarsError, sendErrorMessage, starsErrorMessage } from "../utils/errors";
import PhotoViewer from "../components/PhotoViewer";
import {
  bumpMessageProgress,
  claimDailyBonus,
  claimFirstStickerBonus,
  claimMessageMilestoneBonus,
  claimProfileBonus,
  DAILY_BONUS_REWARD,
  PROFILE_BONUS_REWARD,
  requestStarsPurchase,
  sendBotExchange,
  startEarning,
  touchActiveDay,
} from "../utils/stars";
import {
  buyKazikUnlock,
  buyWheelUnlock,
  hasKazikUnlocked,
  hasWheelUnlocked,
  KAZIK_PRICE,
  parseWheelArgs,
  rollKazik,
  rollWheel,
  sendKazikResult,
  sendWheelResult,
  STILLER_BOT_PROFILE,
  STILLER_BOT_UID,
  WHEEL_PRICE,
} from "../utils/stillerBot";
import {
  KAZINO_BOT_ID,
  KAZINO_WIN_CHANCE,
  MAX_CASINO_STAKE,
  MIN_CASINO_STAKE,
  playKazinoDeposit,
  sendKazinoDepositResult,
  validateStake,
} from "../utils/kazinoBot";
import { sendBotWelcome, sendCustomBotUserText } from "../utils/customBots";
import { buyBotCommand, hasUnlockedCommand, runAndSendCommandResult } from "../utils/customBotCommands";

const MAX_RECORD_SECONDS = 60;
const MAX_GROUP_MEMBERS = 50;

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds || 0));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function formatBytes(n, t) {
  if (!n && n !== 0) return "";
  if (n < 1024) return `${n} ${t("adminPanel.fileUnitBytes")}`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} ${t("adminPanel.fileUnitKB")}`;
  return `${(n / (1024 * 1024)).toFixed(1)} ${t("adminPanel.fileUnitMB")}`;
}

// Короткий текст превью сообщения ЛЮБОГО типа — используется и для
// lastMessage (превью в списке чатов), и для карточки цитаты при ответе
// (см. MessageRow -> replyTo). Как и остальные превью в проекте, считается
// на языке ОТПРАВИТЕЛЯ в момент отправки (сохраняется как обычный текст,
// не перевод "на лету") — тот же компромисс, что и везде без бэкенда.
function messagePreviewText(m, t) {
  if (!m) return "";
  if (m.stickerId) return t("chatWindow.stickerPreview");
  if (m.giftId) return t("chatWindow.giftPreview");
  if (m.starsAmount) return t("chatWindow.starsGiftPreview", { amount: m.starsAmount });
  if (m.audio) return t("chatWindow.voiceMessagePreview");
  if (m.fileMeta) {
    return m.fileMeta.mimeType?.startsWith("image/")
      ? t("chatWindow.photoPreview")
      : `📎 ${m.fileMeta.name}`;
  }
  if (m.type === "kazik_result") return t("stillerBot.kazikPreview");
  if (m.type === "wheel_result") return t("stillerBot.wheelPreview");
  if (m.type === "kazino_deposit_result") return t("kazinoBot.preview");
  return m.text || "";
}

function formatMessageTime(ts) {
  const date = ts?.toDate ? ts.toDate() : null;
  if (!date) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Превращает ссылки в тексте сообщения в кликабельные синие <a> — как в
// обычных мессенджерах. Внешние (не mymessage) ссылки идут через
// handleMessageLinkClick — сначала показываем предупреждение "вы покидаете
// платформу" (см. utils/externalLink.js); внутренние (например, ссылка-
// приглашение в группу) открываются напрямую.
function linkifyText(text) {
  if (!text) return text;
  const parts = String(text).split(/(https?:\/\/[^\s]+)/g);
  return parts.map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a
        key={i}
        href={part}
        target="_blank"
        rel="noopener noreferrer"
        className="msg-link"
        onClick={(e) => handleMessageLinkClick(e, part)}
      >
        {part}
      </a>
    ) : (
      part
    )
  );
}

// Текст системного уведомления считаем ЗАНОВО на языке того, кто его
// СЕЙЧАС читает (а не сохранённый текст на языке отправителя) — так
// заявка в друзья или приглашение в группу всегда отображаются на
// языке интерфейса получателя. Для site_update (свободный текст
// объявления от админа) заранее локализовать нечего — показываем как есть.
function systemMessageText(m, t) {
  if (m.type === "friend_request") {
    return t("systemNotif.friendRequest", { name: m.fromName || t("common.unknownUser") });
  }
  if (m.type === "friend_accepted") {
    return t("systemNotif.friendAccepted", { name: m.fromName || t("common.unknownUser") });
  }
  if (m.type === "group_invite") {
    return t("systemNotif.groupInvite", {
      name: m.fromName || t("common.unknownUser"),
      chatName: m.chatName || "",
    });
  }
  if (m.type === "stars_granted") {
    return t("systemNotif.starsGranted", { amount: m.amount || 0 });
  }
  if (m.type === "stars_blocked") {
    return t("systemNotif.starsBlocked");
  }
  if (m.type === "stars_unblocked") {
    return t("systemNotif.starsUnblocked");
  }
  if (m.type === "stars_deducted") {
    return t("systemNotif.starsDeducted", { amount: m.amount || 0 });
  }
  if (m.type === "gift_received") {
    return m.anonymous
      ? t("systemNotif.giftReceivedAnonymous")
      : t("systemNotif.giftReceived", { name: m.fromName || t("common.unknownUser") });
  }
  if (m.type === "stars_received") {
    return m.anonymous
      ? t("systemNotif.starsReceivedAnonymous", { amount: m.amount || 0 })
      : t("systemNotif.starsReceived", {
          name: m.fromName || t("common.unknownUser"),
          amount: m.amount || 0,
        });
  }
  if (m.type === "stars_earned") {
    const key = "systemNotif.starsEarned_" + (m.reason || "generic");
    return t(key, { amount: m.amount || 0 });
  }
  if (m.type === "device_login_request") {
    return t("systemNotif.deviceLoginRequest", { device: m.fromName || t("common.unknownDevice") });
  }
  return m.text;
}

// Фото/файл рендерится отдельным компонентом: сам следит за локальной
// (IndexedDB) копией и запрашивает файл из Firestore по клику "Скачать".
// Клик по уже скачанному фото открывает полноэкранную галерею (PhotoViewer)
// по всем фото этого чата, а не просто эту одну картинку в новой вкладке.
function FileBubble({ message, chatId, onOpenPhoto }) {
  const { t } = useLanguage();
  const fileTransfer = useFileTransfer();
  const [downloading, setDownloading] = useState(false);
  const local = fileTransfer.getLocalFile(message.id);
  const error = fileTransfer.getDownloadError(message.id);

  useEffect(() => {
    if (!local) fileTransfer.ensureLocalFile(message.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message.id, !!local]);

  async function handleDownloadClick() {
    setDownloading(true);
    await fileTransfer.requestFile(chatId, message.id);
    setDownloading(false);
  }

  const { fileMeta } = message;
  const isImage = (fileMeta.mimeType || "").startsWith("image/");

  if (local) {
    return isImage ? (
      <img
        src={local.url}
        alt={fileMeta.name}
        className="chat-image"
        onClick={() => onOpenPhoto(message.id)}
      />
    ) : (
      <a href={local.url} download={fileMeta.name} className="file-link">
        📎 {fileMeta.name} ({formatBytes(fileMeta.size, t)})
      </a>
    );
  }

  // Файла ещё нет локально на ЭТОМ устройстве — независимо от того, "моё"
  // это сообщение или нет: fileBlobs/{messageId} в Firestore читается по
  // членству в чате (см. firestore.rules), а не по тому, кто отправитель,
  // так что "Скачать" должно работать и для своих же сообщений — иначе
  // собственные фото становятся недоступны, стоит только открыть тот же чат
  // с другого устройства (где их, конечно, ещё нет в локальном IndexedDB).
  return (
    <div className="file-pending">
      <div>
        {isImage ? "🖼" : "📎"} {fileMeta.name} ({formatBytes(fileMeta.size, t)})
      </div>
      <button type="button" className="link-btn" disabled={downloading} onClick={handleDownloadClick}>
        {downloading ? t("chatWindow.downloading") : error ? t("chatWindow.retryDownload") : t("chatWindow.download")}
      </button>
      {error && (
        <span className="muted" style={{ fontSize: 12 }}>
          {error}
        </span>
      )}
    </div>
  );
}

// Сообщение-заявка в "Системных сообщениях" (заявка в друзья или
// приглашение в группу) — показывает кнопки "Принять"/"Отклонить" прямо на
// сообщении, пока связанный документ (friendRequests/groupInvites) в
// статусе pending, и статус-плашку после того, как на неё ответили. Это
// единственное место, где такие заявки можно принять — на странице
// "Друзья" теперь можно только отправлять заявки (см. FriendsSearch.jsx).
function SystemActionMessage({ message, myUid, profile }) {
  const { t } = useLanguage();
  const [refDoc, setRefDoc] = useState(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  const collectionName =
    message.type === "friend_request"
      ? "friendRequests"
      : message.type === "device_login_request"
        ? "deviceApprovals"
        : "groupInvites";

  useEffect(() => {
    if (!message.refId) return;
    const unsub = onSnapshot(doc(db, collectionName, message.refId), (snap) => {
      setRefDoc(snap.exists() ? { id: snap.id, ...snap.data() } : null);
    });
    return unsub;
  }, [message.refId, collectionName]);

  async function respond(accept) {
    if (!refDoc || busy) return;
    setBusy(true);
    setActionError("");
    try {
      if (message.type === "friend_request") {
        if (!accept) {
          await updateDoc(doc(db, "friendRequests", refDoc.id), { status: "declined" });
        } else {
          // Сначала создаём чат и только потом помечаем заявку принятой —
          // если создание чата не удастся, заявка останется "pending" и
          // можно будет попробовать ещё раз.
          await ensureChatExists(refDoc.from, refDoc.to);
          await updateDoc(doc(db, "friendRequests", refDoc.id), { status: "accepted" });
          try {
            await sendSystemNotification(refDoc.from, {
              type: "friend_accepted",
              text: `✅ ${message.fromName || t("common.unknownUser")} принял(а) вашу заявку в друзья`,
              fromName: message.fromName,
              actorUid: myUid,
            });
          } catch {
            // необязательно — дружба уже подтверждена, чат уже создан
          }
        }
      } else if (message.type === "device_login_request") {
        if (!accept) {
          await updateDoc(doc(db, "deviceApprovals", refDoc.id), { status: "blocked" });
        } else {
          const current = profile?.trustedDevices || [];
          if (!current.some((d) => d.id === refDoc.deviceId)) {
            await updateDoc(doc(db, "users", myUid), {
              trustedDevices: [
                ...current,
                { id: refDoc.deviceId, addedAt: Date.now(), label: refDoc.deviceLabel || null },
              ],
            });
          }
          await updateDoc(doc(db, "deviceApprovals", refDoc.id), { status: "approved" });
        }
      } else {
        if (!accept) {
          await updateDoc(doc(db, "groupInvites", refDoc.id), { status: "declined" });
        } else {
          // Порядок важен: пропуск на вступление выдаётся только под ПРИНЯТОЕ
          // приглашение, а добавление себя в участники требует уже готового
          // пропуска (см. firestore.rules -> joinPasses). Поэтому сначала
          // отмечаем приглашение принятым, затем пропуск, и только потом
          // вступаем.
          await updateDoc(doc(db, "groupInvites", refDoc.id), { status: "accepted" });
          await writeJoinPass(refDoc.chatId, myUid, "invite", refDoc.id);
          await updateDoc(doc(db, "chats", refDoc.chatId), { members: arrayUnion(myUid) });
        }
      }
    } catch (err) {
      setActionError(err.message || t("chatWindow.actionFailed"));
    } finally {
      setBusy(false);
    }
  }

  const isDevice = message.type === "device_login_request";
  const acceptLabel = isDevice
    ? t("chatWindow.allow")
    : message.type === "friend_request"
      ? t("chatWindow.accept")
      : t("chatWindow.join");
  const declineLabel = isDevice ? t("chatWindow.block") : t("chatWindow.decline");

  return (
    <div>
      <div>{linkifyText(systemMessageText(message, t))}</div>
      {message.refId && refDoc?.status === "pending" && (
        <div className="row-buttons" style={{ marginTop: 8 }}>
          <button type="button" disabled={busy} onClick={() => respond(true)}>
            {acceptLabel}
          </button>
          <button type="button" className="secondary" disabled={busy} onClick={() => respond(false)}>
            {declineLabel}
          </button>
        </div>
      )}
      {message.refId && refDoc?.status === "accepted" && (
        <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>{t("chatWindow.accepted")}</div>
      )}
      {message.refId && refDoc?.status === "declined" && (
        <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>{t("chatWindow.declined")}</div>
      )}
      {message.refId && refDoc?.status === "approved" && (
        <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>{t("chatWindow.allowed")}</div>
      )}
      {message.refId && refDoc?.status === "blocked" && (
        <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>{t("chatWindow.blockedDevice")}</div>
      )}
      {actionError && (
        <div className="error" style={{ marginTop: 6, fontSize: 12 }}>
          {actionError}
        </div>
      )}
    </div>
  );
}

// Кнопка-действие ПОД последним ответом бота Stars — "Начать заработок"
// после объяснения условий, "Отправить запрос" после объяснения покупки.
// Показывается только под самым свежим сообщением бота, чтобы не плодить
// одинаковые кнопки под всей историей переписки.
function BotCtaButtons({ msgKey, chatId, uid, profile, name }) {
  const { t } = useLanguage();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  const [error, setError] = useState("");

  if (msgKey === "how_to_earn" && !profile?.starsProgress?.earningEnabled) {
    return (
      <div className="row-buttons" style={{ marginTop: 8 }}>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await startEarning(uid);
              await sendBotExchange(chatId, uid, {
                userText: t("botChat.startEarningBtn"),
                botKey: "start_earning",
                botText: t("botChat.startEarningConfirm"),
              });
            } catch (err) {
              setError(err.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("botChat.startEarningBtn")}
        </button>
        {error && <div className="error" style={{ fontSize: 12 }}>{error}</div>}
      </div>
    );
  }

  if (msgKey === "how_to_buy") {
    return (
      <div className="row-buttons" style={{ marginTop: 8 }}>
        <button
          type="button"
          disabled={busy || !!done}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              const result = await requestStarsPurchase(uid, name);
              const botText =
                result === "already_pending"
                  ? t("botChat.purchaseAlreadySent")
                  : t("botChat.purchaseSent");
              await sendBotExchange(chatId, uid, {
                userText: t("botChat.sendPurchaseRequestBtn"),
                botKey: "purchase_requested",
                botText,
              });
              setDone(result);
            } catch (err) {
              setError(err.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("botChat.sendPurchaseRequestBtn")}
        </button>
        {error && <div className="error" style={{ fontSize: 12 }}>{error}</div>}
      </div>
    );
  }

  return null;
}

// Ряд стартовых кнопок вместо строки ввода текста в чате с ботом Stars —
// писать боту напрямую нельзя, только выбирать из готовых сценариев
// (см. utils/stars.js -> sendBotExchange и firestore.rules). "Ежедневный
// бонус" и "Бонус за анкету" — два "активных" способа заработка из четырёх
// новых (см. utils/stars.js) — сразу начисляют звёзды по нажатию, а не
// просто объясняют условия, как остальные три кнопки.
function BotComposeRow({ chatId, uid, profile }) {
  const { t } = useLanguage();
  const [busy, setBusy] = useState(false);

  async function tap(userKey, botKey, textKey) {
    if (busy) return;
    setBusy(true);
    try {
      await sendBotExchange(chatId, uid, {
        userText: t(`botChat.${userKey}`),
        botKey,
        botText: t(`botChat.${textKey}`),
      });
    } finally {
      setBusy(false);
    }
  }

  async function claimDaily() {
    if (busy) return;
    setBusy(true);
    try {
      const result = await claimDailyBonus(uid, profile);
      const botText =
        result === "granted"
          ? t("botChat.dailyBonusGranted", { amount: DAILY_BONUS_REWARD })
          : result === "blocked"
            ? t("botChat.dailyBonusBlocked")
            : t("botChat.dailyBonusAlready");
      await sendBotExchange(chatId, uid, {
        userText: t("botChat.dailyBonusBtn"),
        botKey: "daily_bonus",
        botText,
      });
    } finally {
      setBusy(false);
    }
  }

  async function claimProfile() {
    if (busy) return;
    setBusy(true);
    try {
      const result = await claimProfileBonus(uid, profile);
      const botText =
        result === "granted"
          ? t("botChat.profileBonusGranted", { amount: PROFILE_BONUS_REWARD })
          : result === "blocked"
            ? t("botChat.dailyBonusBlocked")
            : result === "incomplete"
              ? t("botChat.profileBonusIncomplete")
              : t("botChat.profileBonusAlready");
      await sendBotExchange(chatId, uid, {
        userText: t("botChat.profileBonusBtn"),
        botKey: "profile_bonus",
        botText,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="send-row" style={{ flexWrap: "wrap", gap: 8 }}>
      <button type="button" disabled={busy} onClick={() => tap("whatIsThisBtn", "what_is_this", "whatIsThisText")}>
        {t("botChat.whatIsThisBtn")}
      </button>
      <button type="button" disabled={busy} onClick={() => tap("howToEarnBtn", "how_to_earn", "howToEarnText")}>
        {t("botChat.howToEarnBtn")}
      </button>
      <button type="button" disabled={busy} onClick={claimDaily}>
        {t("botChat.dailyBonusBtn")}
      </button>
      <button type="button" disabled={busy} onClick={claimProfile}>
        {t("botChat.profileBonusBtn")}
      </button>
      <button type="button" disabled={busy} onClick={() => tap("howToBuyBtn", "how_to_buy", "howToBuyText")}>
        {t("botChat.howToBuyBtn")}
      </button>
    </div>
  );
}

const KAZINO_SPIN_MS = 1600;

// Строка ввода для чата с @kazino_bot — ПОЛНОСТЬЮ заменяет обычную строку
// ввода текста (как и BotComposeRow у @stars_bot), потому что этот чат
// существует только ради одной игры. В отличие от прежней версии внутри
// @stiller_bot, ставка вводится числом (любая, см. utils/kazinoBot.js ->
// validateStake), а не фиксирована. Компонент полностью самодостаточен
// (своё состояние спина/ошибки, свой таймер) — тем же приёмом, что и
// CustomBotComposeRow ниже, чтобы не тащить это состояние через весь
// ChatWindow.
function KazinoComposeRow({ chatId, uid, profile, t }) {
  const [showInfo, setShowInfo] = useState(false);
  const [stakeInput, setStakeInput] = useState("");
  const [spinning, setSpinning] = useState(false);
  const [error, setError] = useState("");
  const spinTimeoutRef = useRef(null);

  useEffect(
    () => () => {
      if (spinTimeoutRef.current) clearTimeout(spinTimeoutRef.current);
    },
    []
  );

  function stakeErrorMessage(validation) {
    if (validation.reason === "insufficient") {
      return starsErrorMessage(new InsufficientStarsError(validation.missing), t);
    }
    if (validation.reason === "too_big") {
      return t("kazinoBot.stakeTooBig", { max: validation.max });
    }
    return t("kazinoBot.stakeInvalid");
  }

  function handleDeposit() {
    setError("");
    const validation = validateStake(stakeInput, profile?.stars || 0);
    if (!validation.ok) {
      setError(stakeErrorMessage(validation));
      return;
    }
    setSpinning(true);
    spinTimeoutRef.current = setTimeout(async () => {
      spinTimeoutRef.current = null;
      setSpinning(false);
      try {
        const result = await playKazinoDeposit(uid, profile, validation.stake);
        await sendKazinoDepositResult(chatId, uid, profile?.name, result);
        setStakeInput("");
      } catch (err) {
        setError(starsErrorMessage(err, t));
      }
    }, KAZINO_SPIN_MS);
  }

  function cancelSpin() {
    if (spinTimeoutRef.current) {
      clearTimeout(spinTimeoutRef.current);
      spinTimeoutRef.current = null;
    }
    setSpinning(false);
  }

  if (spinning) {
    return (
      <div className="stiller-bot-banner">
        <div className="stiller-bot-banner-text">
          <span className="stiller-bot-banner-icon">🎲</span>
          <span>{t("kazinoBot.bannerText")}</span>
        </div>
        <button type="button" className="secondary" onClick={cancelSpin}>
          {t("stillerBot.bannerCancel")}
        </button>
      </div>
    );
  }

  return (
    <div className="stiller-casino-row">
      <div className="row-buttons" style={{ marginTop: 0, flexWrap: "wrap" }}>
        <button type="button" className="secondary" onClick={() => setShowInfo((v) => !v)}>
          {t("kazinoBot.whatIsThisBtn")}
        </button>
        <input
          type="number"
          min={MIN_CASINO_STAKE}
          max={MAX_CASINO_STAKE}
          value={stakeInput}
          onChange={(e) => setStakeInput(e.target.value)}
          placeholder={t("kazinoBot.stakePlaceholder")}
          style={{ width: 90 }}
        />
        <button type="button" disabled={!stakeInput} onClick={handleDeposit}>
          {t("kazinoBot.depositBtn")}
        </button>
      </div>
      {showInfo && (
        <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>
          {t("kazinoBot.infoText", { chance: Math.round(KAZINO_WIN_CHANCE * 100), max: MAX_CASINO_STAKE })}
        </div>
      )}
      {error && (
        <div className="error" style={{ fontSize: 12, marginTop: 6 }}>
          {error}
        </div>
      )}
    </div>
  );
}

// Понятный текст ошибки покупки/выполнения платной команды (см.
// utils/customBotCommands.js -> buyBotCommand — коды ошибок без бэкенда,
// просто маркеры, откуда именно отказ).
function botCommandErrorMessage(err, t) {
  if (err?.code === "insufficient_stars") return t("stickers.notEnoughStars", { missing: err.missing });
  if (err?.message === "bot_key_missing" || err?.message === "bot_key_revoked") {
    return t("customBots.paidCommandKeyError");
  }
  if (err?.message === "unknown_command") return t("customBots.paidCommandUnknown");
  return err?.message || String(err);
}

// Строка ввода для чата с пользовательским ботом (см. utils/customBots.js) —
// в отличие от BotComposeRow выше (только фиксированные кнопки для @stars_bot),
// тут можно писать любой текст: подбор ответа целиком на клиенте
// (matchBotRule/runScript внутри sendCustomBotUserText), никакого бэкенда за
// этим нет. Платные команды (см. bot.paidCommands, botScript.js -> "command
// ... cost N:") — доступны только у бота с ключом (см. utils/botKeys.js) и
// покупаются прямо тут же, инлайн, а не в Магазине (см. обсуждение с
// пользователем) — тем же капped-delta паттерном, что и /kazik-/wheel-
// команды @stiller_bot ниже в ChatWindow.
function CustomBotComposeRow({ chatId, uid, bot, profile }) {
  const { t } = useLanguage();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pendingCommand, setPendingCommand] = useState(null); // {trigger, cost, raw}
  const [buying, setBuying] = useState(false);
  const [running, setRunning] = useState(false); // "бот выполняет команду" — та же идея, что и StillerGameBanner

  function findPaidCommand(raw) {
    const norm = raw.trim().toLowerCase();
    return (bot?.paidCommands || []).find((c) => c.trigger.toLowerCase() === norm) || null;
  }

  async function runCommand(trigger, raw) {
    setRunning(true);
    try {
      await runAndSendCommandResult(chatId, bot, uid, trigger, raw);
    } finally {
      setRunning(false);
    }
  }

  async function send(inputText) {
    const clean = (inputText ?? text).trim();
    if (!clean || busy) return;
    const cmd = findPaidCommand(clean);
    if (cmd && !hasUnlockedCommand(profile, bot.id, cmd.trigger)) {
      setPendingCommand({ ...cmd, raw: clean });
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (cmd) {
        await runCommand(cmd.trigger, clean);
      } else {
        await sendCustomBotUserText(chatId, bot, uid, clean);
      }
      setText("");
    } catch (err) {
      setError(botCommandErrorMessage(err, t));
    } finally {
      setBusy(false);
    }
  }

  async function handleBuyPending() {
    if (!pendingCommand) return;
    setBuying(true);
    setError("");
    try {
      await buyBotCommand(uid, profile, bot, pendingCommand.trigger);
      const raw = pendingCommand.raw;
      const trigger = pendingCommand.trigger;
      setPendingCommand(null);
      setBusy(true);
      await runCommand(trigger, raw);
      setText("");
    } catch (err) {
      setError(botCommandErrorMessage(err, t));
    } finally {
      setBuying(false);
      setBusy(false);
    }
  }

  return (
    <>
      {running && (
        <div className="stiller-bot-banner">
          <div className="stiller-bot-banner-text">
            <span className="stiller-bot-banner-icon">🤖</span>
            <span>{t("customBots.botRunningBanner")}</span>
          </div>
        </div>
      )}
      {pendingCommand && (
        <div className="locked-command-row">
          <span>{t("customBots.paidCommandLocked", { trigger: pendingCommand.trigger })}</span>
          <button type="button" disabled={buying} onClick={handleBuyPending}>
            {t("customBots.paidCommandBuyBtn", { price: pendingCommand.cost })}
          </button>
          <button type="button" className="secondary" disabled={buying} onClick={() => setPendingCommand(null)}>
            {t("chatWindow.cancelEdit")}
          </button>
        </div>
      )}
      <div className="send-row">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={t("customBots.chatInputPlaceholder")}
          disabled={busy}
        />
        <button type="button" disabled={busy || !text.trim()} onClick={() => send()}>
          {t("chatWindow.send")}
        </button>
      </div>
      {error && <div className="error" style={{ fontSize: 12 }}>{error}</div>}
    </>
  );
}

// Результат /kazik — три "барабана" (эмодзи) и, если все три совпали,
// подпись "Вы выиграли!" (см. utils/stillerBot.js -> rollKazik). Чисто
// косметическое сообщение — никаких звёзд или призов тут не начисляется.
function KazikResultBubble({ m, t }) {
  return (
    <div className="kazik-result-bubble">
      {m.triggeredByName && (
        <div className="stiller-triggered-by">
          {t("stillerBot.kazikTriggeredBy", { name: m.triggeredByName })}
        </div>
      )}
      <div className="kazik-reels">
        {(m.reels || []).map((sym, i) => (
          <span key={i}>{sym}</span>
        ))}
      </div>
      {m.won ? (
        <div className="kazik-win-label">{t("stillerBot.kazikWin")}</div>
      ) : (
        <div className="muted" style={{ fontSize: 12 }}>
          {t("stillerBot.kazikLose")}
        </div>
      )}
    </div>
  );
}

// Результат колеса фортуны — просто показывает, на каком секторе оно
// остановилось (см. utils/stillerBot.js -> rollWheel).
function WheelResultBubble({ m, t }) {
  const label = m.segments?.[m.resultIndex] ?? "?";
  return (
    <div className="wheel-result-bubble">
      {m.triggeredByName && (
        <div className="stiller-triggered-by">
          {t("stillerBot.wheelTriggeredBy", { name: m.triggeredByName })}
        </div>
      )}
      <div style={{ fontSize: 28 }}>🎡</div>
      <div className="wheel-result-label">{label}</div>
    </div>
  );
}

// Результат "депа" в казино @kazino_bot — в отличие от KazikResultBubble/
// WheelResultBubble выше (косметика без ставок), это НАСТОЯЩАЯ игра со
// ставками (см. utils/kazinoBot.js -> playKazinoDeposit): показываем и
// ставку, и итог (выигрыш/проигрыш) с точной суммой.
function KazinoResultBubble({ m, t }) {
  return (
    <div className="kazik-result-bubble">
      {m.triggeredByName && (
        <div className="stiller-triggered-by">
          {t("kazinoBot.triggeredBy", { name: m.triggeredByName })}
        </div>
      )}
      <div style={{ fontSize: 28 }}>🎲</div>
      {m.won ? (
        <div className="kazik-win-label">
          {t("kazinoBot.win", { amount: (m.payout || 0) - (m.staked || 0) })}
        </div>
      ) : (
        <div className="muted" style={{ fontSize: 12 }}>
          {t("kazinoBot.lose", { amount: m.staked || 0 })}
        </div>
      )}
    </div>
  );
}

// Баннер "бот управляет этим чатом" — показывается, пока крутится /kazik
// или колесо фортуны (см. ChatWindow -> activeGame ниже), с кнопкой отмены
// (отменяет саму отправку результата, если ещё не поздно). "Деп" в казино
// @kazino_bot использует свой собственный, полностью самодостаточный
// баннер — см. KazinoComposeRow выше.
function StillerGameBanner({ game, onCancel, t }) {
  if (!game) return null;
  return (
    <div className="stiller-bot-banner">
      <div className="stiller-bot-banner-text">
        <span className="stiller-bot-banner-icon">{game.kind === "wheel" ? "🎡" : "🎰"}</span>
        <span>{t("stillerBot.bannerText")}</span>
      </div>
      <button type="button" className="secondary" onClick={onCancel}>
        {t("stillerBot.bannerCancel")}
      </button>
    </div>
  );
}

const SWIPE_TRIGGER_PX = 44;
const SWIPE_MAX_PX = 68;
// Лимит длины текста при редактировании уже отправленного сообщения — то
// же значение, что и в firestore.rules -> messages allow update (у самой
// отправки текста своего лимита исторически нет, но здесь ограничиваем,
// чтобы не разъезжалось с правилами).
const MAX_MESSAGE_EDIT_LEN = 4000;

// Один "ряд" сообщения — вынесен в отдельный компонент (а не остаётся
// прямо внутри .map() в ChatWindow), потому что свайпу для ответа нужно
// своё локальное состояние (смещение перетаскивания) на каждое сообщение
// отдельно, а хуки внутри .map()-колбэка заводить нельзя.
//
// Жест — как в Telegram/WhatsApp: у чужих сообщений тянем вправо, у своих
// влево (в сторону текста), при превышении SWIPE_TRIGGER_PX отпускание
// вызывает onReply. Клики по ссылкам/кнопкам внутри пузыря не страдают —
// pointermove/up не мешают им, пока свайп не начался всерьёз.
function MessageRow({
  m,
  mine,
  isLast,
  isGroup,
  isSystem,
  isBotChat,
  showGroupAvatar,
  membersById,
  textColor,
  chatId,
  user,
  t,
  profile,
  readStatus,
  onReply,
  onDelete,
  onEdit,
  onForward,
  onOpenPhoto,
  onCustomBotButton,
}) {
  const [dragX, setDragX] = useState(0);
  const dragRef = useRef({ startX: 0, dragging: false });
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState("");

  // Редактировать можно только своё обычное текстовое сообщение — без
  // 'type' (у стикеров/подарков/файлов/голосовых/ответов ботов/результатов
  // мини-игр всегда есть 'type' или своё поле-маркер, см. addDoc-вызовы
  // в ChatWindow.jsx ниже и firestore.rules -> messages allow update).
  const canEdit = mine && !isBotChat && !isSystem && typeof m.text === "string" && !m.type;

  // Переслать (как в Телеграме) можно обычные сообщения — текст, стикер,
  // голосовое, фото/файл — и своё, и чужое. Нарочно НЕ разрешаем пересылку
  // подарков/переводов звёзд (giftId/starsAmount) — это не просто "контент",
  // а отметка о реально прошедшей операции со звёздами (см. utils/gifts.js),
  // пересылать её как обычное сообщение было бы вводящим в заблуждение.
  // Всё с 'type' (ответы ботов, результаты игр, служебные заметки о
  // звонках) тоже не пересылается — это не то, что человек "написал".
  const canForward = !isSystem && !isBotChat && !m.type && !m.giftId && !m.starsAmount;

  function startEdit() {
    setEditText(m.text);
    setEditError("");
    setEditing(true);
  }

  async function saveEdit() {
    const value = editText.trim();
    if (!value) return;
    setEditSaving(true);
    setEditError("");
    try {
      await onEdit(m, value);
      setEditing(false);
    } catch (err) {
      setEditError(err.message);
    } finally {
      setEditSaving(false);
    }
  }

  function onPointerDown(e) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    dragRef.current = { startX: e.clientX, dragging: true };
  }
  function onPointerMove(e) {
    const st = dragRef.current;
    if (!st.dragging) return;
    const delta = e.clientX - st.startX;
    const allowed = mine ? Math.min(0, delta) : Math.max(0, delta);
    setDragX(Math.max(-SWIPE_MAX_PX, Math.min(SWIPE_MAX_PX, allowed)));
  }
  function endDrag() {
    const st = dragRef.current;
    if (!st.dragging) return;
    st.dragging = false;
    if (Math.abs(dragX) >= SWIPE_TRIGGER_PX) {
      onReply(m);
      navigator.vibrate?.(15);
    }
    setDragX(0);
  }

  function scrollToReply() {
    if (!m.replyTo?.messageId) return;
    const el = document.querySelector(`[data-message-id="${m.replyTo.messageId}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("bubble-row-highlight");
    setTimeout(() => el.classList.remove("bubble-row-highlight"), 1200);
  }

  const firstUrl = !isSystem && !m.stickerId && !m.giftId && !m.fileMeta && !m.audio ? extractFirstUrl(m.text) : null;

  return (
    <div
      className={"bubble-row " + (mine ? "mine" : "theirs")}
      data-message-id={m.id}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      style={{
        transform: dragX ? `translateX(${dragX}px)` : undefined,
        touchAction: "pan-y",
      }}
    >
      {Math.abs(dragX) > 10 && (
        <span className={"swipe-reply-hint " + (mine ? "left" : "right")}>↩</span>
      )}
      {isGroup &&
        !mine &&
        (showGroupAvatar ? (
          <UserAvatar
            profile={membersById[m.senderId]}
            fallback={firstChar(membersById[m.senderId]?.name)}
            size={28}
          />
        ) : (
          <span style={{ width: 28, flexShrink: 0 }} />
        ))}
      <div
        className={
          "bubble " +
          (mine ? "mine" : "theirs") +
          (m.stickerId || m.giftId ? " bubble-sticker" : "") +
          (m.starsAmount ? " bubble-stars-gift" : "")
        }
      >
        {isGroup && !mine && (
          <div className="bubble-sender">
            <NicknameText profile={membersById[m.senderId]}>
              {membersById[m.senderId]?.name || "..."}
            </NicknameText>
          </div>
        )}
        {m.forwardedFrom && (
          <div className="forwarded-label">
            ↪ {t("chatWindow.forwardedFromLabel")}{" "}
            <b>
              {m.forwardedFrom.senderId === user.uid
                ? t("chatWindow.you")
                : m.forwardedFrom.senderName || t("common.unknownUser")}
            </b>
          </div>
        )}
        {m.replyTo && (
          <div className="reply-quote" onClick={scrollToReply}>
            <b>{m.replyTo.senderId === user.uid ? t("chatWindow.you") : m.replyTo.senderName || t("common.unknownUser")}</b>
            <div className="reply-quote-text">{m.replyTo.preview}</div>
          </div>
        )}
        {m.stickerId ? (
          <Sticker id={m.stickerId} size={84} />
        ) : m.giftId ? (
          <div className="gift-bubble-content">
            <Gift id={m.giftId} size={84} />
            <span className="gift-bubble-price">⭐ {giftPrice(m.giftId)}</span>
          </div>
        ) : m.starsAmount ? (
          <span className="stars-gift-amount">⭐ {m.starsAmount}</span>
        ) : m.audio ? (
          <audio controls className="voice-bubble-audio" src={`data:${m.mimeType};base64,${m.audio}`} />
        ) : m.fileMeta ? (
          <FileBubble message={m} chatId={chatId} onOpenPhoto={onOpenPhoto} />
        ) : m.type === "call_missed" || m.type === "call_declined" || m.type === "call_ended" ? (
          <span
            className={
              "call-note" + (m.type === "call_missed" || m.type === "call_declined" ? " call-note-missed" : "")
            }
          >
            {m.type === "call_ended" ? "📞" : "📵"}{" "}
            {m.type === "call_missed"
              ? t("chatWindow.callMissedNote")
              : m.type === "call_declined"
              ? t("chatWindow.callDeclinedNote")
              : m.groupCall
              ? // Заметка о завершённом ГРУППОВОМ звонке (см.
                // contexts/GroupCallContext.jsx -> postGroupCallNote)
                `${t("groupCalls.chatNote")} · ${formatDuration(m.durationSec || 0)}`
              : t("chatWindow.callEndedNote", { duration: formatDuration(m.durationSec || 0) })}
          </span>
        ) : m.type === "kazik_result" ? (
          <KazikResultBubble m={m} t={t} />
        ) : m.type === "wheel_result" ? (
          <WheelResultBubble m={m} t={t} />
        ) : m.type === "kazino_deposit_result" ? (
          <KazinoResultBubble m={m} t={t} />
        ) : isSystem && m.refId && (m.type === "friend_request" || m.type === "group_invite" || m.type === "device_login_request") ? (
          <SystemActionMessage message={m} myUid={user.uid} profile={profile} />
        ) : isSystem ? (
          linkifyText(systemMessageText(m, t))
        ) : editing ? (
          <div className="edit-message-row">
            <textarea
              autoFocus
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              maxLength={MAX_MESSAGE_EDIT_LEN}
              rows={2}
            />
            {editError && <div className="error" style={{ fontSize: 12 }}>{editError}</div>}
            <div className="row-buttons">
              <button type="button" disabled={editSaving || !editText.trim()} onClick={saveEdit}>
                {editSaving ? t("chatWindow.saving") : t("chatWindow.saveEdit")}
              </button>
              <button type="button" className="secondary" onClick={() => setEditing(false)} disabled={editSaving}>
                {t("chatWindow.cancelEdit")}
              </button>
            </div>
          </div>
        ) : (
          <>
            <span style={textColor ? { color: textColor } : undefined}>{linkifyText(m.text)}</span>
            {firstUrl && <LinkPreviewCard url={firstUrl} />}
          </>
        )}
        {isBotChat && !mine && m.type === "bot_reply" && isLast && (
          <BotCtaButtons msgKey={m.key} chatId={chatId} uid={user.uid} profile={profile} name={profile?.name} />
        )}
        {/* Кнопки быстрого ответа пользовательского бота (см. utils/customBots.js
            -> sendCustomBotUserText) — клик "печатает" trigger кнопки тем же
            путём, что и обычный ввод текста. Оставляем кликабельными под всей
            историей (не только последним ответом), как обычная inline-клавиатура
            в Телеграме, а не одноразовый CTA вроде BotCtaButtons выше. */}
        {!mine && m.type === "custom_bot_reply" && m.buttons?.length > 0 && (
          <div className="row-buttons" style={{ marginTop: 8, flexWrap: "wrap" }}>
            {m.buttons.map((b, i) => (
              <button key={i} type="button" onClick={() => onCustomBotButton?.(b.trigger)}>
                {b.label}
              </button>
            ))}
          </div>
        )}
        {!isSystem && m.createdAt && (
          <div className="bubble-meta">
            {m.edited && <span className="bubble-edited-tag">{t("chatWindow.editedLabel")}</span>}
            <span className="bubble-time">{formatMessageTime(m.createdAt)}</span>
            {mine && !isBotChat && (
              <span className={"bubble-check " + (readStatus === "read" ? "read" : "")}>
                {readStatus === "read" ? "✓✓" : "✓"}
              </span>
            )}
          </div>
        )}
      </div>
      {canForward && !editing && (
        <button className="bubble-forward" title={t("chatWindow.forwardMessage")} onClick={() => onForward(m)}>
          ↪
        </button>
      )}
      {mine && !isBotChat && !editing && (
        <>
          {canEdit && (
            <button className="bubble-edit" title={t("chatWindow.editMessage")} onClick={startEdit}>
              ✎
            </button>
          )}
          <button className="bubble-delete" title={t("chatWindow.deleteMessage")} onClick={() => onDelete(m)}>
            ✕
          </button>
        </>
      )}
    </div>
  );
}

export default function ChatWindow() {
  const { chatId } = useParams();
  const { user, profile } = useAuth();
  const { t } = useLanguage();
  const fileTransfer = useFileTransfer();
  const { callState, startCall } = useCall();
  const { startGroupCall, joinGroupCall, inviteToCall, inGroupCall, groupCall } = useGroupCall();
  const [messages, setMessages] = useState([]);
  const [other, setOther] = useState(null);
  const [chatMeta, setChatMeta] = useState(null);
  const [membersById, setMembersById] = useState({});
  const [text, setText] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [voiceError, setVoiceError] = useState("");
  const [showManage, setShowManage] = useState(false);
  // Удаление группы — необратимое и для всех сразу, поэтому отдельный
  // подтверждающий экран, а не window.confirm: на больших группах удаление
  // идёт заметное время, и надо показывать, сколько уже вычищено.
  const [showDeleteGroup, setShowDeleteGroup] = useState(false);
  const [deletingGroup, setDeletingGroup] = useState(false);
  const [deleteProgress, setDeleteProgress] = useState(0);
  // Групповой звонок в этой группе (см. contexts/GroupCallContext.jsx):
  // liveGroupCall — идущий прямо сейчас звонок, если он есть; из него растут
  // и плашка "Идёт звонок · присоединиться", и кнопка 📞 в шапке группы.
  const [liveGroupCall, setLiveGroupCall] = useState(null);
  // Связь с базой потеряна (см. подписку на сообщения ниже) и сколько своих
  // сообщений ещё не ушло на сервер.
  const [offlineMode, setOfflineMode] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [showGroupCallPicker, setShowGroupCallPicker] = useState(false);
  const [callPermBusy, setCallPermBusy] = useState(false);
  // Когда в последний раз пробовали разобрать "мёртвый" звонок. Не просто
  // "сейчас разбираем", а именно время: если запись отклонят правила, Firestore
  // откатывает её локально — прилетает новый снапшот, и без паузы получился бы
  // цикл "снапшот → запись → отказ → снапшот" на полной скорости сети.
  const closingCallsRef = useRef(new Map());
  const [renameValue, setRenameValue] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [addTagInput, setAddTagInput] = useState("");
  const [addTagResult, setAddTagResult] = useState(null);
  const [addTagSuggestions, setAddTagSuggestions] = useState([]);
  const [contactIds, setContactIds] = useState(() => new Set());
  const [addSuccessMsg, setAddSuccessMsg] = useState("");
  const [linkCopied, setLinkCopied] = useState(false);
  // Ссылки-приглашения группы и форма создания новой.
  const [links, setLinks] = useState([]);
  const [linksBusy, setLinksBusy] = useState(false);
  const [linkDuration, setLinkDuration] = useState("1d");
  const [linkForTag, setLinkForTag] = useState("");
  const [copiedLinkId, setCopiedLinkId] = useState("");
  // Назначение администраторов и настройка их прав (только для владельца).
  const [rolesBusy, setRolesBusy] = useState(false);
  const [manageError, setManageError] = useState("");
  const [attachError, setAttachError] = useState("");
  const [showStickerPicker, setShowStickerPicker] = useState(false);
  const [stickerError, setStickerError] = useState("");
  const [giftError, setGiftError] = useState("");
  // /kazik и колесо фортуны бота @stiller_bot (см. utils/stillerBot.js) —
  // activeGame не пишется в Firestore, это чисто локальное состояние
  // "крутится анимация" на время KAZIK_SPIN_MS/WHEEL_SPIN_MS, после чего
  // результат отправляется одним сообщением.
  const [activeGame, setActiveGame] = useState(null);
  const [commandError, setCommandError] = useState("");
  // /kazik и /wheel без покупки — вместо голого текста об ошибке (было
  // раньше) показываем инлайн-кнопку "Купить" прямо в чате (см. обсуждение
  // с пользователем — покупка должна быть "в этом стиле бот", не в
  // Магазине). pendingSegments — уже разобранные аргументы /wheel, чтобы
  // после покупки не переспрашивать их заново.
  const [lockedCommand, setLockedCommand] = useState(null); // {kind: 'kazik'|'wheel', pendingSegments}
  const [buyingLocked, setBuyingLocked] = useState(false);
  const gameTimeoutRef = useRef(null);
  const [showActions, setShowActions] = useState(false);
  const [actionsError, setActionsError] = useState("");
  const [showProfileCard, setShowProfileCard] = useState(false);
  const [iBlockedThem, setIBlockedThem] = useState(false);
  const [theyBlockedMe, setTheyBlockedMe] = useState(false);
  const [replyTo, setReplyTo] = useState(null);
  // Пересылка сообщений (как в Телеграме) — см. openForward/handleForwardConfirm
  // ниже. forwardMessage — какое сообщение сейчас пересылаем (модалка открыта,
  // если не null), forwardChats — список чатов пользователя для выбора,
  // forwardSelected — выбранные id чатов-получателей.
  const [forwardMessage, setForwardMessage] = useState(null);
  const [forwardChats, setForwardChats] = useState([]);
  const [forwardChatsLoading, setForwardChatsLoading] = useState(false);
  const [forwardSelected, setForwardSelected] = useState(() => new Set());
  const [forwardSending, setForwardSending] = useState(false);
  const [forwardError, setForwardError] = useState("");
  const [forwardDone, setForwardDone] = useState(false);
  const [typingTick, setTypingTick] = useState(() => Date.now());
  // Индекс открытого фото в полноэкранной галерее (PhotoViewer) — индекс в
  // массиве ВСЕХ фото-сообщений этого чата (chatImages ниже), не в messages.
  // null — галерея закрыта.
  const [photoViewerIndex, setPhotoViewerIndex] = useState(null);
  const [clearRequestBusy, setClearRequestBusy] = useState(false);
  const [clearRequestError, setClearRequestError] = useState("");
  const bottomRef = useRef(null);
  const navigate = useNavigate();
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const recordTimerRef = useRef(null);
  const recordSecondsRef = useRef(0);
  const cancelledRef = useRef(false);
  const fileInputRef = useRef(null);
  const typingSentAtRef = useRef(0);
  const lastReadSentForRef = useRef(null);
  const botWelcomeSentForRef = useRef(null);

  useEffect(() => {
    const q = query(collection(db, "chats", chatId, "messages"), orderBy("createdAt", "asc"));
    // includeMetadataChanges — чтобы знать, живое ли соединение с базой.
    // Firestore при обрыве связи продолжает работать "из кэша": отправленные
    // сообщения показываются как обычно и молча ждут в очереди, а собеседник
    // их не получает. Без этой отметки человек уверен, что всё отправилось —
    // именно так выглядит жалоба "мои сообщения не доходят" (см. плашку
    // chatWindow.offlineBanner ниже и firebase.js -> long polling).
    const unsub = onSnapshot(q, { includeMetadataChanges: true }, (snap) => {
      setMessages(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      setOfflineMode(snap.metadata.fromCache && !snap.metadata.hasPendingWrites);
      setPendingCount(snap.docs.filter((d) => d.metadata.hasPendingWrites).length);
    });
    return unsub;
  }, [chatId]);

  // Приветствие пользовательского бота — один раз при первом заходе в пустой
  // чат с ним (см. utils/customBots.js -> sendBotWelcome). botWelcomeSentForRef
  // защищает от повторной отправки, пока подписка на messages ещё не успела
  // догнать только что созданное приветствие (иначе "messages.length === 0"
  // ненадолго осталось бы истинным ещё раз при повторном рендере).
  useEffect(() => {
    if (!chatMeta?.isBotChat || !other?.isCustomBot || !other?.welcomeReply) return;
    if (messages.length > 0) return;
    if (botWelcomeSentForRef.current === chatId) return;
    botWelcomeSentForRef.current = chatId;
    sendBotWelcome(chatId, other.id, other.welcomeReply).catch(() => {
      botWelcomeSentForRef.current = null;
    });
  }, [chatId, chatMeta?.isBotChat, other, messages.length]);

  // Переключились на другой чат, пока крутился /kazik или колесо, — не
  // отправляем результат туда, откуда уже ушли.
  useEffect(() => {
    setActiveGame(null);
    setCommandError("");
    return () => {
      if (gameTimeoutRef.current) {
        clearTimeout(gameTimeoutRef.current);
        gameTimeoutRef.current = null;
      }
    };
  }, [chatId]);

  // Подписка на сам чат (нужна и для личных чатов, и для групп — там могут
  // меняться название/состав участников, пока открыто окно).
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "chats", chatId), (snap) => {
      setChatMeta(snap.exists() ? { id: snap.id, ...snap.data() } : null);
    });
    return unsub;
  }, [chatId]);

  const memberKey = chatMeta?.members ? chatMeta.members.join(",") : "";

  // Личный чат — подписываемся на профиль собеседника в реальном времени,
  // чтобы статус "в сети" обновлялся, пока открыт чат.
  useEffect(() => {
    if (!user || !chatMeta || chatMeta.isGroup) {
      setOther(null);
      return;
    }
    const otherUid = chatMeta.members.find((m) => m !== user.uid);
    if (!otherUid) return;
    const unsub = onSnapshot(doc(db, "users", otherUid), (snap) => {
      if (snap.exists()) {
        setOther(snap.data());
        return;
      }
      // Пользовательский бот — у него нет настоящего users/{uid} (нет
      // Firebase Auth аккаунта, см. utils/customBots.js), его профиль лежит
      // в bots/{botId}. Тот же документ содержит и rules/fallbackReply —
      // им же ниже пользуется подбор ответа (matchBotRule).
      if (chatMeta.isBotChat && chatMeta.botUid === otherUid) {
        getDoc(doc(db, "bots", otherUid)).then((botSnap) => {
          setOther(botSnap.exists() ? { id: botSnap.id, ...botSnap.data() } : null);
        });
      } else {
        setOther(null);
      }
    });
    return unsub;
  }, [chatMeta?.isGroup, memberKey, user, chatMeta?.isBotChat, chatMeta?.botUid]);

  // Идёт ли в этой группе прямо сейчас звонок (см. utils/groupCalls.js —
  // звонок живёт как комната: даже если мне не звонили, я вижу плашку и могу
  // зайти сам). Слушаем только живые звонки этого чата — запрос узкий и
  // дешёвый.
  useEffect(() => {
    if (!chatMeta?.isGroup || !chatId) {
      setLiveGroupCall(null);
      return undefined;
    }
    const q = query(
      collection(db, "groupCalls"),
      where("chatId", "==", chatId),
      where("status", "==", "live"),
      orderBy("createdAt", "desc"),
      limit(3)
    );
    // Последний снапшот держим в ref: проверку "жив ли там кто-нибудь" надо
    // уметь повторять не только когда документ звонка изменился, но и просто
    // по времени — см. интервал ниже.
    let liveDocs = [];
    let disposed = false;

    // Звонок считается идущим, только если в нём есть кто-то ЖИВОЙ: если
    // последний участник просто закрыл вкладку и его выход не успел
    // записаться, комната формально остаётся "live" с призраком внутри.
    // Такую комнату здесь же и закрываем — иначе плашка висела бы в
    // группе вечно, а новый звонок начать было бы нельзя (см.
    // utils/groupCalls.js -> isStaleParticipant).
    const recheck = async () => {
      const checked = await Promise.all(
        liveDocs.map(async (c) => {
          const participants = c.participants || [];
          if (!participants.length) return { call: c, alive: false, presence: {} };
          try {
            const pres = await getDocs(collection(db, "groupCalls", c.id, "presence"));
            const presence = {};
            pres.docs.forEach((d) => {
              presence[d.id] = d.data()?.at;
            });
            return { call: c, alive: hasLiveParticipant(c, presence), presence };
          } catch {
            return { call: c, alive: true, presence: null };
          }
        })
      );
      if (disposed) return;
      const alive = checked.find((c) => c.alive);
      setLiveGroupCall(alive ? alive.call : null);
      const dead = checked.find((c) => !c.alive);
      if (dead) closeDeadGroupCall(dead.call, dead.presence);
    };

    const unsub = onSnapshot(
      q,
      (snap) => {
        liveDocs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        recheck();
      },
      () => setLiveGroupCall(null)
    );

    // Отметки presence протухают САМИ ПО СЕБЕ, без единой записи в базу:
    // если все участники разом пропали (закрыли вкладки, потеряли связь) или
    // запись о завершении звонка не прошла, документ звонка больше не
    // меняется — и подписка выше молчит вечно. Раньше это и означало
    // "звонок закончился, а плашка висит, пока не перезагрузишь страницу".
    // Поэтому пересчитываем живость и по таймеру, пока плашка показана.
    const timer = setInterval(() => {
      if (liveDocs.length) recheck();
    }, 20000);

    return () => {
      disposed = true;
      clearInterval(timer);
      unsub();
    };
  }, [chatMeta?.isGroup, chatId]);

  // Группа — подтягиваем профили всех участников (имена для подписи
  // отправителя над сообщениями и для экрана управления группой).
  useEffect(() => {
    if (!chatMeta?.isGroup) {
      setMembersById({});
      return;
    }
    let cancelled = false;
    Promise.all(chatMeta.members.map((uid) => getDoc(doc(db, "users", uid)))).then((snaps) => {
      if (cancelled) return;
      const map = {};
      snaps.forEach((s) => {
        if (s.exists()) map[s.id] = s.data();
      });
      // @stiller_bot не состоит в группе по-настоящему (см. utils/
      // stillerBot.js) — подмешиваем его псевдо-профиль, чтобы подпись
      // отправителя и аватарка над результатом /kazik/колеса отображались
      // как у обычного участника.
      map[STILLER_BOT_UID] = STILLER_BOT_PROFILE;
      setMembersById(map);
    });
    return () => {
      cancelled = true;
    };
  }, [chatMeta?.isGroup, memberKey]);

  // Блокировка — подписываемся на оба возможных документа
  // (мы заблокировали собеседника / собеседник заблокировал нас), только
  // для личных чатов.
  useEffect(() => {
    if (!user || !chatMeta || chatMeta.isGroup) {
      setIBlockedThem(false);
      setTheyBlockedMe(false);
      return;
    }
    const otherUid = chatMeta.members.find((m) => m !== user.uid);
    if (!otherUid) return;
    // Слушаем блокировки ЗАПРОСАМИ, а не чтением конкретных документов.
    // Правило blocks/{id} смотрит на resource.data (blockerId/blockedId),
    // поэтому чтение НЕСУЩЕСТВУЮЩЕГО документа блокировки — а его нет почти
    // всегда — отклоняется правилами: подписка падала с permission-denied,
    // засоряя консоль двумя ошибками на каждый открытый чат и переставая
    // следить за блокировкой вообще. Запрос возвращает только те документы,
    // которые правила разрешают, поэтому просто отдаёт пусто, когда блокировки
    // нет, и живо реагирует, когда она появляется.
    const unsub1 = onSnapshot(
      query(
        collection(db, "blocks"),
        where("blockerId", "==", user.uid),
        where("blockedId", "==", otherUid)
      ),
      (snap) => setIBlockedThem(!snap.empty)
    );
    const unsub2 = onSnapshot(
      query(
        collection(db, "blocks"),
        where("blockerId", "==", otherUid),
        where("blockedId", "==", user.uid)
      ),
      (snap) => setTheyBlockedMe(!snap.empty)
    );
    return () => {
      unsub1();
      unsub2();
    };
  }, [chatMeta?.isGroup, memberKey, user]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Обновляем "текущее время" раз в 15 секунд, чтобы статус "в сети/не в сети"
  // не зависал устаревшим, даже если профиль собеседника давно не менялся.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);

  // Отдельный, более частый тик — только для индикатора "печатает…"
  // (TYPING_STALE_MS короче, чем ONLINE_THRESHOLD_MS, иначе индикатор
  // пропадал бы с задержкой в несколько секунд после того, как собеседник
  // реально перестал печатать).
  useEffect(() => {
    const timer = setInterval(() => setTypingTick(Date.now()), 2000);
    return () => clearInterval(timer);
  }, []);

  // "Прочитано" — как только в чате появляется сообщение новее, чем наша
  // предыдущая отметка lastReadAt, сразу подтягиваем её (открытый чат = все
  // сообщения в нём считаются прочитанными, как и в большинстве мессенджеров).
  //
  // ВАЖНО: пока наша собственная запись lastReadAt ещё не подтверждена
  // сервером, локальный snapshot-слушатель chatMeta на мгновение отражает
  // её как serverTimestamp()-заглушку (null) — это штатное поведение SDK
  // ("local echo" отложенного значения). Если сравнивать с chatMeta при
  // каждом её изменении без доп. защиты, это создаёт бесконечный цикл
  // записи: null расценивается как "ещё не прочитано" → снова пишем →
  // снова null → и так далее, забивая канал записи Firestore и оттесняя
  // остальные запросы (в том числе отправку файлов) в очереди. Поэтому
  // помним id последнего сообщения, для которого уже отправили отметку, и
  // не повторяем запрос, пока не появится новое сообщение.
  useEffect(() => {
    if (!chatMeta || chatMeta.isSystem || chatMeta.isBotChat || messages.length === 0) return;
    const lastMsg = messages[messages.length - 1];
    const lastMsgMs = lastMsg.createdAt?.toMillis ? lastMsg.createdAt.toMillis() : null;
    if (lastMsgMs == null) return;
    const sentKey = chatId + ":" + lastMsg.id;
    if (lastReadSentForRef.current === sentKey) return;
    const myLastRead = chatMeta.lastReadAt?.[user.uid];
    const myLastReadMs = myLastRead?.toMillis ? myLastRead.toMillis() : 0;
    if (lastMsgMs > myLastReadMs) {
      lastReadSentForRef.current = sentKey;
      updateDoc(doc(db, "chats", chatId), {
        [`lastReadAt.${user.uid}`]: serverTimestamp(),
      }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, chatMeta, chatId]);

  // На случай ухода со страницы во время записи — освобождаем микрофон.
  useEffect(() => {
    return () => {
      clearInterval(recordTimerRef.current);
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        cancelledRef.current = true;
        mediaRecorderRef.current.stop();
      }
    };
  }, []);

  // Имя автора сообщения — для превью последнего сообщения (lastMessage),
  // которое читает и глобальный слушатель браузерных уведомлений (см.
  // hooks/useMessageNotifications.js), и список чатов.
  function senderNameFor(uid) {
    if (uid === user.uid) return profile?.name || null;
    if (chatMeta?.isGroup) return membersById[uid]?.name || null;
    return other?.name || null;
  }

  // Профиль автора сообщения (для косметики за звёзды — цвет текста, эффект
  // ника, см. utils/cosmetics.js) — та же логика источника, что и senderNameFor.
  function senderProfileFor(uid) {
    if (uid === user.uid) return profile;
    if (chatMeta?.isGroup) return membersById[uid];
    return other;
  }

  async function startRecording() {
    if (theyBlockedMe || iBlockedThem) return;
    setVoiceError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunksRef.current = [];
      cancelledRef.current = false;
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 24000 });

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((tr) => tr.stop());
        clearInterval(recordTimerRef.current);
        const wasCancelled = cancelledRef.current;
        const seconds = recordSecondsRef.current;
        setRecording(false);
        setRecordSeconds(0);
        if (wasCancelled) return;
        const blob = new Blob(chunksRef.current, { type: mimeType });
        if (blob.size === 0) return;
        sendVoiceMessage(blob, mimeType, seconds);
      };

      mediaRecorderRef.current = recorder;
      recordSecondsRef.current = 0;
      setRecordSeconds(0);
      recorder.start();
      setRecording(true);
      recordTimerRef.current = setInterval(() => {
        recordSecondsRef.current += 1;
        setRecordSeconds(recordSecondsRef.current);
        if (recordSecondsRef.current >= MAX_RECORD_SECONDS) {
          stopRecording();
        }
      }, 1000);
    } catch (err) {
      setVoiceError(t("chatWindow.micError", { message: err.message }));
    }
  }

  function stopRecording() {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
  }

  function cancelRecording() {
    cancelledRef.current = true;
    stopRecording();
  }

  async function sendVoiceMessage(blob, mimeType, durationSeconds) {
    if (isCooldownActive(profile)) {
      setVoiceError(t("chatWindow.floodLimitError"));
      return;
    }
    try {
      const base64 = await blobToBase64(blob);
      const replyField = buildReplyField();
      setReplyTo(null);
      const ts = serverTimestamp();
      // См. utils/antiSpam.js — общий кулдаун floodOk() на все виды
      // сообщений, отмечаем сразу перед самой записью.
      markLocalSend();
      await addDoc(collection(db, "chats", chatId, "messages"), {
        audio: base64,
        mimeType,
        duration: durationSeconds,
        senderId: user.uid,
        createdAt: ts,
        ...replyField,
      });
      const previewText = t("chatWindow.voiceMessagePreview");
      await updateDoc(doc(db, "chats", chatId), {
        lastMessage: {
          text: previewText,
          senderId: user.uid,
          senderName: profile?.name || null,
          createdAt: ts,
        },
        updatedAt: ts,
      });
      bumpStarsActivity();
    } catch (err) {
      setVoiceError(
        err?.code === "permission-denied"
          ? sendErrorMessage(err, t)
          : t("chatWindow.voiceSendError", { message: err.message })
      );
    }
  }

  async function handleAttach(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !chatMeta) return;
    if (theyBlockedMe || iBlockedThem) return;
    setAttachError("");
    if (isCooldownActive(profile)) {
      setAttachError(t("chatWindow.floodLimitError"));
      return;
    }
    const msgRef = doc(collection(db, "chats", chatId, "messages"));
    const ts = serverTimestamp();
    const replyField = buildReplyField();
    setReplyTo(null);
    try {
      // Файл (фото — автоматически сжатое) уходит в Firestore сразу, но
      // видимым для остальных участников остаётся только когда они сами
      // нажмут "Скачать" — сама "заглушка" сообщения хранит лишь метаданные.
      const fileMeta = await fileTransfer.saveOwnFile(file, chatId, msgRef.id);
      // Отмечаем момент отправки прямо перед самой записью сообщения (см.
      // utils/antiSpam.js) — тем же общим кулдауном floodOk() делятся все
      // виды сообщений (текст/файл/голосовое/стикер/подарок), не только
      // текстовые.
      markLocalSend();
      await setDoc(msgRef, { fileMeta, senderId: user.uid, createdAt: ts, ...replyField });
      const previewText = fileMeta.mimeType.startsWith("image/")
        ? t("chatWindow.photoPreview")
        : `📎 ${fileMeta.name}`;
      await updateDoc(doc(db, "chats", chatId), {
        lastMessage: {
          text: previewText,
          senderId: user.uid,
          senderName: profile?.name || null,
          createdAt: ts,
        },
        updatedAt: ts,
      });
      bumpStarsActivity();
    } catch (err) {
      setAttachError(sendErrorMessage(err, t));
    }
  }

  // Контакты (люди, с которыми уже есть личный чат) — в группу их можно
  // добавить сразу, а всех остальных только пригласить (см. confirmAddMember).
  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, "chats"), where("members", "array-contains", user.uid));
    const unsub = onSnapshot(q, (snap) => {
      const ids = new Set();
      snap.docs.forEach((d) => {
        const data = d.data();
        if (data.isGroup || data.isSystem) return;
        const otherUid = data.members.find((m) => m !== user.uid);
        if (otherUid) ids.add(otherUid);
      });
      setContactIds(ids);
    });
    return unsub;
  }, [user]);

  // Закрыть "мёртвую" комнату: убираем протухших участников по одному (ровно
  // так это разрешают правила), а когда остаётся последний — гасим звонок
  // целиком. Делает любой участник группы, у кого открыт чат.
  async function closeDeadGroupCall(deadCall, presence) {
    const participants = deadCall.participants || [];
    const lastTry = closingCallsRef.current.get(deadCall.id) || 0;
    if (Date.now() - lastTry < 60000) return;
    closingCallsRef.current.set(deadCall.id, Date.now());
    try {
      if (participants.length === 0) {
        await updateDoc(doc(db, "groupCalls", deadCall.id), {
          participants: [],
          invited: [],
          status: "ended",
          updatedAt: serverTimestamp(),
        });
        return;
      }
      const stale = participants.find((uid) => isStaleParticipant(presence?.[uid]));
      if (!stale) return;
      if (participants.length === 1) {
        await updateDoc(doc(db, "groupCalls", deadCall.id), {
          participants: [],
          invited: [],
          status: "ended",
          updatedAt: serverTimestamp(),
        });
      } else {
        await updateDoc(doc(db, "groupCalls", deadCall.id), {
          participants: participants.filter((uid) => uid !== stale),
          updatedAt: serverTimestamp(),
        });
      }
    } catch {
      /* кто-то другой уже прибрался или правила не дали — повторим не раньше
         чем через минуту (см. closingCallsRef выше) */
    }
  }

  // Позвонить в группе: сначала выбираем, кого звать (вся группа или
  // отдельные люди), см. components/CallMemberPicker.jsx.
  function openGroupCallPicker() {
    if (callState || inGroupCall) return;
    setShowGroupCallPicker(true);
  }

  async function handleJoinGroupCall() {
    if (callState || inGroupCall || !liveGroupCall) return;
    await joinGroupCall(liveGroupCall.id, chatId);
  }

  // Переключатель владельца группы: могут ли начинать звонки и звать людей
  // все участники, или только он сам (см. firestore.rules -> chats/{chatId},
  // ветка callByMembers).
  async function toggleCallByMembers() {
    if (!isOwner || callPermBusy) return;
    setCallPermBusy(true);
    try {
      await updateDoc(doc(db, "chats", chatId), {
        callByMembers: !chatMeta?.callByMembers,
      });
    } catch {
      /* нет прав/сети — состояние просто не изменится */
    } finally {
      setCallPermBusy(false);
    }
  }

  function openManage() {
    setRenameValue(chatMeta?.name || "");
    setAddTagInput("");
    setAddTagResult(null);
    setAddTagSuggestions([]);
    setAddSuccessMsg("");
    setManageError("");
    setShowManage(true);
    reloadLinks();
  }

  // --- ссылки-приглашения ---------------------------------------------------

  async function reloadLinks() {
    try {
      setLinks(await listInviteLinks(chatId));
    } catch {
      /* нет прав или сети — список просто останется пустым */
    }
  }

  async function copyLink(id) {
    setManageError("");
    try {
      await navigator.clipboard.writeText(linkUrl(id));
      setCopiedLinkId(id);
      setLinkCopied(true);
      setTimeout(() => {
        setLinkCopied(false);
        setCopiedLinkId("");
      }, 2000);
    } catch {
      setManageError(t("chatWindow.copyLinkError"));
    }
  }

  async function makeLink() {
    if (linksBusy) return;
    setManageError("");
    setLinksBusy(true);
    try {
      let forUid = null;
      const tag = linkForTag.trim().replace(/^@/, "").toLowerCase();
      if (tag) {
        // Именная ссылка: ищем адресата по тегу заранее, чтобы не выпустить
        // ссылку, которой никто не сможет воспользоваться.
        const found = await searchUsersByTagPrefix(tag);
        const exact = found.find((u) => (u.tag || "").toLowerCase() === tag);
        if (!exact) {
          setManageError(t("chatWindow.linkUserNotFound", { tag }));
          return;
        }
        forUid = exact.id;
      }
      const id = await createInviteLink(chatId, user.uid, { durationKey: linkDuration, forUid });
      setLinkForTag("");
      await reloadLinks();
      await copyLink(id);
    } catch (err) {
      setManageError(err.message);
    } finally {
      setLinksBusy(false);
    }
  }

  async function killLink(id) {
    setManageError("");
    try {
      await revokeInviteLink(id);
      await reloadLinks();
    } catch (err) {
      setManageError(err.message);
    }
  }

  // --- администраторы --------------------------------------------------------

  async function setAdmin(uid, makeAdmin) {
    if (rolesBusy) return;
    setManageError("");
    setRolesBusy(true);
    try {
      const current = Array.isArray(chatMeta?.admins) ? chatMeta.admins : [];
      const next = makeAdmin ? [...current, uid] : current.filter((x) => x !== uid);
      await updateDoc(doc(db, "chats", chatId), { admins: next });
    } catch (err) {
      setManageError(err.message);
    } finally {
      setRolesBusy(false);
    }
  }

  async function toggleAdminRight(key) {
    if (rolesBusy) return;
    setManageError("");
    setRolesBusy(true);
    try {
      const rights = groupAdminRights(chatMeta);
      await updateDoc(doc(db, "chats", chatId), {
        adminRights: { ...rights, [key]: !rights[key] },
      });
    } catch (err) {
      setManageError(err.message);
    } finally {
      setRolesBusy(false);
    }
  }

  // Живые подсказки по мере ввода тега (см. utils/tagSearch.js) — не
  // показываем тех, кто уже состоит в группе.
  useEffect(() => {
    if (!showManage) return;
    const tag = addTagInput.trim().replace(/^@/, "").toLowerCase();
    if (!tag) {
      setAddTagSuggestions([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const found = await searchUsersByTagPrefix(tag);
        if (!cancelled) {
          setAddTagSuggestions(found.filter((u) => !chatMeta?.members?.includes(u.id)));
        }
      } catch {
        // тихо игнорируем — есть кнопка "Найти" как запасной вариант
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [addTagInput, showManage, chatMeta?.members]);

  function pickAddTagSuggestion(u) {
    setAddTagResult(u);
    setAddTagSuggestions([]);
    setAddTagInput(u.tag || "");
    setManageError("");
  }

  async function renameGroup() {
    const value = renameValue.trim();
    if (!value || value === chatMeta?.name) return;
    setManageError("");
    setRenaming(true);
    try {
      await updateDoc(doc(db, "chats", chatId), { name: value });
    } catch (err) {
      setManageError(err.message);
    } finally {
      setRenaming(false);
    }
  }

  async function searchAddTag() {
    const tag = addTagInput.trim().replace(/^@/, "").toLowerCase();
    setAddTagResult(null);
    setManageError("");
    if (!tag) return;
    try {
      const tagDoc = await getDoc(doc(db, "tags", tag));
      if (!tagDoc.exists()) {
        setManageError(t("chatWindow.userNotFound"));
        return;
      }
      const uid = tagDoc.data().uid;
      if (chatMeta.members.includes(uid)) {
        setManageError(t("chatWindow.alreadyInGroup"));
        return;
      }
      const userSnap = await getDoc(doc(db, "users", uid));
      setAddTagResult({ id: userSnap.id, ...userSnap.data() });
    } catch (err) {
      setManageError(err.message);
    }
  }

  async function confirmAddMember() {
    if (!addTagResult) return;
    if (chatMeta.members.length + 1 > MAX_GROUP_MEMBERS) {
      setManageError(t("chatWindow.memberLimitReached", { max: MAX_GROUP_MEMBERS }));
      return;
    }
    setManageError("");
    setAddSuccessMsg("");
    try {
      if (contactIds.has(addTagResult.id)) {
        // Из контактов — добавляем сразу, без подтверждения
        await updateDoc(doc(db, "chats", chatId), {
          members: [...chatMeta.members, addTagResult.id],
        });
        setAddSuccessMsg(t("chatWindow.addedSuccess", { name: addTagResult.name || t("common.unknownUser") }));
      } else {
        // Не из контактов — отправляем приглашение, добавится, только если
        // сам примет его (в "Системные сообщения")
        const inviteRef = await addDoc(collection(db, "groupInvites"), {
          chatId,
          chatName: chatMeta.name,
          from: user.uid,
          to: addTagResult.id,
          status: "pending",
          createdAt: serverTimestamp(),
        });
        await sendSystemNotification(addTagResult.id, {
          type: "group_invite",
          text: `👥 ${profile?.name || t("common.unknownUser")} приглашает вас в группу «${chatMeta.name}»`,
          fromName: profile?.name,
          chatName: chatMeta.name,
          actorUid: user.uid,
          refId: inviteRef.id,
        });
        setAddSuccessMsg(t("chatWindow.inviteSentSuccess"));
      }
      setAddTagResult(null);
      setAddTagInput("");
      setAddTagSuggestions([]);
    } catch (err) {
      setManageError(err.message);
    }
  }

  async function removeMember(uid) {
    setManageError("");
    try {
      // Сначала снимаем звание, потом убираем из группы — иначе в admins
      // остался бы тот, кого в группе уже нет. Власти это ему не даёт
      // (canInGroup требует членства), но список лучше держать чистым.
      // Снять звание может только владелец, поэтому и условие такое.
      if (isOwner && isGroupAdmin(chatMeta, uid)) {
        await updateDoc(doc(db, "chats", chatId), {
          admins: (chatMeta.admins || []).filter((x) => x !== uid),
        });
      }
      await updateDoc(doc(db, "chats", chatId), {
        members: chatMeta.members.filter((m) => m !== uid),
      });
    } catch (err) {
      setManageError(err.message);
    }
  }

  async function leaveGroup() {
    setManageError("");
    try {
      await updateDoc(doc(db, "chats", chatId), { members: arrayRemove(user.uid) });
      setShowManage(false);
      navigate("/");
    } catch (err) {
      setManageError(err.message);
    }
  }

  // Снести группу целиком: переписка удаляется у всех участников, группа
  // исчезает из их списков. Только владелец (у остальных кнопки нет, и
  // правила такую запись всё равно не пропустят).
  async function deleteGroup() {
    if (deletingGroup) return;
    setManageError("");
    setDeletingGroup(true);
    setDeleteProgress(0);
    try {
      await deleteGroupChat(chatId, (n) => setDeleteProgress(n));
      setShowDeleteGroup(false);
      setShowManage(false);
      navigate("/");
    } catch (err) {
      setManageError(err.message);
      setDeletingGroup(false);
    }
  }

  // "Очистить историю" — сообщения остаются у собеседника, у нас пропадают
  // из этого чата (фильтруем по clearedFor при рендере), сам чат в списке остаётся.
  async function clearHistory() {
    if (!window.confirm(t("chatWindow.clearHistoryConfirm"))) return;
    setActionsError("");
    try {
      await updateDoc(doc(db, "chats", chatId), {
        [`clearedFor.${user.uid}`]: serverTimestamp(),
      });
      setShowActions(false);
    } catch (err) {
      setActionsError(err.message);
    }
  }

  // "Удалить чат" — исчезает из нашего списка чатов и история очищается у
  // нас; у собеседника чат и сообщения остаются как есть. Если собеседник
  // напишет снова, чат сам вернётся в список (updatedAt обгонит hiddenFor).
  async function deleteChat({ alsoBlock = false } = {}) {
    if (!window.confirm(alsoBlock ? t("chatWindow.deleteAndBlockConfirm") : t("chatWindow.deleteChatConfirm")))
      return;
    setActionsError("");
    try {
      await updateDoc(doc(db, "chats", chatId), {
        [`clearedFor.${user.uid}`]: serverTimestamp(),
        [`hiddenFor.${user.uid}`]: serverTimestamp(),
      });
      if (alsoBlock) await blockUser();
      setShowActions(false);
      navigate("/");
    } catch (err) {
      setActionsError(err.message);
    }
  }

  async function blockUser() {
    if (!chatMeta || chatMeta.isGroup) return;
    const otherUid = chatMeta.members.find((m) => m !== user.uid);
    if (!otherUid) return;
    await setDoc(doc(db, "blocks", `${user.uid}_${otherUid}`), {
      blockerId: user.uid,
      blockedId: otherUid,
      createdAt: serverTimestamp(),
    });
  }

  async function unblockUser() {
    if (!chatMeta || chatMeta.isGroup) return;
    const otherUid = chatMeta.members.find((m) => m !== user.uid);
    if (!otherUid) return;
    setActionsError("");
    try {
      await deleteDoc(doc(db, "blocks", `${user.uid}_${otherUid}`));
      setShowActions(false);
    } catch (err) {
      setActionsError(err.message);
    }
  }

  function handleCallClick() {
    const otherUid = chatMeta?.members.find((m) => m !== user.uid);
    if (!otherUid || callState) return;
    startCall(otherUid, other?.name, chatId);
  }

  async function handleBlockClick() {
    setActionsError("");
    try {
      await blockUser();
      setShowActions(false);
    } catch (err) {
      setActionsError(err.message);
    }
  }

  // "Без звука" — заглушить уведомления от ЭТОГО чата (личного, группового
  // или бот-чата), не трогая сами сообщения — они по-прежнему приходят и
  // видны, просто без браузерного уведомления/всплывающей плашки (см.
  // hooks/useMessageNotifications.js). Своим ключом в mutedFor, тем же
  // паттерном, что и hiddenFor/clearedFor выше.
  async function toggleMuteChat() {
    if (!chatMeta) return;
    setActionsError("");
    try {
      await updateDoc(doc(db, "chats", chatId), {
        [`mutedFor.${user.uid}`]: !isMuted,
      });
      setShowActions(false);
    } catch (err) {
      setActionsError(err.message);
    }
  }

  // "Удалить из друзей" — полноценный разрыв контакта (см. utils/contacts.js):
  // в отличие от блокировки, переписка не трогается и писать друг другу можно
  // как и раньше, единственный эффект — человек больше не считается "другом"
  // (не предлагается при создании группы), пока не отправит(-им) заявку заново.
  async function handleRemoveContactClick() {
    if (!chatMeta || chatMeta.isGroup) return;
    const otherUid = chatMeta.members.find((m) => m !== user.uid);
    if (!otherUid) return;
    if (!window.confirm(t("chatWindow.removeContactConfirm"))) return;
    setActionsError("");
    try {
      await removeContact(user.uid, otherUid);
      setShowActions(false);
    } catch (err) {
      setActionsError(err.message);
    }
  }

  // Снимок цитируемого сообщения — сохраняется прямо В сообщении при
  // отправке (а не ссылкой "вживую"), потому что редактировать уже
  // отправленные документы правила Firestore не разрешают (update: false,
  // см. firestore.rules), и это тот же приём, что и с lastMessage/превью
  // звонков — денормализация вместо join'а, которого тут просто нет.
  function buildReplyField() {
    if (!replyTo) return {};
    return {
      replyTo: {
        messageId: replyTo.id,
        senderId: replyTo.senderId,
        senderName: senderNameFor(replyTo.senderId),
        preview: messagePreviewText(replyTo, t).slice(0, 160),
      },
    };
  }

  function startReply(message) {
    if (chatMeta?.isSystem || chatMeta?.isBotChat) return;
    setReplyTo(message);
  }

  // Клик по кнопке быстрого ответа под сообщением пользовательского бота —
  // "печатает" её trigger тем же путём, что и обычная строка ввода (см.
  // CustomBotComposeRow и MessageRow -> onCustomBotButton выше).
  async function handleCustomBotButton(triggerText) {
    if (!isCustomBotChat || !other || !triggerText) return;
    try {
      await sendCustomBotUserText(chatId, other, user.uid, triggerText);
    } catch {
      // не критично — можно просто напечатать то же самое вручную
    }
  }

  const KAZIK_SPIN_MS = 1500;
  const WHEEL_SPIN_MS = 1800;

  // /kazik и /wheel — платные команды бота @stiller_bot (см. utils/
  // stillerBot.js), работают в ЛЮБОМ чате, не только в отдельном чате с
  // ботом. На время "спина" показываем баннер "бот управляет этим чатом"
  // (см. StillerGameBanner) + анимацию, а по истечении таймера пишем
  // готовый результат одним сообщением от лица бота.
  function startKazikGame() {
    setActiveGame({ kind: "kazik" });
    gameTimeoutRef.current = setTimeout(async () => {
      gameTimeoutRef.current = null;
      setActiveGame(null);
      try {
        await sendKazikResult(chatId, user.uid, profile?.name, rollKazik());
      } catch (err) {
        setCommandError(starsErrorMessage(err, t));
      }
    }, KAZIK_SPIN_MS);
  }

  function startWheelGame(segments) {
    setActiveGame({ kind: "wheel", segments });
    gameTimeoutRef.current = setTimeout(async () => {
      gameTimeoutRef.current = null;
      setActiveGame(null);
      try {
        await sendWheelResult(chatId, user.uid, profile?.name, {
          segments,
          resultIndex: rollWheel(segments),
        });
      } catch (err) {
        setCommandError(starsErrorMessage(err, t));
      }
    }, WHEEL_SPIN_MS);
  }

  // Кнопка "Отмена" в баннере — просто гасим анимацию, результат ещё не
  // писался (таймер снимается), так что отменять в Firestore нечего.
  function cancelActiveGame() {
    if (gameTimeoutRef.current) {
      clearTimeout(gameTimeoutRef.current);
      gameTimeoutRef.current = null;
    }
    setActiveGame(null);
  }

  // Покупка /kazik или /wheel прямо из инлайн-кнопки в чате (см.
  // lockedCommand выше) — после успешной покупки сразу же запускаем
  // отложенную команду, чтобы не заставлять набирать её заново.
  async function handleBuyLockedCommand() {
    if (!lockedCommand) return;
    setBuyingLocked(true);
    setCommandError("");
    try {
      if (lockedCommand.kind === "kazik") {
        await buyKazikUnlock(user.uid, profile);
        setLockedCommand(null);
        startKazikGame();
      } else if (lockedCommand.kind === "wheel") {
        await buyWheelUnlock(user.uid, profile);
        const segments = lockedCommand.pendingSegments;
        setLockedCommand(null);
        if (segments) startWheelGame(segments);
      }
    } catch (err) {
      setCommandError(starsErrorMessage(err, t));
    } finally {
      setBuyingLocked(false);
    }
  }

  // /kazik и /wheel бота @stiller_bot — общая логика для отправки команды
  // текстом (handleSend ниже) и для кнопок-подсказок "🎰 /kazik"/"🎡 /wheel"
  // (см. isStillerBotChat выше), чтобы не дублировать разбор дважды.
  // Возвращает true, если строка была слэш-командой (и уже обработана) —
  // тогда handleSend не должен отправлять её как обычное сообщение.
  function runSlashCommand(value) {
    if (/^\/kazik\b/i.test(value)) {
      setCommandError("");
      setLockedCommand(null);
      if (!hasKazikUnlocked(profile)) {
        setLockedCommand({ kind: "kazik" });
        return true;
      }
      startKazikGame();
      return true;
    }
    if (/^\/wheel\b/i.test(value)) {
      setCommandError("");
      setLockedCommand(null);
      const parsed = parseWheelArgs(value.replace(/^\/wheel/i, ""));
      if (!hasWheelUnlocked(profile)) {
        if (!parsed) {
          setCommandError(t("stillerBot.wheelUsageHint"));
          return true;
        }
        setLockedCommand({ kind: "wheel", pendingSegments: parsed.segments });
        return true;
      }
      if (!parsed) {
        setCommandError(t("stillerBot.wheelUsageHint"));
        return true;
      }
      startWheelGame(parsed.segments);
      return true;
    }
    return false;
  }

  // Кнопки-подсказки под полем ввода в чате с @stiller_bot — делают то же
  // самое, что если бы пользователь сам напечатал "/kazik" или "/wheel" и
  // отправил (см. isStillerBotChat выше) — не нужно угадывать синтаксис.
  function quickStillerCommand(cmd) {
    if (theyBlockedMe || iBlockedThem) return;
    runSlashCommand(cmd);
  }

  async function handleSend(e) {
    e.preventDefault();
    if (theyBlockedMe || iBlockedThem) return;
    const value = text.trim();
    if (!value) return;

    if (runSlashCommand(value)) {
      setText("");
      return;
    }

    // Антиспам (см. utils/antiSpam.js, firestore.rules -> floodOk()) —
    // проверяем ДО отправки, чтобы не тратить запись впустую: правила всё
    // равно откажут, но так пользователь сразу видит причину.
    setCommandError("");
    if (isCooldownActive(profile)) {
      setCommandError(t("chatWindow.floodLimitError"));
      return;
    }

    const replyField = buildReplyField();
    const previousReplyTo = replyTo;
    const sentAt = serverTimestamp();
    // Отмечаем момент отправки СРАЗУ (синхронно), а не после ответа сервера
    // — см. utils/antiSpam.js: иначе повторная отправка чуть позже (до того,
    // как onSnapshot принесёт обновлённый profile.lastMessageAt) проходила
    // клиентскую проверку кулдауна, но всё равно падала на floodOk() в
    // firestore.rules — а раньше эта ошибка тут вообще не ловилась, и
    // сообщение просто бесследно пропадало.
    markLocalSend();
    setText("");
    setReplyTo(null);
    try {
      await addDoc(collection(db, "chats", chatId, "messages"), {
        text: value,
        senderId: user.uid,
        createdAt: sentAt,
        ...replyField,
      });
      // Cloud Functions не используются — превью последнего сообщения
      // обновляем сами (разрешено правилами только для этих двух полей)
      await updateDoc(doc(db, "chats", chatId), {
        lastMessage: {
          text: value,
          senderId: user.uid,
          senderName: profile?.name || null,
          createdAt: sentAt,
        },
        updatedAt: sentAt,
      });
      // Кулдаун антиспама — best-effort, отдельной записью (см.
      // utils/antiSpam.js): сбой не должен мешать уже отправленному сообщению.
      updateDoc(doc(db, "users", user.uid), {
        lastMessageAt: nextMessageTimestamp(),
      }).catch(() => {});
      bumpStarsActivity();
      notifyIfOffline(value);
    } catch (err) {
      // Сообщение не ушло (чаще всего — antispam-кулдаун, см. коммент выше)
      // — возвращаем текст в поле ввода, чтобы его не пришлось набирать
      // заново, и показываем понятную причину вместо тишины.
      setText(value);
      setReplyTo(previousReplyTo);
      setCommandError(sendErrorMessage(err, t));
    }
  }

  // "Печатает…" — не чаще TYPING_PING_INTERVAL_MS, пока поле ввода не
  // пустое (см. utils/presence.js). Само поле читает собеседник в
  // chatMeta.typing.{myUid} и сравнивает свежесть на своей стороне.
  function handleTextChange(e) {
    const value = e.target.value;
    setText(value);
    if (chatMeta?.isSystem || chatMeta?.isBotChat) return;
    const nowTs = Date.now();
    if (value.trim() && nowTs - typingSentAtRef.current > TYPING_PING_INTERVAL_MS) {
      typingSentAtRef.current = nowTs;
      updateDoc(doc(db, "chats", chatId), {
        [`typing.${user.uid}`]: serverTimestamp(),
      }).catch(() => {});
    }
  }

  // "Вам пишет такой-то" на email — только для личных (не групповых, не
  // системных/бот) чатов, и только если собеседник сейчас НЕ в сети (см.
  // utils/presence.js): если оба и так активно переписываются в
  // приложении, письмо не нужно и просто тратило бы небольшой бесплатный
  // лимит EmailJS (см. utils/emailNotify.js — сам вызов no-op, пока там не
  // настроены реальные ключи). И — раньше здесь не хватало главной
  // проверки: если СОБЕСЕДНИК сам включил "не уведомлять меня о новых
  // сообщениях" (SettingsView.jsx -> profile.notificationsMuted, поле
  // именно ЕГО профиля users/{otherUid}, который целиком лежит в other, см.
  // подписку выше), письмо всё равно уходило — тумблер реально влиял только
  // на браузерные push-уведомления (useMessageNotifications.js), а email
  // почему-то никто не спрашивал.
  function notifyIfOffline(messageText) {
    if (chatMeta?.isGroup || chatMeta?.isSystem || chatMeta?.isBotChat) return;
    if (!other || isOnline(other.lastActive)) return;
    // Настройки СОБЕСЕДНИКА: и общий тумблер в его настройках, и "без звука"
    // на этом чате с его стороны. Письмо — то же уведомление, что и
    // всплывашка, и глушится тем же самым.
    const otherUid = chatMeta?.members?.find((m) => m !== user.uid);
    if (emailNotificationsOff(other, chatMeta, otherUid)) return;
    notifyNewMessage({
      toEmail: other.email,
      toName: other.name,
      fromName: profile?.name,
      preview: messageText,
      chatId,
    }).catch(() => {});
  }

  // Отправка стикера (см. StickerPicker.jsx — там же и покупка, если стикер
  // ещё не куплен). Сообщение хранит только stickerId — сам SVG рисуется на
  // лету компонентом Sticker по id, ничего не грузим/не храним лишний раз.
  async function sendSticker(stickerId) {
    if (theyBlockedMe || iBlockedThem) return;
    setStickerError("");
    if (isCooldownActive(profile)) {
      setStickerError(t("chatWindow.floodLimitError"));
      return;
    }
    setShowStickerPicker(false);
    const replyField = buildReplyField();
    setReplyTo(null);
    try {
      const sentAt = serverTimestamp();
      // См. utils/antiSpam.js — общий кулдаун floodOk() на все виды
      // сообщений, отмечаем сразу перед самой записью.
      markLocalSend();
      await addDoc(collection(db, "chats", chatId, "messages"), {
        stickerId,
        senderId: user.uid,
        createdAt: sentAt,
        ...replyField,
      });
      await updateDoc(doc(db, "chats", chatId), {
        lastMessage: {
          text: t("chatWindow.stickerPreview"),
          senderId: user.uid,
          senderName: profile?.name || null,
          createdAt: sentAt,
        },
        updatedAt: sentAt,
      });
      bumpStarsActivity();
      claimFirstStickerBonus(user.uid, profile).catch(() => {});
    } catch (err) {
      setStickerError(sendErrorMessage(err, t));
    }
  }

  // Подарить подарок собеседнику прямо в чате (см. StickerPicker.jsx —
  // вкладка "Подарки" — там же и покупка). Списание звёзд и запись подарка
  // получателю делает utils/gifts.js -> sendGiftToUser; здесь только кладём
  // такое же сообщение в саму переписку, чтобы подарок было видно в чате
  // (правила Firestore не ограничивают дополнительные поля обычных
  // сообщений, см. firestore.rules).
  async function sendGiftToChat(giftId, anonymous = false) {
    if (theyBlockedMe || iBlockedThem || isGroup) return;
    const otherUid = chatMeta?.members.find((m) => m !== user.uid);
    if (!otherUid) return;
    setGiftError("");
    if (isCooldownActive(profile)) {
      setGiftError(t("chatWindow.floodLimitError"));
      return;
    }
    setShowStickerPicker(false);
    const replyField = buildReplyField();
    setReplyTo(null);
    try {
      await sendGiftToUser(user.uid, profile, profile?.name, otherUid, other, giftId, anonymous);
      const sentAt = serverTimestamp();
      // См. utils/antiSpam.js — общий кулдаун floodOk() на все виды
      // сообщений, отмечаем сразу перед самой записью.
      markLocalSend();
      await addDoc(collection(db, "chats", chatId, "messages"), {
        giftId,
        senderId: user.uid,
        createdAt: sentAt,
        ...replyField,
      });
      await updateDoc(doc(db, "chats", chatId), {
        lastMessage: {
          text: t("chatWindow.giftPreview"),
          senderId: user.uid,
          senderName: profile?.name || null,
          createdAt: sentAt,
        },
        updatedAt: sentAt,
      });
      bumpStarsActivity();
    } catch (err) {
      setGiftError(sendErrorMessage(err, t));
    }
  }

  // Подарить звёзды напрямую, без предмета (см. StickerPicker.jsx —
  // мини-форма во вкладке "Подарки").
  async function sendStarsGiftToChat(amount, anonymous = false) {
    if (theyBlockedMe || iBlockedThem || isGroup) return;
    const otherUid = chatMeta?.members.find((m) => m !== user.uid);
    if (!otherUid) return;
    setGiftError("");
    if (isCooldownActive(profile)) {
      setGiftError(t("chatWindow.floodLimitError"));
      return;
    }
    const replyField = buildReplyField();
    setReplyTo(null);
    try {
      await sendStarsToUser(user.uid, profile, profile?.name, otherUid, other, amount, anonymous);
      const sentAt = serverTimestamp();
      // См. utils/antiSpam.js — общий кулдаун floodOk() на все виды
      // сообщений, отмечаем сразу перед самой записью.
      markLocalSend();
      await addDoc(collection(db, "chats", chatId, "messages"), {
        starsAmount: amount,
        senderId: user.uid,
        createdAt: sentAt,
        ...replyField,
      });
      await updateDoc(doc(db, "chats", chatId), {
        lastMessage: {
          text: t("chatWindow.starsGiftPreview", { amount }),
          senderId: user.uid,
          senderName: profile?.name || null,
          createdAt: sentAt,
        },
        updatedAt: sentAt,
      });
      bumpStarsActivity();
    } catch (err) {
      setGiftError(sendErrorMessage(err, t));
    }
  }

  // Заработок звёзд за общение (см. utils/stars.js): считаем только реальные
  // сообщения в обычных чатах — не в системном и не в чате с ботом Stars.
  function bumpStarsActivity() {
    if (chatMeta?.isSystem || chatMeta?.isBotChat) return;
    bumpMessageProgress(user.uid, profile).catch(() => {});
    touchActiveDay(user.uid, profile).catch(() => {});
    claimMessageMilestoneBonus(user.uid, profile).catch(() => {});
  }

  async function handleDelete(message) {
    if (message.senderId !== user.uid) return;
    if (!window.confirm(t("chatWindow.deleteMessageConfirm"))) return;

    await deleteDoc(doc(db, "chats", chatId, "messages", message.id));
    if (message.fileMeta) {
      // Файл в отдельной коллекции fileBlobs больше никому не нужен —
      // удаляем, чтобы не занимал место без причины.
      await fileTransfer.deleteOwnFile(message.id);
    }

    // Если удалённое сообщение было последним — обновляем превью чата на
    // предыдущее оставшееся сообщение (или очищаем, если сообщений не осталось).
    const remaining = messages.filter((m) => m.id !== message.id);
    const wasLast = messages.length > 0 && messages[messages.length - 1].id === message.id;
    if (wasLast) {
      const prev = remaining[remaining.length - 1];
      await updateDoc(doc(db, "chats", chatId), {
        lastMessage: prev
          ? {
              text: messagePreviewText(prev, t),
              senderId: prev.senderId,
              senderName: senderNameFor(prev.senderId),
              createdAt: prev.createdAt,
            }
          : null,
        updatedAt: serverTimestamp(),
      });
    }
  }

  // Редактирование уже отправленного текстового сообщения (см.
  // firestore.rules -> messages allow update — только автор, только у
  // обычного текстового сообщения, только text/edited/editedAt). Если
  // отредактированное сообщение было последним в чате — обновляем и
  // превью (lastMessage), иначе список чатов ещё немного показывал бы
  // старый текст.
  async function handleEditMessage(message, newText) {
    await updateDoc(doc(db, "chats", chatId, "messages", message.id), {
      text: newText,
      edited: true,
      editedAt: serverTimestamp(),
    });
    const wasLast = messages.length > 0 && messages[messages.length - 1].id === message.id;
    if (wasLast) {
      await updateDoc(doc(db, "chats", chatId), {
        lastMessage: {
          text: newText,
          senderId: message.senderId,
          senderName: profile?.name || null,
          createdAt: message.createdAt,
        },
        updatedAt: serverTimestamp(),
      });
    }
  }

  // Пересылка сообщений, как в Телеграме (см. MessageRow -> canForward выше
  // и firestore.rules -> fileBlobs/{messageId}, chats/{chatId}/messages
  // create — обычная ветка правил ничего специально не проверяет насчёт
  // forwardedFrom, так что менять правила не пришлось). Открываем модалку —
  // список ВСЕХ чатов пользователя (кроме "Системные сообщения"), где можно
  // отметить один или несколько чатов-получателей. Загружаем список один
  // раз при открытии (не подпиской onSnapshot) — простая одноразовая
  // выборка вполне достаточна для короткоживущей модалки.
  async function openForward(message) {
    setForwardMessage(message);
    setForwardSelected(new Set());
    setForwardError("");
    setForwardDone(false);
    setForwardChats([]);
    setForwardChatsLoading(true);
    try {
      const snap = await getDocs(query(collection(db, "chats"), where("members", "array-contains", user.uid)));
      const items = await Promise.all(
        snap.docs
          .filter((d) => !d.data().isSystem)
          .map(async (d) => {
            const data = d.data();
            if (data.isGroup) return { id: d.id, name: data.name || t("common.unknownUser"), isGroup: true };
            const otherUid = data.members.find((mid) => mid !== user.uid);
            if (data.isBotChat) {
              // Свой/системный бот — как и в ChatsList.jsx, имени в users
              // нет, оно лежит в bots/{botId}.
              const botSnap = await getDoc(doc(db, "bots", otherUid));
              return {
                id: d.id,
                name: botSnap.exists() ? botSnap.data().name : t("common.unknownUser"),
                isGroup: false,
              };
            }
            const otherSnap = await getDoc(doc(db, "users", otherUid));
            return {
              id: d.id,
              name: otherSnap.exists() ? otherSnap.data().name : t("common.unknownUser"),
              isGroup: false,
            };
          })
      );
      items.sort((a, b) => a.name.localeCompare(b.name));
      setForwardChats(items);
    } catch (err) {
      setForwardError(err.message);
    } finally {
      setForwardChatsLoading(false);
    }
  }

  function closeForward() {
    setForwardMessage(null);
  }

  function toggleForwardChat(id) {
    setForwardSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Собственно пересылка — для фото/файла обязательно копируем байты в
  // НОВЫЙ fileBlobs-документ, привязанный к чату-получателю (см.
  // FileTransferContext.jsx -> copyFileToChat): так открыть присланное фото
  // сможет только тот, кому реально переслали (или все участники группы,
  // если переслали в группу), а не вообще все, кто состоял в исходном чате.
  async function handleForwardConfirm() {
    if (!forwardMessage || forwardSelected.size === 0) return;
    setForwardSending(true);
    setForwardError("");
    try {
      const forwardedFrom = {
        senderId: forwardMessage.senderId,
        senderName: senderNameFor(forwardMessage.senderId) || t("common.unknownUser"),
      };
      for (const destChatId of forwardSelected) {
        const ts = serverTimestamp();
        const base = { senderId: user.uid, createdAt: ts, forwardedFrom };
        let previewText;
        if (forwardMessage.fileMeta) {
          const msgRef = doc(collection(db, "chats", destChatId, "messages"));
          const fileMeta = await fileTransfer.copyFileToChat(forwardMessage.id, destChatId, msgRef.id);
          await setDoc(msgRef, { ...base, fileMeta });
          previewText = fileMeta.mimeType.startsWith("image/")
            ? t("chatWindow.photoPreview")
            : `📎 ${fileMeta.name}`;
        } else if (forwardMessage.stickerId) {
          await addDoc(collection(db, "chats", destChatId, "messages"), {
            ...base,
            stickerId: forwardMessage.stickerId,
          });
          previewText = t("chatWindow.stickerPreview");
        } else if (forwardMessage.audio) {
          await addDoc(collection(db, "chats", destChatId, "messages"), {
            ...base,
            audio: forwardMessage.audio,
            mimeType: forwardMessage.mimeType,
            duration: forwardMessage.duration,
          });
          previewText = t("chatWindow.voiceMessagePreview");
        } else {
          await addDoc(collection(db, "chats", destChatId, "messages"), {
            ...base,
            text: forwardMessage.text,
          });
          previewText = forwardMessage.text;
        }
        await updateDoc(doc(db, "chats", destChatId), {
          lastMessage: {
            text: previewText,
            senderId: user.uid,
            senderName: profile?.name || null,
            createdAt: ts,
          },
          updatedAt: ts,
        });
      }
      setForwardDone(true);
    } catch (err) {
      setForwardError(err.message);
    } finally {
      setForwardSending(false);
    }
  }

  // "Очистить чат полностью у обоих" — только для личных чатов (см.
  // firestore.rules: resource.data.isGroup == false в правиле clearRequest).
  // Запрос — своим полем chats/{chatId}.clearRequest, отвечает СОБЕСЕДНИК
  // (не сам инициатор), а фактическое удаление всех сообщений/файлов
  // выполняет тот, кто принял запрос (см. respondClearRequest ниже) —
  // правила Firestore на время status=='accepted' разрешают любому
  // участнику удалить ЛЮБОЕ сообщение в этом чате, не только своё.
  async function requestClearChat() {
    if (!chatMeta || chatMeta.isGroup || chatMeta.isSystem || chatMeta.isBotChat) return;
    setClearRequestError("");
    setClearRequestBusy(true);
    try {
      await updateDoc(doc(db, "chats", chatId), {
        clearRequest: { by: user.uid, at: serverTimestamp(), status: "pending" },
      });
      setShowActions(false);
    } catch (err) {
      setClearRequestError(err.message);
    } finally {
      setClearRequestBusy(false);
    }
  }

  async function cancelClearRequest() {
    setClearRequestError("");
    setClearRequestBusy(true);
    try {
      await updateDoc(doc(db, "chats", chatId), { "clearRequest.status": "none" });
    } catch (err) {
      setClearRequestError(err.message);
    } finally {
      setClearRequestBusy(false);
    }
  }

  async function respondClearRequest(accept) {
    setClearRequestError("");
    setClearRequestBusy(true);
    try {
      if (!accept) {
        await updateDoc(doc(db, "chats", chatId), { "clearRequest.status": "declined" });
        return;
      }
      await updateDoc(doc(db, "chats", chatId), { "clearRequest.status": "accepted" });
      // Фактическая очистка: удаляем все сообщения (свои и чужие — правила
      // разрешают это именно сейчас, пока clearRequest.status == 'accepted')
      // и связанные с ними файлы, и на сервере, и локально на этом устройстве.
      await Promise.all(
        messages.map(async (m) => {
          await deleteDoc(doc(db, "chats", chatId, "messages", m.id)).catch(() => {});
          if (m.fileMeta) await fileTransfer.deleteOwnFile(m.id);
        })
      );
      await updateDoc(doc(db, "chats", chatId), {
        "clearRequest.status": "none",
        lastMessage: null,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      setClearRequestError(err.message);
    } finally {
      setClearRequestBusy(false);
    }
  }

  if (profile?.banned) {
    return <div className="panel">{t("chatWindow.banned")}</div>;
  }

  const otherOnline = isOnline(other?.lastActive, now);
  const isGroup = !!chatMeta?.isGroup;
  const isSystem = !!chatMeta?.isSystem;
  const isBotChat = !!chatMeta?.isBotChat;
  // Пользовательский бот (см. utils/customBots.js) отличается от встроенных
  // (@stars_bot/@stiller_bot) тем, что с ним можно переписываться свободным
  // текстом, а не только фиксированными кнопками — см. BotComposeRow ниже.
  const isCustomBotChat = isBotChat && !!other?.isCustomBot;
  const isOwner = isGroup && chatMeta?.ownerId === user.uid;
  // Права в группе: владельцу можно всё, администратору — то, что ему оставил
  // владелец (см. utils/groupRoles.js; те же проверки продублированы в
  // firestore.rules, здесь они только прячут кнопки).
  const canMakeLinks = isGroup && canInGroup(chatMeta, user.uid, "links");
  const canInvitePeople = isGroup && canInGroup(chatMeta, user.uid, "invite");
  const canRemovePeople = isGroup && canInGroup(chatMeta, user.uid, "remove");
  const canRenameGroup = isGroup && canInGroup(chatMeta, user.uid, "rename");
  // "Без звука" — своя (per-chat) заглушка уведомлений (см. mutedFor в
  // firestore.rules), не путать с общим тумблером "не уведомлять меня"
  // в SettingsView.jsx (profile.notificationsMuted). Доступно везде, кроме
  // "Системных сообщений" — они и так важны и их немного.
  const isMuted = !!chatMeta?.mutedFor?.[user.uid];
  const isBlocked = !isSystem && !isBotChat && !isGroup && (iBlockedThem || theyBlockedMe);
  // Личный чат с @kazino_bot (см. utils/kazinoBot.js -> ensureKazinoBotChat)
  // — isBotChat + botUid ставятся при создании чата, поэтому достаточно
  // сверить botUid, не дожидаясь асинхронной загрузки профиля "other".
  const isKazinoBotChat = isBotChat && chatMeta?.botUid === KAZINO_BOT_ID;
  // Личный чат с @stiller_bot — это ОБЫЧНЫЙ чат (isBotChat не ставится, см.
  // FriendsSearch.jsx -> openBotChat), потому что /kazik и /wheel работают в
  // любом чате, не только с самим ботом (см. utils/stillerBot.js). Из-за
  // этого при открытии чата снаружи не видно, что боту вообще можно что-то
  // написать — проверяем members напрямую (не дожидаясь загрузки "other"),
  // чтобы сразу показать подсказку-кнопки под полем ввода.
  const isStillerBotChat = !isGroup && !isSystem && !!chatMeta?.members?.includes(STILLER_BOT_UID);

  const clearedAt = chatMeta?.clearedFor?.[user.uid];
  const clearedAtMs = clearedAt?.toMillis ? clearedAt.toMillis() : null;
  const visibleMessages = clearedAtMs
    ? messages.filter((m) => !m.createdAt || m.createdAt.toMillis() > clearedAtMs)
    : messages;

  // Все фото-сообщения этого чата по порядку — по ним листает полноэкранная
  // галерея (PhotoViewer), а не только по той картинке, на которую нажали.
  const chatImages = visibleMessages.filter(
    (m) => m.fileMeta && (m.fileMeta.mimeType || "").startsWith("image/")
  );
  function openPhoto(messageId) {
    const idx = chatImages.findIndex((m) => m.id === messageId);
    if (idx !== -1) setPhotoViewerIndex(idx);
  }

  // Фон переписки: обычно свой собственный (profile.chatWallpaper), но если
  // собеседник купил и включил трансляцию (см. utils/wallpapers.js ->
  // buyWallpaperBroadcast/setBroadcastWallpaper), в личном чате с ним
  // показываем ЕГО фон вместо своего — это премиум-фича "мой фон видят все,
  // кто мне пишут". "custom" — не CSS-класс, а своя фотография
  // (customWallpaperImage), накладывается инлайн-стилем.
  const wallpaperOwner =
    !isGroup && !isSystem && other?.broadcastWallpaper && other?.chatWallpaper ? other : profile;
  const wallpaperKey = wallpaperOwner?.chatWallpaper || null;
  const isCustomWallpaper = wallpaperKey === "custom" && !!wallpaperOwner?.customWallpaperImage;
  const pinnedMessage = isSystem
    ? [...visibleMessages].reverse().find((m) => m.pinned)
    : null;

  // "Прочитано" (одна/две галочки) — сообщение считается прочитанным, если
  // ВСЕ остальные участники чата отметились в lastReadAt позже, чем оно
  // отправлено. В личном чате это ровно один человек (как в WhatsApp), в
  // группе — все, кроме автора (упрощение: без разбивки "кто именно прочитал").
  function messageReadStatus(m) {
    if (!m.createdAt?.toMillis || !chatMeta?.members) return "sent";
    const msgMs = m.createdAt.toMillis();
    const others = chatMeta.members.filter((uid) => uid !== m.senderId);
    if (others.length === 0) return "sent";
    const allRead = others.every((uid) => {
      const ts = chatMeta.lastReadAt?.[uid];
      return (ts?.toMillis ? ts.toMillis() : 0) >= msgMs;
    });
    return allRead ? "read" : "sent";
  }

  // typingTick (см. эффект выше) специально дёргает ре-рендер каждые 2с,
  // чтобы isTyping() честно "остывал", даже если chatMeta какое-то время не
  // менялся (иначе "печатает…" висело бы до следующего снапшота).
  const typingNames = !isGroup && !isSystem && !isBotChat
    ? (() => {
        const otherUid = chatMeta?.members?.find((m) => m !== user.uid);
        return otherUid && isTyping(chatMeta?.typing?.[otherUid], typingTick) ? [other?.name || "…"] : [];
      })()
    : isGroup
    ? (chatMeta?.members || [])
        .filter((uid) => uid !== user.uid && isTyping(chatMeta?.typing?.[uid], typingTick))
        .map((uid) => membersById[uid]?.name || "…")
    : [];
  const clearRequest = chatMeta?.clearRequest;
  const clearRequestPending = clearRequest?.status === "pending";
  const clearRequestIsMine = clearRequestPending && clearRequest?.by === user.uid;

  return (
    <div className="chat-window">
      <div className="chat-header">
        <button
          type="button"
          className="link-btn chat-header-back-btn"
          title={t("chatWindow.close")}
          onClick={() => navigate("/")}
        >
          ←
        </button>
        {!isSystem && !isGroup && (
          <button
            type="button"
            className="chat-header-avatar-btn"
            title={t("chatWindow.viewProfile")}
            onClick={() => setShowProfileCard(true)}
          >
            <UserAvatar profile={other} fallback={firstChar(other?.name)} size={36} />
          </button>
        )}
        <div className="chat-header-info">
          {isSystem ? (
            <>
              <b>{t("chatWindow.systemChatTitle")}</b>
              <span className="muted" style={{ fontSize: 12 }}>
                {t("chatWindow.systemChatSubtitle")}
              </span>
            </>
          ) : isGroup ? (
            <>
              <b>
                {chatMeta?.name}
                <VerifiedBadge show={chatMeta?.verifiedBadge} />
              </b>
              {chatMeta?.verifiedBadge && (
                <span className="verified-label">{t("chatWindow.verifiedGroupLabel")}</span>
              )}
              {typingNames.length > 0 ? (
                <span className="presence typing">{t("chatWindow.typingLabel", { names: typingNames.join(", ") })}</span>
              ) : (
                <span className="muted" style={{ fontSize: 12 }}>
                  {t("chatWindow.membersCount", { count: chatMeta?.members?.length || 0 })}
                </span>
              )}
            </>
          ) : (
            <>
              <b>
                <NicknameText profile={other}>{other?.name || "..."}</NicknameText>
                <VerifiedBadge show={other?.verifiedBadge} />
              </b>
              {isCustomBotChat ? (
                <span className="muted" style={{ fontSize: 12 }}>{other?.bio || t("customBots.chatSubtitle")}</span>
              ) : isBotChat ? (
                <span className="muted" style={{ fontSize: 12 }}>{t("botChat.subtitle")}</span>
              ) : theyBlockedMe ? (
                <span className="presence blocked">{t("chatWindow.blockedByThem")}</span>
              ) : iBlockedThem ? (
                <>
                  <span className="presence blocked">{t("chatWindow.blockedByMe")}</span>
                  <button type="button" className="unblock-btn" onClick={unblockUser}>
                    {t("chatWindow.unblock")}
                  </button>
                </>
              ) : typingNames.length > 0 ? (
                <span className="presence typing">{t("chatWindow.typingLabel1")}</span>
              ) : (
                other && (
                  <span className={"presence " + (otherOnline ? "online" : "offline")}>
                    <span className="presence-dot" />
                    {otherOnline ? t("chatWindow.online") : t("chatWindow.offline")}
                  </span>
                )
              )}
            </>
          )}
        </div>
        <div className="chat-header-actions" style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          {!isGroup && !isSystem && !isBotChat && !isBlocked && (
            <button
              className="link-btn"
              title={t("chatWindow.callTitle")}
              disabled={!!callState || inGroupCall}
              onClick={handleCallClick}
            >
              📞
            </button>
          )}
          {isGroup && canStartGroupCall(chatMeta, user.uid) && (
            <button
              className="link-btn"
              title={t("groupCalls.startTitle")}
              disabled={!!callState || inGroupCall}
              onClick={openGroupCallPicker}
            >
              📞
            </button>
          )}
          {isGroup && (
            <button className="link-btn" title={t("chatWindow.manageMembersTitle")} onClick={openManage}>
              ⚙
            </button>
          )}
          <button
            className="link-btn"
            title={t("chatWindow.chatActionsTitle")}
            onClick={() => {
              setActionsError("");
              setShowActions(true);
            }}
          >
            ⋮
          </button>
        </div>
      </div>
      {(offlineMode || pendingCount > 0) && (
        <div className="offline-banner">
          {pendingCount > 0
            ? t("chatWindow.offlinePending", { count: pendingCount })
            : t("chatWindow.offlineBanner")}
        </div>
      )}
      {isGroup && liveGroupCall && groupCall?.id !== liveGroupCall.id && (
        <div className="group-call-banner">
          <span>
            {t("groupCalls.liveBanner", {
              count: (liveGroupCall.participants || []).length,
            })}
          </span>
          {/* Если сервер уже считает меня участником, а на экране звонка нет
              — это сбой входа, и кнопка должна ВЕРНУТЬ в звонок, а не гаснуть. */}
          <button
            type="button"
            disabled={
              !!callState ||
              inGroupCall ||
              !(
                canJoinGroupCall(chatMeta, liveGroupCall, user.uid) ||
                shouldRejoinGroupCall(chatMeta, liveGroupCall, user.uid)
              )
            }
            onClick={handleJoinGroupCall}
          >
            {shouldRejoinGroupCall(chatMeta, liveGroupCall, user.uid)
              ? t("groupCalls.rejoinBtn")
              : t("groupCalls.joinBtn")}
          </button>
        </div>
      )}
      {clearRequestPending && (
        <div className="clear-request-banner">
          {clearRequestIsMine ? (
            <>
              <span>{t("chatWindow.clearRequestWaiting")}</span>
              <button type="button" className="secondary" disabled={clearRequestBusy} onClick={cancelClearRequest}>
                {t("common.cancel")}
              </button>
            </>
          ) : (
            <>
              <span>{t("chatWindow.clearRequestIncoming")}</span>
              <div className="row-buttons">
                <button type="button" disabled={clearRequestBusy} onClick={() => respondClearRequest(true)}>
                  {t("chatWindow.accept")}
                </button>
                <button type="button" className="secondary" disabled={clearRequestBusy} onClick={() => respondClearRequest(false)}>
                  {t("chatWindow.decline")}
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {clearRequestError && <div className="error" style={{ padding: "0 12px" }}>{clearRequestError}</div>}
      <StillerGameBanner game={activeGame} onCancel={cancelActiveGame} t={t} />
      <div
        className={
          "messages" + (wallpaperKey && !isCustomWallpaper ? " wallpaper-" + wallpaperKey : "")
        }
        style={
          isCustomWallpaper
            ? {
                backgroundImage: `url(${wallpaperOwner.customWallpaperImage})`,
                backgroundSize: "cover",
                backgroundPosition: "center",
              }
            : undefined
        }
      >
        {pinnedMessage && (
          <div className="pinned-banner">
            <span className="pinned-banner-icon">📌</span>
            <span>{linkifyText(systemMessageText(pinnedMessage, t))}</span>
          </div>
        )}
        {visibleMessages.map((m, i) => {
          const mine = m.senderId === user.uid;
          const isLast = i === visibleMessages.length - 1;
          const senderProfile = senderProfileFor(m.senderId);
          const textColor =
            !isSystem && !m.stickerId && !m.giftId ? equippedTextColor(senderProfile) : null;
          // Аватарка слева от сообщения — только в группах и только у чужих
          // сообщений, как в Telegram/WhatsApp. Чтобы не повторять её под
          // каждым сообщением подряд от одного автора, показываем только на
          // последнем сообщении такой "пачки" — у остальных вместо неё
          // невидимый отступ той же ширины, чтобы пузыри не съезжали.
          const nextMsg = visibleMessages[i + 1];
          const showGroupAvatar = isGroup && !mine && (!nextMsg || nextMsg.senderId !== m.senderId);
          return (
            <MessageRow
              key={m.id}
              m={m}
              mine={mine}
              isLast={isLast}
              isGroup={isGroup}
              isSystem={isSystem}
              isBotChat={isBotChat}
              showGroupAvatar={showGroupAvatar}
              membersById={membersById}
              textColor={textColor}
              chatId={chatId}
              user={user}
              t={t}
              profile={profile}
              readStatus={mine ? messageReadStatus(m) : null}
              onReply={startReply}
              onDelete={handleDelete}
              onEdit={handleEditMessage}
              onForward={openForward}
              onOpenPhoto={openPhoto}
              onCustomBotButton={handleCustomBotButton}
            />
          );
        })}
        <div ref={bottomRef} />
      </div>
      {isStillerBotChat && !isBlocked && !activeGame && !lockedCommand && (
        <div className="stiller-quick-row" style={{ display: "flex", gap: 8, margin: "0 12px 8px" }}>
          <button type="button" className="secondary" style={{ width: "auto" }} onClick={() => quickStillerCommand("/kazik")}>
            🎰 {t("stillerBot.kazikQuickBtn")}
          </button>
          <button type="button" className="secondary" style={{ width: "auto" }} onClick={() => quickStillerCommand("/wheel")}>
            🎡 {t("stillerBot.wheelQuickBtn")}
          </button>
        </div>
      )}
      {activeGame?.kind === "kazik" && (
        <div className="kazik-reels spinning">
          <span>🎰</span>
          <span>🎰</span>
          <span>🎰</span>
        </div>
      )}
      {activeGame?.kind === "wheel" && (
        <div style={{ textAlign: "center", padding: "6px 0" }}>
          <span className="stiller-bot-banner-icon" style={{ fontSize: 28 }}>
            🎡
          </span>
        </div>
      )}
      {lockedCommand && (
        <div className="locked-command-row" style={{ margin: "0 12px" }}>
          <span>
            {lockedCommand.kind === "kazik" ? t("stillerBot.kazikLockedError") : t("stillerBot.wheelLockedError")}
          </span>
          <button type="button" disabled={buyingLocked} onClick={handleBuyLockedCommand}>
            {t(lockedCommand.kind === "kazik" ? "shop.kazikBuyBtn" : "shop.wheelBuyBtn", {
              price: lockedCommand.kind === "kazik" ? KAZIK_PRICE : WHEEL_PRICE,
            })}
          </button>
          <button type="button" className="secondary" disabled={buyingLocked} onClick={() => setLockedCommand(null)}>
            {t("chatWindow.cancelEdit")}
          </button>
        </div>
      )}
      {commandError && <div className="error" style={{ padding: "0 12px" }}>{commandError}</div>}
      {voiceError && <div className="error" style={{ padding: "0 12px" }}>{voiceError}</div>}
      {attachError && <div className="error" style={{ padding: "0 12px" }}>{attachError}</div>}
      {stickerError && <div className="error" style={{ padding: "0 12px" }}>{stickerError}</div>}
      {giftError && <div className="error" style={{ padding: "0 12px" }}>{giftError}</div>}
      <input
        type="file"
        ref={fileInputRef}
        style={{ display: "none" }}
        onChange={handleAttach}
      />
      {isSystem ? (
        <div className="chat-blocked-notice">{t("chatWindow.systemChatNotice")}</div>
      ) : isKazinoBotChat ? (
        <KazinoComposeRow chatId={chatId} uid={user.uid} profile={profile} t={t} />
      ) : isCustomBotChat ? (
        <CustomBotComposeRow chatId={chatId} uid={user.uid} bot={other} profile={profile} />
      ) : isBotChat ? (
        <BotComposeRow chatId={chatId} uid={user.uid} profile={profile} />
      ) : isBlocked ? (
        <div className="chat-blocked-notice">
          {theyBlockedMe ? t("chatWindow.blockedNoticeThem") : t("chatWindow.blockedNoticeMe")}
        </div>
      ) : recording ? (
        <div className="send-row">
          <div className="recording-indicator">{t("chatWindow.recording", { duration: formatDuration(recordSeconds) })}</div>
          <button type="button" className="secondary" onClick={cancelRecording}>
            {t("chatWindow.cancel")}
          </button>
          <button type="button" onClick={stopRecording}>
            {t("chatWindow.send")}
          </button>
        </div>
      ) : (
        <div className="compose-area">
          {replyTo && (
            <div className="reply-preview-bar">
              <div className="reply-preview-body">
                <b>{replyTo.senderId === user.uid ? t("chatWindow.you") : senderNameFor(replyTo.senderId) || t("common.unknownUser")}</b>
                <div className="reply-quote-text">{messagePreviewText(replyTo, t)}</div>
              </div>
              <button type="button" className="reply-preview-close" onClick={() => setReplyTo(null)}>
                ✕
              </button>
            </div>
          )}
          <div className="compose-toolbar">
            <button
              type="button"
              className="toolbar-btn"
              title={t("stickers.sendTitle")}
              onClick={() => setShowStickerPicker(true)}
            >
              🌟
            </button>
            <button
              type="button"
              className="toolbar-btn"
              title={t("chatWindow.attachTitle")}
              onClick={() => fileInputRef.current?.click()}
            >
              📎
            </button>
            <button
              type="button"
              className="toolbar-btn"
              title={t("chatWindow.voiceTitle")}
              onClick={startRecording}
            >
              🎤
            </button>
          </div>
          <form className="send-row" onSubmit={handleSend}>
            <input
              value={text}
              onChange={handleTextChange}
              placeholder={t("chatWindow.messagePlaceholder")}
            />
            <button type="submit">{t("chatWindow.send")}</button>
          </form>
        </div>
      )}

      {showStickerPicker && (
        <StickerPicker
          uid={user.uid}
          profile={profile}
          onSend={sendSticker}
          canGift={!isGroup && !isSystem && !isBotChat}
          onSendGift={sendGiftToChat}
          onSendStars={sendStarsGiftToChat}
          onClose={() => setShowStickerPicker(false)}
        />
      )}

      {showActions && chatMeta && (
        <div className="modal-backdrop" onClick={() => setShowActions(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{t("chatWindow.chatActionsTitle")}</h3>
            <div className="chat-actions-menu">
              {!isSystem && (
                <button type="button" className="secondary" onClick={toggleMuteChat}>
                  {isMuted ? t("chatWindow.unmuteAction") : t("chatWindow.muteAction")}
                </button>
              )}
              <button type="button" className="secondary" onClick={clearHistory}>
                {t("chatWindow.clearHistory")}
              </button>
              {!isGroup && !isSystem && !isBotChat && !clearRequestPending && (
                <button type="button" className="secondary" disabled={clearRequestBusy} onClick={requestClearChat}>
                  {t("chatWindow.clearForBothAction")}
                </button>
              )}
              {!isGroup && !isSystem && !isBotChat &&
                (iBlockedThem ? (
                  <button type="button" className="secondary" onClick={unblockUser}>
                    {t("chatWindow.unblockAction")}
                  </button>
                ) : (
                  <button type="button" className="secondary" onClick={handleBlockClick}>
                    {t("chatWindow.blockAction")}
                  </button>
                ))}
              {!isGroup && !isSystem && !isBotChat && (
                <button type="button" className="secondary" onClick={handleRemoveContactClick}>
                  {t("chatWindow.removeContactAction")}
                </button>
              )}
              {!isSystem && (
                <button type="button" className="secondary danger" onClick={() => deleteChat()}>
                  {t("chatWindow.deleteChat")}
                </button>
              )}
              {!isGroup && !isSystem && !isBotChat && (
                <button
                  type="button"
                  className="secondary danger"
                  onClick={() => deleteChat({ alsoBlock: true })}
                >
                  {t("chatWindow.deleteAndBlock")}
                </button>
              )}
            </div>
            {actionsError && <div className="error">{actionsError}</div>}
            <button
              type="button"
              className="secondary"
              style={{ marginTop: 16 }}
              onClick={() => setShowActions(false)}
            >
              {t("chatWindow.close")}
            </button>
          </div>
        </div>
      )}

      {showGroupCallPicker && chatMeta && (
        <CallMemberPicker
          people={(chatMeta.members || [])
            // Ботам звонить некуда — у них нет ни браузера, ни микрофона
            // (см. utils/stillerBot.js, utils/customBots.js).
            .filter((uid) => uid !== user.uid && uid !== STILLER_BOT_UID && !membersById[uid]?.isBot)
            .map((uid) => ({ id: uid, ...(membersById[uid] || {}) }))}
          busyIds={liveGroupCall ? [...(liveGroupCall.participants || []), ...(liveGroupCall.invited || [])] : []}
          limit={MAX_PARTICIPANTS - 1}
          title={t("groupCalls.startTitle")}
          confirmLabel={t("groupCalls.startConfirm")}
          onClose={() => setShowGroupCallPicker(false)}
          onConfirm={async (uids) => {
            setShowGroupCallPicker(false);
            // Звонок в этой группе уже идёт — второй не создаём: заходим в
            // существующий и уже оттуда дозваниваемся выбранным.
            if (liveGroupCall) {
              await joinGroupCall(liveGroupCall.id, chatId);
              await inviteToCall(uids);
              return;
            }
            await startGroupCall({ id: chatId, ...chatMeta }, uids);
          }}
        />
      )}

      {showManage && chatMeta && (
        <div className="modal-backdrop" onClick={() => setShowManage(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>
              {chatMeta.name}
              <VerifiedBadge show={chatMeta.verifiedBadge} />
            </h3>

            {canMakeLinks && (
              <>
                <label>{t("chatWindow.inviteLinkLabel")}</label>
                <p className="muted" style={{ fontSize: 12, margin: "2px 0 8px" }}>
                  {t("chatWindow.inviteLinkHint")}
                </p>
                <div className="search-row link-row">
                  <select value={linkDuration} onChange={(e) => setLinkDuration(e.target.value)}>
                    {LINK_DURATIONS.map((d) => (
                      <option key={d.key} value={d.key}>
                        {t(`chatWindow.linkDuration_${d.key}`)}
                      </option>
                    ))}
                  </select>
                  <input
                    value={linkForTag}
                    onChange={(e) => setLinkForTag(e.target.value)}
                    placeholder={t("chatWindow.linkForTagPlaceholder")}
                  />
                  <button type="button" onClick={makeLink} disabled={linksBusy}>
                    {linksBusy ? t("chatWindow.linkCreating") : t("chatWindow.createLink")}
                  </button>
                </div>

                {links.length === 0 && (
                  <p className="muted" style={{ fontSize: 12 }}>{t("chatWindow.noLinks")}</p>
                )}
                {links.map((l) => {
                  const active = isLinkActive(l);
                  return (
                    <div className="user-card link-card" key={l.id}>
                      <div style={{ minWidth: 0 }}>
                        <b style={{ fontSize: 13 }}>
                          {l.forUid
                            ? t("chatWindow.linkPersonal", {
                                name: membersById[l.forUid]?.name || l.forUid.slice(0, 6),
                              })
                            : t("chatWindow.linkCommon")}
                        </b>
                        <p className="muted" style={{ fontSize: 12, margin: "2px 0 0" }}>
                          {l.revoked
                            ? t("chatWindow.linkRevoked")
                            : l.expiresAt
                              ? t("chatWindow.linkUntil", {
                                  date: l.expiresAt.toDate().toLocaleString(),
                                })
                              : t("chatWindow.linkForever")}
                        </p>
                      </div>
                      {!l.revoked && (
                      <div className="link-card-actions">
                        {active && (
                          <button type="button" className="secondary" onClick={() => copyLink(l.id)}>
                            {linkCopied && copiedLinkId === l.id
                              ? t("chatWindow.linkCopied")
                              : t("chatWindow.copyLink")}
                          </button>
                        )}
                        <button type="button" className="secondary" onClick={() => killLink(l.id)}>
                          {t("chatWindow.revokeLink")}
                        </button>
                      </div>
                      )}
                    </div>
                  );
                })}
              </>
            )}

            {isOwner && (
              <>
                <label style={{ marginTop: 16 }}>{t("groupCalls.permissionLabel")}</label>
                <div className="user-card">
                  <div>
                    <b>{t("groupCalls.permissionMembersTitle")}</b>
                    <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
                      {chatMeta.callByMembers
                        ? t("groupCalls.permissionMembersOn")
                        : t("groupCalls.permissionMembersOff")}
                    </p>
                  </div>
                  <button type="button" className="secondary" disabled={callPermBusy} onClick={toggleCallByMembers}>
                    {chatMeta.callByMembers ? t("groupCalls.permissionTurnOff") : t("groupCalls.permissionTurnOn")}
                  </button>
                </div>

                {/* Что позволено администраторам. Настраивает только владелец:
                    иначе администратор выписал бы себе любые права сам. */}
                <label style={{ marginTop: 16 }}>{t("chatWindow.adminRightsLabel")}</label>
                <p className="muted" style={{ fontSize: 12, margin: "2px 0 8px" }}>
                  {t("chatWindow.adminRightsHint")}
                </p>
                {ADMIN_RIGHT_KEYS.map((key) => (
                  <div className="user-card" key={key}>
                    <div>
                      <b style={{ fontSize: 13 }}>{t(`chatWindow.adminRight_${key}`)}</b>
                    </div>
                    <button
                      type="button"
                      className={"toggle-switch" + (groupAdminRights(chatMeta)[key] ? " on" : "")}
                      disabled={rolesBusy}
                      onClick={() => toggleAdminRight(key)}
                      aria-label={t(`chatWindow.adminRight_${key}`)}
                    >
                      <span className="toggle-knob" />
                    </button>
                  </div>
                ))}
              </>
            )}

            {canRenameGroup && (
              <>
                <label>{t("chatWindow.groupNameLabel")}</label>
                <div className="search-row">
                  <input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} />
                  <button type="button" onClick={renameGroup} disabled={renaming}>
                    {t("common.save")}
                  </button>
                </div>
              </>
            )}

            <label style={{ marginTop: 16 }}>
              {t("chatWindow.membersLabel", { count: chatMeta.members.length })}
            </label>
            {chatMeta.members.map((uid) => (
              <div className="user-card" key={uid}>
                <div>
                  <b>
                    {membersById[uid]?.name || "..."}
                    <VerifiedBadge show={membersById[uid]?.verifiedBadge} />
                  </b>{" "}
                  {uid === chatMeta.ownerId ? (
                    <span className="muted">{t("chatWindow.creatorLabel")}</span>
                  ) : (
                    isGroupAdmin(chatMeta, uid) && (
                      <span className="muted">{t("chatWindow.adminLabel")}</span>
                    )
                  )}
                </div>
                <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                  {isOwner && uid !== user.uid && uid !== chatMeta.ownerId && (
                    <button
                      className="secondary"
                      disabled={rolesBusy}
                      onClick={() => setAdmin(uid, !isGroupAdmin(chatMeta, uid))}
                    >
                      {isGroupAdmin(chatMeta, uid)
                        ? t("chatWindow.demoteAdmin")
                        : t("chatWindow.promoteAdmin")}
                    </button>
                  )}
                  {canRemovePeople &&
                    uid !== user.uid &&
                    uid !== chatMeta.ownerId &&
                    // Администратор не может выкинуть другого администратора —
                    // иначе роль превращается в захват группы (то же условие
                    // стоит в firestore.rules).
                    (isOwner || !isGroupAdmin(chatMeta, uid)) &&
                    chatMeta.members.length > 2 && (
                      <button className="secondary" onClick={() => removeMember(uid)}>
                        {t("chatWindow.removeMember")}
                      </button>
                    )}
                </div>
              </div>
            ))}

            {canInvitePeople && (
              <>
                <label style={{ marginTop: 16 }}>{t("chatWindow.addByTagLabel")}</label>
                <div className="search-row" style={{ position: "relative" }}>
                  <input
                    value={addTagInput}
                    onChange={(e) => setAddTagInput(e.target.value)}
                    placeholder="@tag"
                  />
                  <button type="button" onClick={searchAddTag}>
                    {t("chatWindow.find")}
                  </button>
                  {addTagSuggestions.length > 0 && (
                    <div className="suggestions-dropdown">
                      {addTagSuggestions.map((u) => (
                        <div
                          key={u.id}
                          className="suggestion-row"
                          onClick={() => pickAddTagSuggestion(u)}
                        >
                          <b>
                            {u.name}
                            <VerifiedBadge show={u.verifiedBadge} />
                          </b>{" "}
                          <span className="muted">@{u.tag}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {addTagResult && (
                  <div className="user-card">
                    <div>
                      <b>
                        {addTagResult.name}
                        <VerifiedBadge show={addTagResult.verifiedBadge} />
                      </b>{" "}
                      <span className="muted">@{addTagResult.tag}</span>
                      {!contactIds.has(addTagResult.id) && (
                        <p className="muted" style={{ fontSize: 12 }}>
                          {t("chatWindow.notInContacts")}
                        </p>
                      )}
                    </div>
                    <button type="button" onClick={confirmAddMember}>
                      {contactIds.has(addTagResult.id) ? t("chatWindow.add") : t("chatWindow.invite")}
                    </button>
                  </div>
                )}
                {addSuccessMsg && <div className="info">{addSuccessMsg}</div>}
              </>
            )}

            {manageError && <div className="error">{manageError}</div>}

            <div className="row-buttons" style={{ marginTop: 16 }}>
              {!isOwner && (
                <button className="secondary" onClick={leaveGroup}>
                  {t("chatWindow.leaveGroup")}
                </button>
              )}
              {isOwner && (
                <button
                  className="secondary danger-btn"
                  onClick={() => {
                    setDeleteProgress(0);
                    setShowDeleteGroup(true);
                  }}
                >
                  {t("chatWindow.deleteGroup")}
                </button>
              )}
              <button className="secondary" onClick={() => setShowManage(false)}>
                {t("chatWindow.close")}
              </button>
            </div>
          </div>
        </div>
      )}

      {showDeleteGroup && chatMeta && (
        <div
          className="modal-backdrop"
          onClick={() => !deletingGroup && setShowDeleteGroup(false)}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{t("chatWindow.deleteGroupTitle")}</h3>
            <p className="muted">
              {t("chatWindow.deleteGroupWarning", { name: chatMeta.name || "" })}
            </p>
            {deletingGroup && (
              <p className="info">
                {t("chatWindow.deleteGroupProgress", { count: deleteProgress })}
              </p>
            )}
            {manageError && <div className="error">{manageError}</div>}
            <div className="row-buttons" style={{ marginTop: 16 }}>
              <button className="danger-btn" onClick={deleteGroup} disabled={deletingGroup}>
                {deletingGroup ? t("chatWindow.deleteGroupBusy") : t("chatWindow.deleteGroupConfirm")}
              </button>
              <button
                className="secondary"
                onClick={() => setShowDeleteGroup(false)}
                disabled={deletingGroup}
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      {showProfileCard && other && (
        <div className="modal-backdrop" onClick={() => setShowProfileCard(false)}>
          <div className="modal profile-card" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="profile-card-close"
              title={t("chatWindow.close")}
              onClick={() => setShowProfileCard(false)}
            >
              ✕
            </button>
            <UserAvatar profile={other} fallback={firstChar(other?.name)} size={96} />
            <h3 className="profile-card-name">
              <NicknameText profile={other}>{other?.name || "..."}</NicknameText>
              <VerifiedBadge show={other?.verifiedBadge} />
            </h3>
            {otherOnline ? (
              <span className="presence online">
                <span className="presence-dot" />
                {t("chatWindow.online")}
              </span>
            ) : (
              <span className="muted" style={{ fontSize: 13 }}>
                {t("chatWindow.offline")}
              </span>
            )}

            <div className="profile-card-actions">
              {!isGroup && !isSystem && !isBotChat && !isBlocked && (
                <button
                  type="button"
                  className="profile-card-action"
                  disabled={!!callState || inGroupCall}
                  onClick={() => {
                    setShowProfileCard(false);
                    handleCallClick();
                  }}
                >
                  <span className="profile-card-action-icon">📞</span>
                  {t("chatWindow.callTitle")}
                </button>
              )}
              {!isSystem && (
                <button
                  type="button"
                  className="profile-card-action"
                  onClick={() => {
                    setShowProfileCard(false);
                    setShowActions(true);
                  }}
                >
                  <span className="profile-card-action-icon">⋯</span>
                  {t("chatWindow.moreAction")}
                </button>
              )}
            </div>

            {(other?.tag || other?.bio || other?.birthdate) && (
              <div className="profile-card-info">
                {other?.tag && (
                  <div className="profile-card-info-row">
                    <span className="profile-card-info-label">{t("tagSetup.label")}</span>
                    <span className="profile-card-info-value">@{other.tag}</span>
                  </div>
                )}
                {other?.bio && (
                  <div className="profile-card-info-row">
                    <span className="profile-card-info-label">{t("profileView.bio")}</span>
                    <span className="profile-card-info-value">{other.bio}</span>
                  </div>
                )}
                {other?.birthdate && (
                  <div className="profile-card-info-row">
                    <span className="profile-card-info-label">{t("profileView.birthdate")}</span>
                    <span className="profile-card-info-value">{other.birthdate}</span>
                  </div>
                )}
              </div>
            )}

            <div className="profile-card-banners">
              <div className="stars-banner" title={t("layout.starsTitle")}>
                ⭐ {other?.stars || 0}
              </div>
              <div className="gifts-banner" title={t("profileView.giftsTitle")}>
                🎁 {other?.ownedGifts?.length || 0}
              </div>
            </div>
          </div>
        </div>
      )}

      {forwardMessage && (
        <div className="modal-backdrop" onClick={closeForward}>
          <div className="modal forward-modal" onClick={(e) => e.stopPropagation()}>
            <h3>{t("chatWindow.forwardModalTitle")}</h3>
            {forwardDone ? (
              <>
                <p className="info" style={{ fontSize: 13 }}>{t("chatWindow.forwardSent")}</p>
                <div className="row-buttons">
                  <button type="button" onClick={closeForward}>{t("common.close")}</button>
                </div>
              </>
            ) : (
              <>
                {forwardChatsLoading ? (
                  <p className="muted" style={{ fontSize: 13 }}>{t("common.loading")}</p>
                ) : forwardChats.length === 0 ? (
                  <p className="muted" style={{ fontSize: 13 }}>{t("chatWindow.forwardNoChats")}</p>
                ) : (
                  <div className="forward-chat-list">
                    {forwardChats.map((c) => (
                      <label key={c.id} className="forward-chat-row">
                        <input
                          type="checkbox"
                          checked={forwardSelected.has(c.id)}
                          onChange={() => toggleForwardChat(c.id)}
                        />
                        <span>{c.isGroup ? "👥 " : ""}{c.name}</span>
                      </label>
                    ))}
                  </div>
                )}
                {forwardError && <div className="error" style={{ fontSize: 12 }}>{forwardError}</div>}
                <div className="row-buttons" style={{ marginTop: 12 }}>
                  <button type="button" className="secondary" onClick={closeForward} disabled={forwardSending}>
                    {t("common.cancel")}
                  </button>
                  <button
                    type="button"
                    disabled={forwardSending || forwardSelected.size === 0}
                    onClick={handleForwardConfirm}
                  >
                    {forwardSending ? t("chatWindow.forwardSending") : t("chatWindow.forwardSendBtn")}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {photoViewerIndex !== null && (
        <PhotoViewer
          images={chatImages}
          startIndex={photoViewerIndex}
          chatId={chatId}
          onClose={() => setPhotoViewerIndex(null)}
        />
      )}
    </div>
  );
}
