import { useEffect, useState } from "react";
import { useCall } from "../contexts/CallContext";
import { useLanguage } from "../i18n/LanguageContext";

// Полноэкранный оверлей звонка — рисуется поверх всего приложения (см.
// монтирование в App.jsx), потому что входящий звонок может застать
// человека на любой странице, не только в самом чате с этим собеседником.
//
// Пока идёт набор/входящий вызов (ringing-*) экран всегда во весь экран —
// это коротко и требует немедленного решения (принять/отклонить/отменить).
// А вот УЖЕ ИДУЩИЙ разговор можно свернуть в маленькую плавающую плашку
// (как в Telegram) — тогда под ней снова доступен весь остальной
// мессенджер: можно листать чаты, писать, заходить в друзья и т.д., звонок
// при этом продолжается как ни в чём не бывало (WebRTC-соединение и его
// состояние живут в CallContext, а не в этом компоненте — сворачивание
// только меняет, что рисуется на экране).
function useCallDuration(active) {
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

export default function CallOverlay() {
  const {
    callState,
    activeCall,
    preparing,
    slowNetwork,
    minimized,
    setMinimized,
    muted,
    speakerOn,
    speakerSupported,
    callError,
    acceptCall,
    declineCall,
    hangUp,
    toggleMute,
    toggleSpeaker,
    videoCallUnlocked,
    cameraOn,
    remoteVideoOn,
    toggleCamera,
    attachLocalVideo,
    attachRemoteVideo,
    clearCallError,
  } = useCall();
  const { t } = useLanguage();
  const seconds = useCallDuration(callState === "active");

  // Звонок не состоялся (не дали микрофон, пропала сеть) — экран уже закрыт,
  // и без отдельной карточки человек не увидел бы вообще ничего.
  if (!callState) {
    if (!callError) return null;
    return (
      <div className="modal-backdrop call-overlay">
        <div className="modal call-modal">
          <h3>{t("chatWindow.callTitle")}</h3>
          <div className="error">{callError}</div>
          <div className="call-actions">
            <button type="button" className="call-btn" onClick={clearCallError}>
              {t("common.close")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const name =
    callState === "ringing-in" ? activeCall?.callerName || "…" : activeCall?.calleeName || activeCall?.callerName || "…";

  // Сам разговор с камерой (своей и/или чужой) — отдельный полноэкранный
  // "слой" на весь вьюпорт (см. .call-video-stage в app.css), а не карточка
  // фиксированного размера: так видео всегда кроится естественно (как
  // отдельная вкладка/приложение, а не окошко-модалка), и это же полностью
  // убирает "неправильный" кроп камеры собеседника, который был с прежней
  // карточкой фиксированных пропорций.
  const showFullscreenVideo = callState === "active" && (cameraOn || remoteVideoOn);

  if (callState === "active" && minimized) {
    return (
      <div className="call-top-bar" onClick={() => setMinimized(false)} role="button" tabIndex={0}>
        <span className="call-top-bar-dot" />
        <span className="call-top-bar-name">
          {muted && "🔇 "}
          {name}
        </span>
        <span className="call-top-bar-timer">{formatDuration(seconds)}</span>
        <button
          type="button"
          className="call-top-bar-hangup"
          title={t("calls.hangUpBtn")}
          onClick={(e) => {
            e.stopPropagation();
            hangUp();
          }}
        >
          ✕
        </button>
      </div>
    );
  }

  // Ряд кнопок звонка одинаковый что в полноэкранном видео, что в обычной
  // карточке "активного" аудиозвонка — вынесен один раз, чтобы не дублировать
  // JSX между двумя веткам рендера ниже.
  const actionButtons = (
    <>
      <button type="button" className={"call-btn" + (muted ? " call-btn-active" : "")} onClick={toggleMute}>
        {muted ? t("calls.unmuteBtn") : t("calls.muteBtn")}
      </button>
      {speakerSupported && (
        <button type="button" className={"call-btn" + (speakerOn ? " call-btn-active" : "")} onClick={toggleSpeaker}>
          {speakerOn ? t("calls.speakerOffBtn") : t("calls.speakerOnBtn")}
        </button>
      )}
      {videoCallUnlocked && (
        <button type="button" className={"call-btn" + (cameraOn ? " call-btn-active" : "")} onClick={toggleCamera}>
          {cameraOn ? t("calls.cameraOnBtn") : t("calls.cameraOffBtn")}
        </button>
      )}
      <button type="button" className="call-btn call-btn-decline" onClick={hangUp}>
        {t("calls.hangUpBtn")}
      </button>
    </>
  );

  if (showFullscreenVideo) {
    return (
      <div className="call-video-stage">
        {/* Видео собеседника — рисуем только пока его трек реально "unmuted"
            (см. CallContext.jsx -> pc.ontrack): иначе вместо честного
            "камера выключена" тут был бы просто застывший чёрный кадр.
            muted тут ничего не заглушает по звуку — этот <video> получает
            ТОЛЬКО видео-трек (аудио идёт отдельным <audio> в CallContext.jsx),
            звуковой дорожки в нём просто нет физически. Но без атрибута
            muted часть браузеров (особенно внутри Android TWA/WebView —
            см. build-android-apk.yml) молча блокирует автовоспроизведение
            НЕмьюченного <video>, когда srcObject проставляется программно
            уже после исходного клика "Принять звонок" (см. attachRemoteVideo
            в CallContext.jsx) — из-за этого видео зависает на первом чёрном
            кадре, хотя сам поток реально идёт (см. CallContext.jsx ->
            attachRemoteVideo/.play() — там же добавлен явный play()
            вторым слоем защиты). */}
        {remoteVideoOn ? (
          <video ref={attachRemoteVideo} className="call-video-remote" autoPlay playsInline muted />
        ) : (
          <div className="call-video-remote-placeholder">
            <div className="call-avatar">{name[0]?.toUpperCase() || "?"}</div>
          </div>
        )}
        {cameraOn && <video ref={attachLocalVideo} className="call-video-local-pip" autoPlay playsInline muted />}

        <div className="call-video-topbar">
          <button
            type="button"
            className="call-minimize-btn"
            title={t("calls.minimizeBtn")}
            onClick={() => setMinimized(true)}
          >
            ⌄
          </button>
          <div className="call-video-heading">
            <span className="call-video-name">{name}</span>
            <span className="call-video-timer">{formatDuration(seconds)}</span>
          </div>
        </div>

        {callError && <div className="error call-video-error">{callError}</div>}

        <div className="call-video-bottombar call-actions">{actionButtons}</div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop call-overlay">
      <div className="modal call-modal">
        {callState === "active" && (
          <button
            type="button"
            className="call-minimize-btn"
            title={t("calls.minimizeBtn")}
            onClick={() => setMinimized(true)}
          >
            ⌄
          </button>
        )}
        <div className="call-avatar">{name[0]?.toUpperCase() || "?"}</div>
        <h3>{name}</h3>
        <p className="muted">
          {callState === "ringing-in" && (preparing ? t("calls.preparingLabel") : t("calls.incomingLabel"))}
          {callState === "ringing-out" && (preparing ? t("calls.preparingLabel") : t("calls.callingLabel"))}
          {callState === "active" && formatDuration(seconds)}
        </p>
        {preparing && slowNetwork && <div className="muted">{t("calls.slowNetworkHint")}</div>}
        {callError && <div className="error">{callError}</div>}

        {callState === "ringing-in" && (
          <div className="call-actions">
            <button type="button" className="call-btn call-btn-decline" onClick={declineCall}>
              {t("calls.declineBtn")}
            </button>
            <button type="button" className="call-btn call-btn-accept" disabled={preparing} onClick={acceptCall}>
              {preparing ? t("calls.preparingLabel") : t("calls.acceptBtn")}
            </button>
          </div>
        )}

        {callState === "ringing-out" && (
          <div className="call-actions">
            <button type="button" className="call-btn call-btn-decline" onClick={hangUp}>
              {t("calls.cancelBtn")}
            </button>
          </div>
        )}

        {callState === "active" && <div className="call-actions">{actionButtons}</div>}
      </div>
    </div>
  );
}
