import { useEffect, useRef, useState } from "react";
import { doc, getDoc, onSnapshot } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../contexts/AuthContext";
import { useGroupCall } from "../contexts/GroupCallContext";
import { useLanguage } from "../i18n/LanguageContext";
import UserAvatar from "./UserAvatar";
import CallMemberPicker from "./CallMemberPicker";
import { MAX_PARTICIPANTS, canStartGroupCall } from "../utils/groupCalls";

// Экран группового звонка поверх всего приложения (см. монтирование в
// App.jsx): входящий вызов может застать где угодно, а сам разговор должен
// продолжаться, пока человек листает чаты — поэтому его, как и личный звонок,
// можно свернуть в плашку сверху.
function useDuration(active) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) {
      setSeconds(0);
      return undefined;
    }
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [active]);
  return seconds;
}

function formatDuration(total) {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Звук участника. Отдельный <audio> на каждого — в mesh у каждого соединения
// свой поток, микшера, который сложил бы их в один, здесь нет (см.
// utils/groupCalls.js).
function PeerAudio({ stream }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !stream) return;
    el.srcObject = stream;
    el.play?.().catch(() => {});
  }, [stream]);
  return <audio ref={ref} autoPlay playsInline />;
}

function PeerVideo({ stream }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !stream) return;
    el.srcObject = stream;
    el.play?.().catch(() => {});
  }, [stream]);
  // muted — звук этого участника идёт отдельным <audio> выше; без атрибута
  // часть браузеров (особенно Android WebView) блокирует автозапуск видео,
  // которому srcObject проставили программно.
  return <video ref={ref} className="group-call-video" autoPlay playsInline muted />;
}

export default function GroupCallOverlay() {
  const { user, profile } = useAuth();
  const { t } = useLanguage();
  const {
    groupCallState,
    groupCall,
    incomingGroupCall,
    peers,
    muted,
    cameraOn,
    cameraAvailable,
    minimized,
    setMinimized,
    groupCallError,
    clearGroupCallError,
    acceptIncoming,
    declineIncoming,
    endCallForAll,
    leaveCall,
    inviteToCall,
    toggleMute,
    toggleCamera,
    attachLocalVideo,
  } = useGroupCall();

  const [profiles, setProfiles] = useState({}); // uid -> users/{uid}
  const [chat, setChat] = useState(null);
  const [showPicker, setShowPicker] = useState(false);
  // Выход из группового звонка спрашивает, что именно сделать: выйти самому
  // (разговор продолжается без меня, вернуться можно по плашке в чате) или
  // завершить звонок для всех. Раньше кнопка была одна и вела себя по-разному
  // в зависимости от того, остался ли кто-то ещё, — угадать это по кнопке было
  // невозможно.
  const [showLeaveChoice, setShowLeaveChoice] = useState(false);
  const seconds = useDuration(groupCallState === "active");

  const activeCall = groupCall || incomingGroupCall;
  const chatId = activeCall?.chatId;

  // Состав группы нужен, чтобы знать, кого ещё можно позвать и можно ли мне
  // это делать (см. utils/groupCalls.js -> canStartGroupCall).
  useEffect(() => {
    if (!chatId) {
      setChat(null);
      return undefined;
    }
    const unsub = onSnapshot(doc(db, "chats", chatId), (snap) => {
      setChat(snap.exists() ? { id: snap.id, ...snap.data() } : null);
    });
    return () => unsub();
  }, [chatId]);

  // Имена и аватарки участников звонка и тех, кому звоним.
  useEffect(() => {
    const needed = [
      ...(activeCall?.participants || []),
      ...(activeCall?.invited || []),
      ...(chat?.members || []),
    ];
    const missing = [...new Set(needed)].filter((uid) => uid && !profiles[uid]);
    if (!missing.length) return;
    let cancelled = false;
    (async () => {
      const loaded = {};
      await Promise.all(
        missing.map(async (uid) => {
          try {
            const snap = await getDoc(doc(db, "users", uid));
            if (snap.exists()) loaded[uid] = { id: uid, ...snap.data() };
          } catch {
            /* нет доступа к профилю — покажем просто заглушку */
          }
        })
      );
      if (!cancelled && Object.keys(loaded).length) {
        setProfiles((prev) => ({ ...prev, ...loaded }));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCall?.participants, activeCall?.invited, chat?.members]);

  // Ошибка могла случиться ровно в момент, когда экран звонка закрывается
  // (не дали доступ к микрофону, звонок успел заполниться) — тогда показываем
  // её отдельной карточкой, иначе человек увидел бы просто молча закрывшийся
  // экран.
  if (!groupCallState) {
    if (!groupCallError) return null;
    return (
      <div className="modal-backdrop call-overlay" onClick={clearGroupCallError}>
        <div className="modal call-modal" onClick={(e) => e.stopPropagation()}>
          <h3>{t("groupCalls.startTitle")}</h3>
          <div className="error">{groupCallError}</div>
          <div className="call-actions">
            <button type="button" className="call-btn" onClick={clearGroupCallError}>
              {t("common.close")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const nameOf = (uid) => (uid === user?.uid ? profile?.name : profiles[uid]?.name) || t("common.unknownUser");
  const profileOf = (uid) => (uid === user?.uid ? profile : profiles[uid]);

  // --- входящий вызов --------------------------------------------------------
  if (groupCallState === "ringing-in" && incomingGroupCall) {
    const callerName = incomingGroupCall.startedByName || nameOf(incomingGroupCall.startedBy);
    const inCall = (incomingGroupCall.participants || []).length;
    return (
      <div className="modal-backdrop call-overlay">
        <div className="modal call-modal">
          <div className="call-avatar">{(incomingGroupCall.chatName || "?")[0]?.toUpperCase()}</div>
          <h3>{incomingGroupCall.chatName || t("groupCalls.groupFallbackName")}</h3>
          <p className="muted">{t("groupCalls.incomingLabel", { name: callerName })}</p>
          <p className="muted" style={{ fontSize: 13 }}>
            {t("groupCalls.participantsInCall", { count: inCall })}
          </p>
          {groupCallError && <div className="error">{groupCallError}</div>}
          <div className="call-actions">
            <button type="button" className="call-btn call-btn-decline" onClick={declineIncoming}>
              {t("calls.declineBtn")}
            </button>
            <button type="button" className="call-btn call-btn-accept" onClick={acceptIncoming}>
              {t("calls.acceptBtn")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const participants = groupCall?.participants || [];
  const invited = groupCall?.invited || [];

  // --- свёрнутая плашка ------------------------------------------------------
  if (minimized) {
    return (
      <div className="call-top-bar" onClick={() => setMinimized(false)} role="button" tabIndex={0}>
        <span className="call-top-bar-dot" />
        <span className="call-top-bar-name">
          {muted && "🔇 "}
          {groupCall?.chatName || t("groupCalls.groupFallbackName")} · {participants.length}
        </span>
        <span className="call-top-bar-timer">{formatDuration(seconds)}</span>
        <button
          type="button"
          className="call-top-bar-hangup"
          title={t("groupCalls.leaveBtn")}
          onClick={(e) => {
            e.stopPropagation();
            leaveCall();
          }}
        >
          ✕
        </button>
      </div>
    );
  }

  const canInvite = chat && user && canStartGroupCall(chat, user.uid);
  // Завершить для всех может тот, кто начал звонок, и владелец группы — то же
  // условие проверяют правила (firestore.rules -> groupCalls update).
  const canEndForAll =
    !!user && (groupCall?.startedBy === user.uid || chat?.ownerId === user.uid);
  const invitablePeople = (chat?.members || [])
    // Ботов в звонок не зовём — им нечем отвечать.
    .filter((uid) => uid !== user?.uid && !profiles[uid]?.isBot)
    .map((uid) => profiles[uid] || { id: uid, name: null });

  return (
    <div className="modal-backdrop call-overlay">
      <div className="modal call-modal group-call-modal">
        <button
          type="button"
          className="call-minimize-btn"
          title={t("calls.minimizeBtn")}
          onClick={() => setMinimized(true)}
        >
          ⌄
        </button>
        <h3>{groupCall?.chatName || t("groupCalls.groupFallbackName")}</h3>
        <p className="muted">
          {groupCallState === "active"
            ? `${t("groupCalls.participantsInCall", { count: participants.length })} · ${formatDuration(seconds)}`
            : t("groupCalls.waitingLabel")}
        </p>

        <div className="group-call-grid">
          {participants.map((uid) => {
            const peer = peers[uid];
            const isMe = uid === user?.uid;
            const showVideo = isMe ? cameraOn : peer?.videoOn;
            return (
              <div key={uid} className={"group-call-tile" + (isMe ? " group-call-tile-me" : "")}>
                {showVideo ? (
                  isMe ? (
                    <video ref={attachLocalVideo} className="group-call-video" autoPlay playsInline muted />
                  ) : (
                    <PeerVideo stream={peer?.stream} />
                  )
                ) : (
                  <UserAvatar profile={profileOf(uid)} fallback={(nameOf(uid) || "?")[0]?.toUpperCase()} size={64} />
                )}
                <span className="group-call-tile-name">
                  {isMe ? t("groupCalls.youLabel") : nameOf(uid)}
                  {isMe && muted && " 🔇"}
                </span>
                {!isMe && !peer?.connected && (
                  <span className="muted group-call-tile-status">{t("groupCalls.connectingLabel")}</span>
                )}
                {!isMe && peer?.stream && <PeerAudio stream={peer.stream} />}
              </div>
            );
          })}
          {invited.map((uid) => (
            <div key={uid} className="group-call-tile group-call-tile-ringing">
              <UserAvatar profile={profileOf(uid)} fallback={(nameOf(uid) || "?")[0]?.toUpperCase()} size={64} />
              <span className="group-call-tile-name">{nameOf(uid)}</span>
              <span className="muted group-call-tile-status">{t("groupCalls.ringingLabel")}</span>
            </div>
          ))}
        </div>

        {groupCallError && <div className="error">{groupCallError}</div>}

        <div className="call-actions">
          <button type="button" className={"call-btn" + (muted ? " call-btn-active" : "")} onClick={toggleMute}>
            {muted ? t("calls.unmuteBtn") : t("calls.muteBtn")}
          </button>
          {cameraAvailable && (
            <button type="button" className={"call-btn" + (cameraOn ? " call-btn-active" : "")} onClick={toggleCamera}>
              {cameraOn ? t("calls.cameraOnBtn") : t("calls.cameraOffBtn")}
            </button>
          )}
          {canInvite && participants.length + invited.length < MAX_PARTICIPANTS && (
            <button type="button" className="call-btn" onClick={() => setShowPicker(true)}>
              {t("groupCalls.addPeopleBtn")}
            </button>
          )}
          <button
            type="button"
            className="call-btn call-btn-decline"
            onClick={() => (canEndForAll ? setShowLeaveChoice(true) : leaveCall())}
          >
            {t("groupCalls.leaveBtn")}
          </button>
        </div>
      </div>

      {showLeaveChoice && (
        <div className="modal-backdrop" onClick={() => setShowLeaveChoice(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{t("groupCalls.leaveChoiceTitle")}</h3>
            <p className="muted">{t("groupCalls.leaveChoiceHint")}</p>
            <div className="call-actions">
              <button
                type="button"
                className="call-btn"
                onClick={() => {
                  setShowLeaveChoice(false);
                  leaveCall();
                }}
              >
                {t("groupCalls.leaveOnlyBtn")}
              </button>
              <button
                type="button"
                className="call-btn call-btn-decline"
                onClick={() => {
                  setShowLeaveChoice(false);
                  endCallForAll();
                }}
              >
                {t("groupCalls.endForAllBtn")}
              </button>
            </div>
            <button
              type="button"
              className="call-btn"
              style={{ width: "100%", marginTop: 8 }}
              onClick={() => setShowLeaveChoice(false)}
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}

      {showPicker && (
        <CallMemberPicker
          people={invitablePeople}
          busyIds={[...participants, ...invited]}
          limit={MAX_PARTICIPANTS - participants.length - invited.length}
          title={t("groupCalls.addPeopleTitle")}
          confirmLabel={t("groupCalls.addPeopleConfirm")}
          onClose={() => setShowPicker(false)}
          onConfirm={(uids) => {
            setShowPicker(false);
            inviteToCall(uids);
          }}
        />
      )}
    </div>
  );
}
