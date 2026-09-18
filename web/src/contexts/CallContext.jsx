import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "./AuthContext";
import { useLanguage } from "../i18n/LanguageContext";
import { iceServers } from "../utils/webrtcConfig";
import { emailNotificationsOff, notifyCallRinging, notifyMissedCall } from "../utils/emailNotify";
import { isOnline } from "../utils/presence";
import { unlockAudio, startRingback, startRingtone } from "../utils/callSounds";
import { hasVideoCallUnlocked } from "../utils/videoCalls";
import { isGroupCallBusy } from "../utils/groupCalls";
import { callSetupError } from "../utils/mediaErrors";

// Голосовые звонки (см. firestore.rules -> calls/{callId}) — сигнализация
// (кто кому звонит, SDP offer/answer, ICE-кандидаты) идёт через Firestore,
// сам голос — напрямую между браузерами по WebRTC (peer-to-peer). Бэкенда
// нет (бесплатный план), поэтому весь сценарий целиком на клиенте: этот
// контекст держит текущий RTCPeerConnection и слушает входящие звонки, пока
// открыто приложение (см. монтирование в App.jsx, внутри Gate).
//
// Звонок считается "пропущенным" (missed), если звонящий не получил ответ
// за RING_TIMEOUT_MS — это решает клиент звонящего (нет сервера, который
// мог бы сделать это независимо), после чего в чат добавляется обычное
// сообщение-заметка и, если получатель был не в сети, письмо на email
// (см. utils/emailNotify.js).
const RING_TIMEOUT_MS = 45000;

// Сколько ждём, пока звонок вообще соберётся (микрофон/камера + запись вызова
// в Firestore), прежде чем сдаться и показать ошибку.
const PREPARE_TIMEOUT_MS = 30000;

// То же самое на стороне принимающего. Здесь ждём дольше — ровно столько же,
// сколько звонящий ждёт ответа (RING_TIMEOUT_MS): ответ уходит в Firestore, и
// если связь плохая, запись может идти долго. Сдаваться раньше звонящего
// бессмысленно — получится "я нажал ответить, а оно само сбросилось".
const ANSWER_TIMEOUT_MS = RING_TIMEOUT_MS;

// Через сколько на экране "Соединяем…" появляется подсказка про плохую связь.
const SLOW_NETWORK_HINT_MS = 8000;

const CallContext = createContext(null);

function formatCallDuration(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function candidatesCollection(callId, side) {
  return collection(db, "calls", callId, side === "caller" ? "callerCandidates" : "calleeCandidates");
}

export function CallProvider({ children }) {
  const { user, profile } = useAuth();
  const { t } = useLanguage();
  // 'ringing-out' — я звоню, жду ответа; 'ringing-in' — мне звонят;
  // 'active' — звонок идёт; null — никакого звонка сейчас нет.
  const [callState, setCallState] = useState(null);
  const [activeCall, setActiveCall] = useState(null); // {id, callerId, calleeId, callerName, chatId, ...}
  // Свёрнут ли уже идущий разговор в тонкую плашку сверху экрана (см.
  // CallOverlay.jsx). Живёт здесь, а не локально в CallOverlay, потому что
  // Layout.jsx тоже должен об этом знать — плашка рисуется поверх всего
  // (position: fixed) и, если под ней не освободить место, перекрывает
  // собой то, что обычно в самом верху страницы (шапку сайдбара с логотипом
  // и т.п.), делая эту часть текста невидимой.
  const [minimized, setMinimized] = useState(false);
  // "Готовим звонок": экран звонка показывается СРАЗУ по нажатию, ещё до того,
  // как браузер отдаст микрофон/камеру и Firestore создаст документ вызова.
  // Раньше всё это (getUserMedia + createOffer + запись в базу) происходило
  // молча: на ноутбуке камера успевала зажечь лампочку, а экран звонка
  // появлялся только через несколько секунд — и выглядело это как "нажал
  // позвонить, включилась камера, а звонка нет".
  const [preparing, setPreparing] = useState(false);
  // Подготовка затянулась (обычно это медленная/залипшая связь с Firestore) —
  // показываем подсказку, а не молчим.
  const [slowNetwork, setSlowNetwork] = useState(false);
  const [muted, setMuted] = useState(false);
  const [callError, setCallError] = useState("");
  // Громкая связь: включена ли отдельная колонка ("динамик") вместо тихого
  // прослушивания через "ухо". Поддерживается не везде (см. detectSpeakerDevice
  // ниже) — на iPhone/Safari переключить это с сайта нельзя в принципе
  // (ограничение самой Apple, ни один браузер на iOS не даёт веб-страницам
  // выбирать аудиовыход), поэтому там кнопка просто не показывается.
  const [speakerOn, setSpeakerOn] = useState(false);
  const [speakerSupported, setSpeakerSupported] = useState(false);
  const speakerDeviceIdRef = useRef(null);

  // Видео в звонках (платная функция, см. utils/videoCalls.js). Раньше камера
  // подключалась к соединению только по кнопке, посреди уже идущего
  // разговора, через RTCRtpSender.replaceTrack() на "холодном" (без трека)
  // видео-трансивере, БЕЗ повторного согласования SDP — диагностика реальных
  // звонков (см. watchCameraSent ниже) подтвердила, что именно это иногда
  // просто не запускает кодирование у того, кто включил камеру ВТОРЫМ/позже:
  // пакеты не уходят вообще, хотя сам replaceTrack() успешно резолвится и
  // ICE-соединение живое. Поэтому теперь у купившего видео камера
  // подключается к соединению СРАЗУ при старте звонка (createPeerConnection),
  // вместе с микрофоном — трек с самого начала "тёплый" (уже участвовал в
  // SDP-согласовании), просто выключен (track.enabled = false), а кнопка
  // камеры лишь переключает enabled — ровно так же, как toggleMute уже давно
  // и надёжно переключает звук на аудио-треке. Плата за надёжность — разрешение
  // на камеру запрашивается сразу при старте звонка у всех, кто купил видео,
  // а не только по нажатию кнопки. У кого видео не куплено (или камера
  // оказалась недоступна/запрещена) — своя сторона просто recvonly: ничего не
  // отправляет, но исправно принимает видео собеседника, если включит он.
  const [cameraOn, setCameraOn] = useState(false);
  const [remoteVideoOn, setRemoteVideoOn] = useState(false);
  const videoSenderRef = useRef(null); // RTCRtpSender видео-трансивера, только если камера куплена
  const localVideoTrackRef = useRef(null); // текущий трек камеры, только пока cameraOn
  const localVideoElRef = useRef(null);
  const remoteVideoElRef = useRef(null);
  const remoteVideoStreamRef = useRef(null);
  // См. watchDecodedFrame ниже — таймер, которым проверяем, что видео
  // собеседника реально РИСУЕТСЯ (не просто "unmuted"), и "пинаем" элемент
  // заново, если экран застрял чёрным дольше пары секунд.
  const frameWatchTimeoutRef = useRef(null);
  // Последний снимок документа calls/{callId} — в частности, поля
  // callerSeesVideoAt/calleeSeesVideoAt (см. watchDecodedFrame/
  // watchCameraSent ниже), которыми стороны подтверждают друг другу, что
  // видео реально дошло и отрисовалось, а не просто "ушли какие-то пакеты".
  const lastCallDataRef = useRef(null);

  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const roleRef = useRef(null); // 'caller' | 'callee'
  const callIdRef = useRef(null);
  // ICE-кандидаты могут начать собираться ДО того, как известен id звонка
  // (у звонящего — offer создаётся раньше, чем создан документ calls/*) —
  // складываем их сюда и отправляем в Firestore, как только id появится.
  const pendingLocalCandidatesRef = useRef([]);
  // ...и наоборот: кандидаты от собеседника могут прийти раньше, чем
  // локально выставлен remoteDescription (setRemoteDescription) — тогда
  // addIceCandidate бросит ошибку, поэтому тоже буферизуем.
  const pendingRemoteCandidatesRef = useRef([]);
  const unsubCallRef = useRef(null);
  const unsubCandidatesRef = useRef(null);
  const ringTimeoutRef = useRef(null);
  const seenIncomingIdsRef = useRef(new Set());
  // Момент, когда звонок реально стал активным (я или собеседник ответили) —
  // от этого считаем длительность для заметки "Звонок завершён • 1:23".
  const callStartRef = useRef(null);
  // Функция остановки текущего звукового сигнала (гудки/входящий), см.
  // utils/callSounds.js. Храним тут, а не в стейте — часто пере-создавать
  // компонент из-за неё незачем, это чисто побочный эффект.
  const soundStopRef = useRef(null);
  // Счётчик попыток звонка: растёт при каждом завершении/отмене. Асинхронная
  // подготовка звонка сверяется с ним после каждого await — если человек успел
  // нажать "Отмена", пока мы ждали камеру или сеть, продолжать уже нечего.
  const callTokenRef = useRef(0);
  // Страховка от "вечной подготовки" (не отвечает запрос разрешений, пропала
  // сеть) — см. PREPARE_TIMEOUT_MS.
  const prepareTimeoutRef = useRef(null);
  const slowHintTimeoutRef = useRef(null);

  const cleanupPeer = useCallback(() => {
    callTokenRef.current += 1;
    if (prepareTimeoutRef.current) {
      clearTimeout(prepareTimeoutRef.current);
      prepareTimeoutRef.current = null;
    }
    if (slowHintTimeoutRef.current) {
      clearTimeout(slowHintTimeoutRef.current);
      slowHintTimeoutRef.current = null;
    }
    setPreparing(false);
    setSlowNetwork(false);
    if (soundStopRef.current) {
      soundStopRef.current();
      soundStopRef.current = null;
    }
    if (ringTimeoutRef.current) {
      clearTimeout(ringTimeoutRef.current);
      ringTimeoutRef.current = null;
    }
    if (frameWatchTimeoutRef.current) {
      clearTimeout(frameWatchTimeoutRef.current);
      frameWatchTimeoutRef.current = null;
    }
    if (unsubCandidatesRef.current) {
      unsubCandidatesRef.current();
      unsubCandidatesRef.current = null;
    }
    if (unsubCallRef.current) {
      unsubCallRef.current();
      unsubCallRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null;
    }
    if (localVideoTrackRef.current) {
      localVideoTrackRef.current.stop();
      localVideoTrackRef.current = null;
    }
    if (localVideoElRef.current) localVideoElRef.current.srcObject = null;
    if (remoteVideoElRef.current) remoteVideoElRef.current.srcObject = null;
    remoteVideoStreamRef.current = null;
    videoSenderRef.current = null;
    roleRef.current = null;
    callIdRef.current = null;
    lastCallDataRef.current = null;
    pendingLocalCandidatesRef.current = [];
    pendingRemoteCandidatesRef.current = [];
    callStartRef.current = null;
    speakerDeviceIdRef.current = null;
    setMuted(false);
    setSpeakerOn(false);
    setSpeakerSupported(false);
    setCameraOn(false);
    setRemoteVideoOn(false);
  }, []);

  const endLocally = useCallback(() => {
    cleanupPeer();
    setCallState(null);
    setActiveCall(null);
    // Звонок завершился штатно — старая ошибка (например, диагностика видео из
    // watchCameraSent) не должна всплывать отдельной карточкой уже ПОСЛЕ
    // разговора.
    setCallError("");
  }, [cleanupPeer]);

  // AudioContext для гудков/мелодии звонка (см. utils/callSounds.js) можно
  // запустить без нового клика только если он уже был хоть раз "разбужен"
  // внутри пользовательского жеста раньше — а входящий звонок прилетает сам,
  // без клика в этот момент. Поэтому один раз, по самому первому касанию
  // где угодно в приложении, разбужаем его заранее и больше не трогаем.
  useEffect(() => {
    function onFirstInteraction() {
      unlockAudio();
      window.removeEventListener("pointerdown", onFirstInteraction);
      window.removeEventListener("keydown", onFirstInteraction);
    }
    window.addEventListener("pointerdown", onFirstInteraction);
    window.addEventListener("keydown", onFirstInteraction);
    return () => {
      window.removeEventListener("pointerdown", onFirstInteraction);
      window.removeEventListener("keydown", onFirstInteraction);
    };
  }, []);

  // Гудки, пока я звоню ("ringing-out"), и мелодия входящего, пока звонят
  // мне ("ringing-in") — останавливаются сами при любой смене состояния
  // звонка (снят через cleanupPeer тоже, для надёжности).
  useEffect(() => {
    if (soundStopRef.current) {
      soundStopRef.current();
      soundStopRef.current = null;
    }
    if (callState === "ringing-out" && !preparing) {
      // Пока звонок только собирается (микрофон, запись вызова в базу), гудки
      // не запускаем: у собеседника ещё ничего не звонит.
      soundStopRef.current = startRingback();
    } else if (callState === "ringing-in" && !preparing) {
      soundStopRef.current = startRingtone();
      // Вибро-отклик на входящий — работает на Android Chrome; на
      // iOS/Safari браузерного API вибрации в принципе не существует
      // (ограничение Apple), там просто ничего не произойдёт.
      navigator.vibrate?.([500, 300, 500, 300, 500]);
    }
    return () => {
      if (soundStopRef.current) {
        soundStopRef.current();
        soundStopRef.current = null;
      }
    };
  }, [callState, preparing]);

  // Новый вызов (входящий или исходящий) всегда стартует на весь экран —
  // сворачивание имеет смысл только для уже идущего разговора, и должно
  // сбрасываться при каждом новом звонке, а не оставаться с прошлого раза.
  useEffect(() => {
    if (callState === "ringing-in" || callState === "ringing-out") {
      setMinimized(false);
    }
  }, [callState]);

  // Постоянно слушаем: не звонит ли мне кто-то прямо сейчас. Запрос узкий
  // (только свои входящие 'ringing'), поэтому дешёвый и безопасен по
  // правилам (calls/{callId} read — только участник).
  useEffect(() => {
    if (!user) return undefined;
    const q = query(
      collection(db, "calls"),
      where("calleeId", "==", user.uid),
      where("status", "==", "ringing")
    );
    const unsub = onSnapshot(q, (snap) => {
      snap.docChanges().forEach((change) => {
        if (change.type !== "added") return;
        const id = change.doc.id;
        if (seenIncomingIdsRef.current.has(id)) return;
        seenIncomingIdsRef.current.add(id);
        // Уже в другом звонке — новый входящий тихо игнорируем (простая
        // модель "один звонок за раз", как и большинство мессенджеров).
        // Групповой звонок считается таким же "другим звонком" (см.
        // utils/groupCalls.js -> isGroupCallBusy).
        if (pcRef.current || isGroupCallBusy()) return;
        const data = change.doc.data();
        setCallError("");
        setActiveCall({ id, ...data });
        setCallState("ringing-in");
        // Пока мы не ответили и не отклонили, слушаем сам документ звонка:
        // если звонящий передумал и отменил вызов раньше, чем мы успели
        // отреагировать, статус сменится на "ended" и наш экран "входящий
        // звонок" должен закрыться сам, а не висеть бесконечно. Это отдельный
        // слушатель от того, что заводит acceptCall — тот появляется только
        // ПОСЛЕ ответа и сам его заменяет (см. acceptCall ниже).
        // Этот слушатель живёт, пока мы не ответили (в acceptCall он
        // снимается прямо перед записью "accepted"), поэтому здесь достаточно
        // самого статуса: звонящий отменил вызов — экран входящего закрывается
        // сразу, в том числе если мы как раз выдаём микрофон.
        unsubCallRef.current = onSnapshot(doc(db, "calls", id), (callSnap) => {
          const callData = callSnap.data();
          if (callData && callData.status !== "ringing") {
            endLocally();
          }
        });
      });
    });
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid]);

  // Проставляет поток на <video> и явно вызывает play() — см. комментарий
  // ниже у watchDecodedFrame про то, зачем это вообще нужно отдельной
  // функцией (используется и при обычном первом присоединении, и как сам
  // "пинок", которым чиним застрявший чёрный экран).
  function attachStreamToVideoEl(el, stream) {
    if (!el || !stream) return;
    el.srcObject = stream;
    // Второй слой защиты поверх autoPlay+muted в CallOverlay.jsx —
    // srcObject проставляется тут программно, уже ПОСЛЕ исходного клика
    // "Принять звонок", и часть браузеров/WebView (см. TWA) из-за этого не
    // запускает атрибут autoplay сам по себе, оставляя <video> застывшим на
    // первом чёрном кадре. play() безопасно вызывать даже если
    // воспроизведение уже идёт — просто игнорируем отказ (autoplay
    // заблокирован ещё где-то — тогда сработает хотя бы muted-автоплей из
    // разметки).
    el.play().catch(() => {});
  }

  // "У меня камера работает, а собеседник видит у себя чёрный экран" —
  // реальный WebRTC-баг: track.muted/onunmute сигнализирует только о том,
  // что RTP-ПАКЕТЫ пошли по сети, но НЕ гарантирует, что видеодекодер
  // реально расшифровал хотя бы один кадр — на части браузеров/WebView
  // декодер, запущенный через replaceTrack() без повторного SDP-
  // согласования (см. toggleCamera), иногда "подвисает" и просто не
  // стартует, хотя транспорт формально живой. Раз в 1.5с (до 9 попыток,
  // см. ниже почему именно столько) проверяем framesDecoded из
  // pc.getStats(track) — если пакеты идут, а расшифрованных кадров всё ещё
  // 0, тот самый "пинок": снимаем и заново ставим srcObject. Дёшево,
  // безопасно (в худшем случае просто лишний вызов play() на уже
  // работающем видео) и на практике чаще всего решает именно этот класс
  // "чёрного экрана".
  //
  // ВАЖНО про длину окна: пока это не расшифрует хотя бы один кадр, ack
  // собеседнику (см. ниже) не уходит вообще — а его ждёт watchCameraSent
  // НА ДРУГОЙ стороне, с ограниченным терпением. Раньше здесь было всего
  // 3 попытки (~4.5с) — заметно МЕНЬШЕ, чем окно ожидания у watchCameraSent
  // (было 6×1.5с = 9с). Из-за этого разрыва мог возникать баг "кто первым
  // включил камеру — у того и работает, у второго ошибка": когда камеру
  // включают ОБЕ стороны почти одновременно, декодер под двойной нагрузкой
  // (свой энкодер + чужой декодер разом) стартует медленнее, легко дольше
  // 4.5с — watchDecodedFrame сдавался и НАВСЕГДА переставал следить (до
  // следующего onmute/onunmute, которого без сетевого сбоя просто не
  // будет), ack так и не уходил, и watchCameraSent у второго человека бил
  // тревогу по таймауту, даже если видео секундой позже реально бы пошло.
  // Поэтому окно здесь должно быть заведомо ДОЛЬШЕ, чем у watchCameraSent.
  function watchDecodedFrame(track) {
    if (frameWatchTimeoutRef.current) return;
    const pc = pcRef.current;
    if (!pc) return;
    let attempts = 0;
    const check = async () => {
      frameWatchTimeoutRef.current = null;
      if (!pcRef.current || pcRef.current !== pc) return;
      attempts += 1;
      try {
        const stats = await pc.getStats(track);
        let framesDecoded = 0;
        stats.forEach((report) => {
          if (report.type === "inbound-rtp" && report.kind === "video") {
            framesDecoded = report.framesDecoded || 0;
          }
        });
        if (framesDecoded > 0) {
          // Подтверждаем собеседнику через calls/{callId} (см.
          // firestore.rules), что его видео реально дошло и отрисовалось —
          // именно это поле проверяет watchCameraSent НИЖЕ у отправляющей
          // стороны, вместо того чтобы верить только своей локальной
          // статистике отправки.
          const field = roleRef.current === "caller" ? "callerSeesVideoAt" : "calleeSeesVideoAt";
          if (callIdRef.current) {
            updateDoc(doc(db, "calls", callIdRef.current), { [field]: serverTimestamp() }).catch(() => {});
          }
          return;
        }
      } catch {
        return;
      }
      attachStreamToVideoEl(remoteVideoElRef.current, remoteVideoStreamRef.current);
      if (attempts < 9) {
        frameWatchTimeoutRef.current = setTimeout(check, 1500);
      }
    };
    frameWatchTimeoutRef.current = setTimeout(check, 1500);
  }

  // "Я включил камеру, а собеседник у себя её вообще не увидел (даже не
  // узнал, что я её включил)" — раньше (см. историю комментария у cameraOn
  // выше) причиной был replaceTrack() на "холодном" видео-трансивере: сам
  // вызов успешно резолвился, но кодирование иногда просто не запускалось, и
  // у собеседника track.onunmute никогда не срабатывал. Теперь трек "тёплый"
  // с самого начала звонка и просто переключается через .enabled — тот же
  // самый класс проблем в теории уже не должен воспроизводиться, но следилка
  // и диагностика ниже намеренно оставлены: они дёшевы, а на "теперь работает
  // надёжно" в вебе полагаться нельзя без реальных подтверждений от живых
  // звонков.
  //
  // ВАЖНО: локальный packetsSent из pc.getStats() — это лишь "мои пакеты
  // ушли в сеть", а НЕ "собеседник их получил и показал у себя" — реальный
  // случай (звонок телефон↔ноутбук), из-за которого это переписано:
  // packetsSent был >0 (то есть по старой версии проверки — "всё хорошо",
  // без единой ошибки), а собеседник всё равно не видел ничего, кроме
  // аватарки. Поэтому теперь ГЛАВНЫЙ критерий успеха — подтверждение от
  // самого собеседника через calls/{callId}.callerSeesVideoAt /
  // .calleeSeesVideoAt (пишет watchDecodedFrame выше, когда у НЕГО реально
  // расшифровался хотя бы один кадр). Локальный packetsSent используется
  // только как быстрый доп.сигнал: если пакеты не пошли даже локально —
  // сразу пробуем "пнуть" отправку свежим треком с камеры, не дожидаясь
  // более медленного (идёт через сеть и Firestore) подтверждения.
  function watchCameraSent(initialTrack) {
    const pc = pcRef.current;
    const sender = videoSenderRef.current;
    if (!pc || !sender) return;
    const ackField = roleRef.current === "caller" ? "calleeSeesVideoAt" : "callerSeesVideoAt";
    const ackBefore = lastCallDataRef.current?.[ackField]?.toMillis?.() || 0;
    let track = initialTrack;
    let attempts = 0;
    let retried = false;
    const check = async () => {
      // localVideoTrackRef.current !== track значит, что трек камеры
      // переключили заново (сработал фолбэк ниже) — слежка за старым треком
      // больше не нужна. !track.enabled значит, что камеру просто выключили
      // кнопкой (см. toggleCamera — теперь это переключение .enabled на
      // ТОМ ЖЕ треке, а не остановка/замена трека) — это не ошибка, тихо
      // выходим в обоих случаях.
      if (!pcRef.current || pcRef.current !== pc) return;
      if (videoSenderRef.current !== sender) return;
      if (localVideoTrackRef.current !== track || !track.enabled) return;
      attempts += 1;

      const ackNow = lastCallDataRef.current?.[ackField]?.toMillis?.() || 0;
      if (ackNow > ackBefore) return; // собеседник подтвердил, что видит моё видео

      let packetsSent = 0;
      try {
        const stats = await pc.getStats(track);
        stats.forEach((report) => {
          if (report.type === "outbound-rtp" && report.kind === "video") {
            packetsSent = report.packetsSent || 0;
          }
        });
      } catch {
        return;
      }
      if (localVideoTrackRef.current !== track || !track.enabled) return; // могли выключить, пока ждали getStats

      if (packetsSent === 0 && !retried) {
        // Трек "тёплый" (участвовал в SDP-согласовании с самого начала
        // звонка, см. createPeerConnection), поэтому это уже не тот старый
        // баг с холодным replaceTrack() — скорее похоже на реальную
        // проблему с самой камерой/железом. На всякий случай всё равно
        // пробуем перезапустить свежим треком, прежде чем сдаваться.
        retried = true;
        try {
          const freshStream = await navigator.mediaDevices.getUserMedia({ video: true });
          const freshTrack = freshStream.getVideoTracks()[0];
          if (localVideoTrackRef.current !== track || !track.enabled) {
            // Камеру выключили, пока запрашивали новую камеру, — новый
            // трек никому не нужен, сразу останавливаем.
            freshTrack.stop();
            return;
          }
          localVideoTrackRef.current.stop();
          localVideoTrackRef.current = freshTrack;
          track = freshTrack;
          await sender.replaceTrack(freshTrack);
          if (localVideoElRef.current) {
            localVideoElRef.current.srcObject = freshStream;
            localVideoElRef.current.play().catch(() => {});
          }
        } catch {
          /* не получилось перезапустить камеру — просто продолжаем следить дальше */
        }
      }

      // Подтверждение идёт через сеть собеседника и Firestore, поэтому даём
      // на него больше времени, чем на чисто локальную отправку (8 попыток
      // по 1.5с — около 12 секунд суммарно). Специально МЕНЬШЕ, чем окно
      // watchDecodedFrame выше (9 попыток, ~13.5с) — у собеседника должно
      // хватить времени расшифровать кадр и записать ack ДО того, как здесь
      // наступит таймаут, даже если оба включили камеру почти одновременно
      // и декодер/энкодер на обеих сторонах стартуют медленнее обычного.
      if (attempts < 8) {
        setTimeout(check, 1500);
        return;
      }
      // Два предыдущих исправления этой ошибки (кросс-пировый ack вместо
      // локальной статистики, затем расширенное окно ожидания) не устранили
      // повторяющиеся жалобы "у звонящего работает, у принимающего — нет" —
      // значит, узкое место где-то НИЖЕ уровня этого таймера (сама доставка
      // видео по сети, а не то, как долго мы её ждём). Раз это уже второй
      // раунд и вживую логи недоступны, печатаем короткую диагностику прямо
      // в текст ошибки — со следующего скриншота будет видно, что именно не
      // так: реально ли ICE-соединение "живое", уходят ли пакеты с камеры
      // хоть немного (packetsSent) и какое направление реально согласовал
      // WebRTC для видео-трансивера (если НЕ sendrecv — значит проблема в
      // самом SDP-соглашении, а не в сети).
      let direction = "?";
      try {
        direction = pcRef.current?.getTransceivers().find((tr) => tr.sender === sender)?.currentDirection || "?";
      } catch {
        /* нестрашно, просто не покажем */
      }
      const diag = ` (ICE: ${pc.iceConnectionState || "?"}, pkt: ${packetsSent > 0 ? "да" : "нет"}, dir: ${direction})`;
      setCallError(t("calls.cameraSendFailedError") + diag);
    };
    setTimeout(check, 1500);
  }

  async function createPeerConnection(side) {
    // Токен текущей попытки звонка: пока браузер спрашивает доступ к
    // микрофону/камере (это секунды, а с открытым промптом — сколько угодно),
    // человек может успеть нажать "Отмена". Тогда поток, который придёт
    // позже, нужно немедленно погасить самим — cleanupPeer() его уже не
    // увидит (localStreamRef в тот момент ещё пуст), и лампочка камеры
    // горела бы до перезагрузки страницы.
    const token = callTokenRef.current;
    const abortIfCancelled = (stream) => {
      if (callTokenRef.current === token) return false;
      stream?.getTracks().forEach((t) => t.stop());
      return true;
    };

    const pc = new RTCPeerConnection({ iceServers: iceServers() });
    pcRef.current = pc;
    roleRef.current = side;

    // См. комментарий у cameraOn выше: у купивших видео камера подключается
    // к соединению СРАЗУ, вместе с микрофоном, а не позже по кнопке — иначе
    // получаем "холодный" видео-трансивер и ненадёжный replaceTrack() на нём
    // (см. подробности там же). Трек при этом сразу выключен (enabled=false),
    // так что разрешение на камеру спрашивается сразу при старте звонка, но
    // само видео никуда не идёт, пока не нажата кнопка.
    const canSendVideo = hasVideoCallUnlocked(profile);
    let stream;
    let gotVideo = false;
    if (canSendVideo) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        gotVideo = stream.getVideoTracks().length > 0;
      } catch {
        // Камера недоступна/запрещена — звонок всё равно должен пойти хотя бы
        // голосом, а видео-транспорт ниже резервируем как recvonly, чтобы
        // видеть собеседника, даже если сами показать ничего не можем.
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      }
    } else {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    }
    if (abortIfCancelled(stream)) throw new DOMException("Call cancelled", "AbortError");
    localStreamRef.current = stream;
    stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));

    if (gotVideo) {
      const videoTrack = stream.getVideoTracks()[0];
      videoTrack.enabled = false;
      localVideoTrackRef.current = videoTrack;
      pc.addTrack(videoTrack, stream);
      const videoTransceiver = pc.getTransceivers().find((tr) => tr.sender.track === videoTrack);
      videoSenderRef.current = videoTransceiver ? videoTransceiver.sender : null;
    } else {
      // Ничего не отправляем (либо видео не куплено, либо камера
      // недоступна/запрещена) — резервируем m=video только на приём, чтобы
      // всё равно видеть собеседника, если видео включит он.
      pc.addTransceiver("video", { direction: "recvonly" });
      videoSenderRef.current = null;
    }

    pc.ontrack = (event) => {
      if (event.track.kind === "audio") {
        if (remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = event.streams[0];
        }
        return;
      }
      if (event.track.kind === "video") {
        // event.streams[0] тут иногда всё ещё пустой (например, у recvonly
        // стороны без своего видео) — собираем MediaStream из самого трека
        // напрямую, тогда видео у собеседника показывается независимо от
        // того, пришёл ли валидный event.streams[0].
        const stream = event.streams[0] || new MediaStream([event.track]);
        remoteVideoStreamRef.current = stream;
        attachStreamToVideoEl(remoteVideoElRef.current, stream);
        const track = event.track;
        // muted/unmuted у ПРИНИМАЮЩЕГО трека — встроенный сигнал WebRTC о
        // том, реально ли сейчас идут кадры (без него пришлось бы городить
        // отдельный сигнальный канал через calls/{callId} только чтобы
        // сказать "я включил камеру"). Срабатывает само, когда собеседник
        // вызывает replaceTrack(track)/replaceTrack(null) в toggleCamera.
        // Но само по себе "unmuted" означает только "пакеты идут" — это НЕ
        // гарантия, что декодер реально нарисовал хоть один кадр (см.
        // watchDecodedFrame ниже — им подчищаем оставшийся "чёрный экран",
        // когда пакеты формально идут, а картинки всё ещё нет).
        const sync = () => {
          const on = !track.muted && track.readyState === "live";
          setRemoteVideoOn(on);
          if (on) watchDecodedFrame(track);
        };
        track.onunmute = sync;
        track.onmute = sync;
        sync();
      }
    };

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      const json = event.candidate.toJSON();
      if (callIdRef.current) {
        addDoc(candidatesCollection(callIdRef.current, side), json).catch(() => {});
      } else {
        pendingLocalCandidatesRef.current.push(json);
      }
    };

    detectSpeakerDevice();
    return pc;
  }

  // Переключатель "громкая связь" работает только там, где браузер вообще
  // умеет менять аудиовыход (HTMLMediaElement.setSinkId) и явно видит среди
  // устройств отдельный "динамик" — в основном это Android Chrome. На
  // iPhone/Safari (как и в любом другом браузере на iOS — там все браузеры
  // работают на движке Safari) такого API нет вообще, это ограничение самой
  // Apple, а не недоработка кода — поэтому кнопка там просто не появится.
  // Названия устройств доступны только после разрешения на микрофон,
  // поэтому проверяем уже после getUserMedia в createPeerConnection.
  async function detectSpeakerDevice() {
    const audioEl = remoteAudioRef.current;
    if (!audioEl || typeof audioEl.setSinkId !== "function" || !navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const speaker = devices.find((d) => d.kind === "audiooutput" && /speaker|громк/i.test(d.label));
      if (speaker) {
        speakerDeviceIdRef.current = speaker.deviceId;
        setSpeakerSupported(true);
      }
    } catch {
      /* нет доступа к списку устройств — просто не показываем переключатель */
    }
  }

  function flushPendingLocalCandidates(callId, side) {
    const pending = pendingLocalCandidatesRef.current;
    pendingLocalCandidatesRef.current = [];
    pending.forEach((json) => addDoc(candidatesCollection(callId, side), json).catch(() => {}));
  }

  function listenRemoteCandidates(callId, side) {
    // Звонящий читает кандидаты вызываемого, и наоборот.
    const remoteSide = side === "caller" ? "callee" : "caller";
    const q = query(candidatesCollection(callId, remoteSide), orderBy("__name__"));
    unsubCandidatesRef.current = onSnapshot(q, (snap) => {
      snap.docChanges().forEach((change) => {
        if (change.type !== "added" || !pcRef.current) return;
        const candidate = new RTCIceCandidate(change.doc.data());
        if (pcRef.current.remoteDescription) {
          pcRef.current.addIceCandidate(candidate).catch(() => {});
        } else {
          pendingRemoteCandidatesRef.current.push(candidate);
        }
      });
    });
  }

  function flushPendingRemoteCandidates() {
    const pending = pendingRemoteCandidatesRef.current;
    pendingRemoteCandidatesRef.current = [];
    pending.forEach((candidate) => pcRef.current?.addIceCandidate(candidate).catch(() => {}));
  }

  // kind: 'missed' | 'declined' | 'ended'. Для 'ended' передаём длительность
  // разговора в секундах — заметка в чате тогда выглядит как "Звонок • 1:23",
  // как в Telegram/WhatsApp, а не просто безликое "звонок был".
  async function postCallNote(chatId, kind, durationSec) {
    if (!chatId || !user) return;
    const type = kind === "missed" ? "call_missed" : kind === "declined" ? "call_declined" : "call_ended";
    const noteText =
      kind === "missed"
        ? t("chatWindow.callMissedNote")
        : kind === "declined"
        ? t("chatWindow.callDeclinedNote")
        : t("chatWindow.callEndedNote", { duration: formatCallDuration(durationSec || 0) });
    await addDoc(collection(db, "chats", chatId, "messages"), {
      type,
      text: "",
      senderId: user.uid,
      durationSec: kind === "ended" ? durationSec || 0 : null,
      createdAt: serverTimestamp(),
    });
    await updateDoc(doc(db, "chats", chatId), {
      lastMessage: {
        text: noteText,
        senderId: user.uid,
        senderName: profile?.name || null,
        createdAt: serverTimestamp(),
      },
      updatedAt: serverTimestamp(),
    }).catch(() => {});
  }

  // Кому реально слать письмо о звонке — или null, если слать не надо.
  // Одним местом решаются все три условия сразу: человек сейчас в сети (тогда
  // он и так всё видит), выключил уведомления общим тумблером в настройках,
  // или поставил "без звука" на этом чате. Раньше письма о звонках не
  // спрашивали настройки вовсе: человек глушил уведомления, а "вам звонят" и
  // "пропущенный звонок" всё равно приходили.
  async function callEmailTarget(otherUid, chatId) {
    try {
      const [userSnap, chatSnap] = await Promise.all([
        getDoc(doc(db, "users", otherUid)),
        getDoc(doc(db, "chats", chatId)),
      ]);
      const otherUser = userSnap.data();
      if (!otherUser || isOnline(otherUser.lastActive)) return null;
      const chat = chatSnap.exists() ? chatSnap.data() : null;
      if (emailNotificationsOff(otherUser, chat, otherUid)) return null;
      return otherUser;
    } catch {
      // Не смогли прочитать настройки — молчим. Лишнее письмо человеку,
      // который просил его не слать, хуже, чем неотправленное.
      return null;
    }
  }

  // Письмо "вам звонили" (пропущенный звонок) шлём только если собеседник
  // сейчас не в сети — иначе он и так увидит пропущенный звонок и заметку в
  // чате вживую, письмо будет лишним расходом ограниченного бесплатного
  // лимита EmailJS.
  async function notifyIfOffline(otherUid, chatId) {
    try {
      const otherUser = await callEmailTarget(otherUid, chatId);
      if (!otherUser) return;
      await notifyMissedCall({
        toEmail: otherUser.email,
        fromName: profile?.name,
        chatId,
      });
    } catch {
      /* нет доступа/сети — письмо просто не уйдёт, звонок это не ломает */
    }
  }

  // Письмо "вам звонят" — первое из двух писем о звонке (см.
  // utils/emailNotify.js -> notifyCallRinging/notifyMissedCall), шлём сразу
  // при начале набора (см. startCall ниже), опять же только если собеседник
  // не в сети — как только он ответит или звонок пропадёт, второе письмо
  // (notifyIfOffline выше) пришлёт уже итог.
  async function notifyRingingIfOffline(otherUid, chatId) {
    try {
      const otherUser = await callEmailTarget(otherUid, chatId);
      if (!otherUser) return;
      await notifyCallRinging({
        toEmail: otherUser.email,
        fromName: profile?.name,
        chatId,
      });
    } catch {
      /* нет доступа/сети — письмо просто не уйдёт, звонок это не ломает */
    }
  }

  // Отправить звонок пользователю otherUid (chatId — их общий личный чат,
  // нужен для ссылки в письме и заметки о звонке в переписке).
  const startCall = useCallback(
    async (otherUid, otherName, chatId) => {
      if (!user) return;
      if (isGroupCallBusy()) {
        // Молча ничего не делать нельзя: человек жмёт кнопку и не понимает,
        // почему звонка нет.
        setCallError(t("calls.busyElsewhereError"));
        return;
      }
      // Соединение от прошлого (неудачно завершившегося) звонка осталось
      // висеть, хотя экран уже закрыт — иначе кнопка "позвонить" молча
      // перестала бы работать до перезагрузки страницы.
      if (pcRef.current && !callState) cleanupPeer();
      if (pcRef.current) return;
      setCallError("");
      // Сначала — экран звонка, только потом долгая часть: человек должен
      // сразу видеть, что звонок начался, и иметь кнопку "Отмена", пока
      // браузер спрашивает доступ к камере/микрофону, а вызов ещё пишется в
      // базу (на ноутбуке это легко несколько секунд).
      const token = callTokenRef.current;
      setPreparing(true);
      setSlowNetwork(false);
      slowHintTimeoutRef.current = setTimeout(() => {
        slowHintTimeoutRef.current = null;
        if (callTokenRef.current === token) setSlowNetwork(true);
      }, SLOW_NETWORK_HINT_MS);
      setActiveCall({
        callerId: user.uid,
        calleeId: otherUid,
        callerName: profile?.name,
        calleeName: otherName,
        chatId,
      });
      setCallState("ringing-out");
      prepareTimeoutRef.current = setTimeout(() => {
        prepareTimeoutRef.current = null;
        if (callTokenRef.current !== token) return;
        cleanupPeer();
        setCallState(null);
        setActiveCall(null);
        setCallError(t("calls.prepareTimeoutError"));
      }, PREPARE_TIMEOUT_MS);

      try {
        const pc = await createPeerConnection("caller");
        if (callTokenRef.current !== token) return; // успели отменить
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        if (callTokenRef.current !== token) return;

        const callRef = await addDoc(collection(db, "calls"), {
          callerId: user.uid,
          calleeId: otherUid,
          callerName: profile?.name || "",
          chatId,
          status: "ringing",
          offer: { type: offer.type, sdp: offer.sdp },
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        if (callTokenRef.current !== token) {
          // Отменили ровно в момент записи — закрываем вызов, чтобы у
          // собеседника он не зазвонил впустую.
          updateDoc(doc(db, "calls", callRef.id), { status: "ended", updatedAt: serverTimestamp() }).catch(() => {});
          return;
        }
        callIdRef.current = callRef.id;
        if (prepareTimeoutRef.current) {
          clearTimeout(prepareTimeoutRef.current);
          prepareTimeoutRef.current = null;
        }
        if (slowHintTimeoutRef.current) {
          clearTimeout(slowHintTimeoutRef.current);
          slowHintTimeoutRef.current = null;
        }
        setPreparing(false);
        setSlowNetwork(false);
        flushPendingLocalCandidates(callRef.id, "caller");
        listenRemoteCandidates(callRef.id, "caller");
        notifyRingingIfOffline(otherUid, chatId).catch(() => {});

        setActiveCall({
          id: callRef.id,
          callerId: user.uid,
          calleeId: otherUid,
          callerName: profile?.name,
          calleeName: otherName,
          chatId,
        });

        unsubCallRef.current = onSnapshot(doc(db, "calls", callRef.id), async (snap) => {
          const data = snap.data();
          if (!data || !pcRef.current) return;
          lastCallDataRef.current = data;
          if (data.status === "accepted" && !pcRef.current.currentRemoteDescription) {
            await pcRef.current.setRemoteDescription(new RTCSessionDescription(data.answer));
            flushPendingRemoteCandidates();
            if (ringTimeoutRef.current) {
              clearTimeout(ringTimeoutRef.current);
              ringTimeoutRef.current = null;
            }
            callStartRef.current = Date.now();
            setCallState("active");
          } else if (data.status === "declined" || data.status === "ended") {
            // Заметку "отклонён"/"пропущен" в чат пишет та сторона, которая
            // совершила действие (declineCall/hangUp) — здесь просто гасим
            // свой экран звонка вслед за изменившимся статусом.
            endLocally();
          }
        });

        ringTimeoutRef.current = setTimeout(async () => {
          try {
            // Перед тем как пометить "пропущенный", перепроверяем текущий
            // статус — редкая, но возможная гонка: ответ мог прийти в те
            // же миллисекунды, что и срабатывание таймера.
            const currentSnap = await getDoc(doc(db, "calls", callRef.id));
            if (currentSnap.data()?.status !== "ringing") return;
            await updateDoc(doc(db, "calls", callRef.id), { status: "missed", updatedAt: serverTimestamp() });
          } catch {
            /* звонок уже мог измениться (принят/отклонён) — не страшно */
          }
          postCallNote(chatId, "missed").catch(() => {});
          notifyIfOffline(otherUid, chatId).catch(() => {});
          endLocally();
        }, RING_TIMEOUT_MS);
      } catch (err) {
        if (callTokenRef.current !== token) return; // сами же и отменили
        cleanupPeer();
        setCallState(null);
        setActiveCall(null);
        setCallError(callSetupError(err, t));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user, profile, callState, cleanupPeer, endLocally, t]
  );

  const acceptCall = useCallback(async () => {
    if (!activeCall || roleRef.current) return;
    setCallError("");
    // То же, что и в startCall: доступ к камере/микрофону может занять
    // секунды, и всё это время человек должен видеть, что звонок принимается,
    // а не пустой экран.
    setPreparing(true);
    setSlowNetwork(false);
    const token = callTokenRef.current;
    slowHintTimeoutRef.current = setTimeout(() => {
      slowHintTimeoutRef.current = null;
      if (callTokenRef.current === token) setSlowNetwork(true);
    }, SLOW_NETWORK_HINT_MS);
    // Та же страховка, что и у звонящего: если микрофон так и не выдали
    // (промпт проигнорирован, устройство занято) или ответ так и не ушёл в
    // базу, экран "Соединяем…" не должен висеть вечно.
    prepareTimeoutRef.current = setTimeout(() => {
      prepareTimeoutRef.current = null;
      if (callTokenRef.current !== token) return;
      cleanupPeer();
      setCallState(null);
      setActiveCall(null);
      setCallError(t("calls.prepareTimeoutError"));
    }, ANSWER_TIMEOUT_MS);
    try {
      callIdRef.current = activeCall.id;
      const pc = await createPeerConnection("callee");
      await pc.setRemoteDescription(new RTCSessionDescription(activeCall.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      if (callTokenRef.current !== token) return; // успели отклонить/отменить
      // Только теперь заменяем "предответный" слушатель (следил, не отменил ли
      // звонящий вызов, пока мы думали) на боевой. Раньше он снимался в самом
      // начале — и если выдача микрофона затягивалась, принимающий не узнавал,
      // что звонок уже отменён, и залипал на "Соединяем…".
      if (unsubCallRef.current) {
        unsubCallRef.current();
        unsubCallRef.current = null;
      }
      await updateDoc(doc(db, "calls", activeCall.id), {
        status: "accepted",
        answer: { type: answer.type, sdp: answer.sdp },
        updatedAt: serverTimestamp(),
      });
      if (callTokenRef.current !== token) {
        // Пока шла запись ответа, звонок успели прервать со своей стороны
        // ("Отклонить" или таймаут подготовки). Просто выйти нельзя: у
        // звонящего звонок уже помечен принятым и висел бы навсегда —
        // закрываем его.
        updateDoc(doc(db, "calls", activeCall.id), {
          status: "ended",
          updatedAt: serverTimestamp(),
        }).catch(() => {});
        return;
      }

      flushPendingLocalCandidates(activeCall.id, "callee");
      listenRemoteCandidates(activeCall.id, "callee");
      callStartRef.current = Date.now();
      if (prepareTimeoutRef.current) {
        clearTimeout(prepareTimeoutRef.current);
        prepareTimeoutRef.current = null;
      }
      if (slowHintTimeoutRef.current) {
        clearTimeout(slowHintTimeoutRef.current);
        slowHintTimeoutRef.current = null;
      }
      setPreparing(false);
      setSlowNetwork(false);
      setCallState("active");

      unsubCallRef.current = onSnapshot(doc(db, "calls", activeCall.id), (snap) => {
        const data = snap.data();
        if (!data) return;
        lastCallDataRef.current = data;
        if (data.status === "ended" || data.status === "missed") {
          endLocally();
        }
      });
    } catch (err) {
      if (callTokenRef.current !== token) return; // звонок уже отменён нами же
      cleanupPeer();
      setCallState(null);
      setActiveCall(null);
      setCallError(callSetupError(err, t));
    }
    // profile ЗДЕСЬ важен так же, как и в startCall выше: createPeerConnection
    // читает profile из замыкания этой самой функции (canSendVideo), а без
    // profile в зависимостях acceptCall мог годами держать УСТАРЕВШИЙ снимок
    // (например, сразу после покупки видео-звонков), из-за чего кнопка камеры
    // видна (перерисовывается заново каждый раз из свежего profile), а сам
    // videoSenderRef.current остаётся null — клик по кнопке тогда просто
    // ничего не делает молча (toggleCamera выходит по самой первой проверке).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCall, profile, cleanupPeer, endLocally, t]);

  const declineCall = useCallback(async () => {
    if (!activeCall) return;
    if (!activeCall.id) {
      endLocally();
      return;
    }
    try {
      await updateDoc(doc(db, "calls", activeCall.id), { status: "declined", updatedAt: serverTimestamp() });
    } catch {
      /* звонящий уже мог отменить сам */
    }
    postCallNote(activeCall.chatId, "declined").catch(() => {});
    endLocally();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCall, endLocally]);

  const hangUp = useCallback(async () => {
    if (!activeCall) return;
    // id вызова может быть ещё не в состоянии компонента, но уже в ref'е —
    // между записью в базу и перерисовкой проходит пара миллисекунд, и
    // отменённый ровно в этот момент звонок иначе продолжал бы звонить у
    // собеседника до таймаута.
    const callId = activeCall.id || callIdRef.current;
    // Звонок ещё даже не успел записаться в базу (идёт подготовка — камера,
    // сеть): отменяем локально, а незавершённую подготовку прервёт
    // callTokenRef внутри startCall.
    if (!callId) {
      endLocally();
      return;
    }
    const wasActive = callState === "active";
    const wasRingingOut = callState === "ringing-out";
    const otherChatId = activeCall.chatId;
    const durationSec =
      wasActive && callStartRef.current ? Math.max(0, Math.round((Date.now() - callStartRef.current) / 1000)) : 0;
    try {
      await updateDoc(doc(db, "calls", callId), { status: "ended", updatedAt: serverTimestamp() });
    } catch {
      /* уже могли завершить с той стороны */
    }
    if (wasActive) {
      postCallNote(otherChatId, "ended", durationSec).catch(() => {});
    } else if (wasRingingOut) {
      // Я (звонящий) сам отменил вызов раньше, чем собеседник ответил — для
      // него это выглядит точно так же, как пропущенный звонок по таймауту
      // (см. RING_TIMEOUT_MS выше), поэтому та же заметка и то же письмо,
      // если собеседник сейчас не в сети.
      postCallNote(otherChatId, "missed").catch(() => {});
      notifyIfOffline(activeCall.calleeId, otherChatId).catch(() => {});
    }
    endLocally();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCall, callState, endLocally]);

  const toggleMute = useCallback(() => {
    if (!localStreamRef.current) return;
    const next = !muted;
    localStreamRef.current.getAudioTracks().forEach((t) => (t.enabled = !next));
    setMuted(next);
  }, [muted]);

  const toggleSpeaker = useCallback(async () => {
    const audioEl = remoteAudioRef.current;
    if (!audioEl || typeof audioEl.setSinkId !== "function" || !speakerDeviceIdRef.current) return;
    const next = !speakerOn;
    try {
      await audioEl.setSinkId(next ? speakerDeviceIdRef.current : "default");
      setSpeakerOn(next);
    } catch {
      /* устройство недоступно/отключилось — оставляем звук как было */
    }
  }, [speakerOn]);

  // Включить/выключить СВОЮ камеру посреди разговора. Камера уже подключена
  // к соединению с самого начала звонка (см. createPeerConnection и
  // комментарий у cameraOn выше), просто выключена — здесь только
  // переключаем track.enabled, ровно как toggleMute переключает звук на
  // аудио-треке. Никакого getUserMedia()/replaceTrack() здесь больше нет —
  // а значит, и повода этому шагу самому по себе провалиться. Если видео не
  // куплено, ИЛИ камера оказалась недоступна/запрещена при старте звонка
  // (см. createPeerConnection), localVideoTrackRef.current/videoSenderRef.current
  // так и останутся null — кнопка в CallOverlay.jsx и не должна показываться
  // в первом случае, во втором клик просто ничего не делает молча (тот же
  // давно известный редкий edge-case, что и раньше).
  const toggleCamera = useCallback(() => {
    const track = localVideoTrackRef.current;
    if (!videoSenderRef.current || !track) return;
    setCallError("");
    const next = !cameraOn;
    track.enabled = next;
    if (next) {
      if (localVideoElRef.current) {
        localVideoElRef.current.srcObject = new MediaStream([track]);
        localVideoElRef.current.play().catch(() => {});
      }
      setCameraOn(true);
      watchCameraSent(track);
    } else {
      if (localVideoElRef.current) localVideoElRef.current.srcObject = null;
      setCameraOn(false);
    }
  }, [cameraOn]);

  // Колбэк-рефы для <video> в CallOverlay.jsx — сам элемент то монтируется,
  // то размонтируется (сворачивание звонка в плашку убирает видео из DOM),
  // поэтому при каждом монтировании переподключаем уже текущий поток заново,
  // а не полагаемся на то, что srcObject проставится один раз.
  const attachLocalVideo = useCallback((el) => {
    localVideoElRef.current = el;
    if (el && localVideoTrackRef.current) {
      el.srcObject = new MediaStream([localVideoTrackRef.current]);
      el.play().catch(() => {});
    }
  }, []);

  const attachRemoteVideo = useCallback((el) => {
    remoteVideoElRef.current = el;
    if (el && remoteVideoStreamRef.current) {
      attachStreamToVideoEl(el, remoteVideoStreamRef.current);
    }
  }, []);

  useEffect(() => cleanupPeer, [cleanupPeer]);

  return (
    <CallContext.Provider
      value={{
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
        clearCallError: () => setCallError(""),
        startCall,
        acceptCall,
        declineCall,
        hangUp,
        toggleMute,
        toggleSpeaker,
        videoCallUnlocked: hasVideoCallUnlocked(profile),
        cameraOn,
        remoteVideoOn,
        toggleCamera,
        attachLocalVideo,
        attachRemoteVideo,
      }}
    >
      {children}
      <audio ref={remoteAudioRef} autoPlay />
    </CallContext.Provider>
  );
}

export function useCall() {
  const ctx = useContext(CallContext);
  if (!ctx) throw new Error("useCall must be used within CallProvider");
  return ctx;
}
