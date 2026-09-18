import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "./AuthContext";
import { useCall } from "./CallContext";
import { useLanguage } from "../i18n/LanguageContext";
import { iceServers } from "../utils/webrtcConfig";
import { unlockAudio, startRingback, startRingtone } from "../utils/callSounds";
import { hasVideoCallUnlocked } from "../utils/videoCalls";
import { callSetupError } from "../utils/mediaErrors";
import {
  GROUP_RING_TIMEOUT_MS,
  HEARTBEAT_MS,
  JOIN_CONFIRM_TIMEOUT_MS,
  MAX_PEER_ATTEMPTS,
  PEER_CONNECT_TIMEOUT_MS,
  MAX_PARTICIPANTS,
  MAX_VIDEO_PARTICIPANTS,
  STALE_PARTICIPANT_MS,
  hasLiveParticipant,
  isOfferer,
  isStaleParticipant,
  setGroupCallBusy,
} from "../utils/groupCalls";

// ---------------------------------------------------------------------------
// Групповые звонки в группах (см. utils/groupCalls.js — там про mesh и лимиты,
// firestore.rules -> groupCalls/{callId}).
//
// Личные звонки (contexts/CallContext.jsx) намеренно не трогаем: там всё
// заточено под ровно двоих. Групповой звонок живёт своей коллекцией и своим
// контекстом, пересекаются они только в одном: одновременно можно быть лишь в
// одном звонке (см. privateCallState здесь и isGroupCallBusy в CallContext).
//
// Модель — "комната + дозвон", как групповые звонки в Telegram:
//   • начинающий выбирает, кому звонить — им прилетает входящий вызов;
//   • звонок остаётся открытым, пока в нём есть хоть один человек: остальные
//     участники группы видят в чате плашку "Идёт звонок" и могут зайти позже;
//   • когда выходит последний участник, звонок помечается ended.
//
// Живость участников подтверждается отметками groupCalls/{id}/presence/{uid}
// (раз в HEARTBEAT_MS): без них закрытая вкладка оставляла бы "призрака" в
// списке участников, а группе доставалась бы вечная плашка "идёт звонок",
// которую некому погасить. Протухшего вычищает либо кто-то из самого звонка
// (startStaleSweeper ниже), либо — если в звонке уже никого живого не
// осталось — открытый чат группы (см. ChatWindow.jsx). Та же проверка
// продублирована в firestore.rules.
// ---------------------------------------------------------------------------

const GroupCallContext = createContext(null);

function candidatesCollection(callId, connDocId, side) {
  return collection(
    db,
    "groupCalls",
    callId,
    "conns",
    connDocId,
    side === "a" ? "aCandidates" : "bCandidates"
  );
}

export function GroupCallProvider({ children }) {
  const { user, profile } = useAuth();
  // Личный звонок (CallProvider — внешний провайдер, см. App.jsx): пока идёт
  // он, групповой не начинаем и входящий групповой не показываем, и наоборот
  // (см. utils/groupCalls.js -> isGroupCallBusy).
  const { callState: privateCallState } = useCall() || {};
  const { t } = useLanguage();

  // null — звонка нет; 'ringing-in' — мне звонят; 'ringing-out' — жду, пока
  // возьмут трубку; 'active' — я в звонке.
  const [state, setState] = useState(null);
  const [call, setCall] = useState(null);
  const [incoming, setIncoming] = useState(null);
  const [peers, setPeers] = useState({}); // { uid: { stream, videoOn, connected } }
  const [muted, setMuted] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [error, setError] = useState("");

  const callIdRef = useRef(null);
  const chatIdRef = useRef(null);
  const localStreamRef = useRef(null);
  const localAudioTrackRef = useRef(null);
  const localVideoTrackRef = useRef(null);
  const localVideoElRef = useRef(null);
  const mediaPromiseRef = useRef(null); // чтобы два клика не открыли микрофон дважды
  const joiningRef = useRef(false);
  const peersRef = useRef(new Map());
  const unsubCallRef = useRef(null);
  const unsubConnsRef = useRef(null);
  const heartbeatRef = useRef(null);
  const staleTimerRef = useRef(null);
  const ringTimeoutRef = useRef(null);
  const incomingTimeoutRef = useRef(null);
  const soundStopRef = useRef(null);
  const startedAtRef = useRef(null);
  const participantsRef = useRef([]);
  const stateRef = useRef(null);
  const privateCallStateRef = useRef(null);
  // Offer'ы, пришедшие раньше, чем их автор появился в списке участников:
  // Firestore не пришлёт этот документ повторно, поэтому держим их до момента,
  // когда соединение для этого человека будет создано.
  const pendingOffersRef = useRef(new Map());
  // Сколько раз подряд пересобирали соединение с этим человеком. Живёт вне
  // самого соединения: при пересборке entry создаётся заново, а счётчик
  // должен пережить её, иначе получился бы вечный цикл попыток.
  const peerAttemptsRef = useRef(new Map());
  // Время самого свежего обработанного документа соединения на каждого
  // собеседника — защита от переигрывания документов прошлых сессий (человек
  // мог выйти и зайти снова, старые документы остаются лежать в conns).
  const bestOfferRef = useRef(new Map());
  // Звонки, от которых я отказался: пока меня не позовут заново (мой uid снова
  // появится в invited), экран входящего не показываем.
  const declinedRef = useRef(new Set());

  const busy = state !== null;

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

  useEffect(() => {
    privateCallStateRef.current = privateCallState;
  }, [privateCallState]);

  useEffect(() => {
    stateRef.current = state;
    setGroupCallBusy(state !== null);
    if (state === "ringing-in" || state === "ringing-out") setMinimized(false);
  }, [state]);

  useEffect(() => {
    if (soundStopRef.current) {
      soundStopRef.current();
      soundStopRef.current = null;
    }
    if (state === "ringing-in") {
      soundStopRef.current = startRingtone();
      navigator.vibrate?.([500, 300, 500, 300, 500]);
    } else if (state === "ringing-out") {
      soundStopRef.current = startRingback();
    }
    return () => {
      if (soundStopRef.current) {
        soundStopRef.current();
        soundStopRef.current = null;
      }
    };
  }, [state]);

  // Текст ошибки + технический хвост: без кода понять, что именно отказало
  // (правила, сеть, микрофон), невозможно — а это ровно то, что нужно знать,
  // когда звонок не соединяется.
  function describeCallError(err, tr, stage) {
    const text = callSetupError(err, tr);
    const code = err?.code || err?.name;
    return code ? `${text} [${stage}: ${code}]` : `${text} [${stage}]`;
  }

  // --- закрытие соединений ---------------------------------------------------

  const closePeer = useCallback((uid) => {
    const entry = peersRef.current.get(uid);
    if (!entry) return;
    if (entry.watchdog) clearTimeout(entry.watchdog);
    entry.unsubConn?.();
    entry.unsubCandidates?.();
    try {
      entry.pc.close();
    } catch {
      /* уже закрыт */
    }
    peersRef.current.delete(uid);
    bestOfferRef.current.delete(uid);
    pendingOffersRef.current.delete(uid);
    setPeers((prev) => {
      const next = { ...prev };
      delete next[uid];
      return next;
    });
  }, []);

  const cleanup = useCallback(() => {
    setGroupCallBusy(false);
    if (soundStopRef.current) {
      soundStopRef.current();
      soundStopRef.current = null;
    }
    [ringTimeoutRef, incomingTimeoutRef].forEach((ref) => {
      if (ref.current) {
        clearTimeout(ref.current);
        ref.current = null;
      }
    });
    [heartbeatRef, staleTimerRef].forEach((ref) => {
      if (ref.current) {
        clearInterval(ref.current);
        ref.current = null;
      }
    });
    if (unsubCallRef.current) {
      unsubCallRef.current();
      unsubCallRef.current = null;
    }
    if (unsubConnsRef.current) {
      unsubConnsRef.current();
      unsubConnsRef.current = null;
    }
    peersRef.current.forEach((entry) => {
      entry.unsubConn?.();
      entry.unsubCandidates?.();
      try {
        entry.pc.close();
      } catch {
        /* уже закрыт */
      }
    });
    peersRef.current.clear();
    peerAttemptsRef.current.clear();
    pendingOffersRef.current.clear();
    bestOfferRef.current.clear();
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }
    mediaPromiseRef.current = null;
    localAudioTrackRef.current = null;
    localVideoTrackRef.current = null;
    if (localVideoElRef.current) localVideoElRef.current.srcObject = null;
    callIdRef.current = null;
    chatIdRef.current = null;
    participantsRef.current = [];
    startedAtRef.current = null;
    joiningRef.current = false;
    setPeers({});
    setMuted(false);
    setCameraOn(false);
    setMinimized(false);
    // Ошибки сигнализации прилетают ровно в момент выхода (слушатели conns
    // теряют доступ) — после нормального завершения звонка показывать их
    // незачем.
    setError("");
  }, []);

  const endLocally = useCallback(() => {
    cleanup();
    setState(null);
    setCall(null);
  }, [cleanup]);

  // Размонтирование провайдера (выход из аккаунта, уход из защищённой части
  // приложения) обязано гасить микрофон/камеру и снимать флаг "я в звонке" —
  // иначе лампочка камеры горит до перезагрузки страницы, а личные звонки
  // потом молча перестают работать.
  useEffect(() => {
    return () => {
      cleanup();
      setGroupCallBusy(false);
    };
  }, [cleanup]);

  // --- медиа -----------------------------------------------------------------

  // Один общий микрофон (и, если видео куплено и звонок небольшой, одна общая
  // камера) на все соединения сразу. mediaPromiseRef защищает от двойного
  // клика: два параллельных getUserMedia оставили бы "потерянный" поток,
  // который потом некому остановить, и лампочка микрофона горела бы до
  // перезагрузки.
  function ensureLocalMedia(wantVideo) {
    if (localStreamRef.current) return Promise.resolve(localStreamRef.current);
    if (mediaPromiseRef.current) return mediaPromiseRef.current;
    const promise = (async () => {
      let stream;
      if (wantVideo) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        } catch {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        }
      } else {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      }
      localStreamRef.current = stream;
      localAudioTrackRef.current = stream.getAudioTracks()[0] || null;
      const videoTrack = stream.getVideoTracks()[0] || null;
      if (videoTrack) {
        // Камера подключается к соединениям сразу, но выключенной: трек
        // участвует в SDP-согласовании с самого начала, а кнопка потом просто
        // переключает enabled (тот же приём, что и в личных звонках).
        videoTrack.enabled = false;
        localVideoTrackRef.current = videoTrack;
      }
      return stream;
    })();
    mediaPromiseRef.current = promise;
    promise.catch(() => {
      mediaPromiseRef.current = null;
    });
    return promise;
  }

  const attachLocalVideo = useCallback((el) => {
    localVideoElRef.current = el;
    if (el && localStreamRef.current) {
      el.srcObject = localStreamRef.current;
      el.play?.().catch(() => {});
    }
  }, []);

  // --- сигнализация ----------------------------------------------------------
  //
  // На каждую ПОПЫТКУ соединения пары — свой документ в conns с автоматическим
  // id: человек может выйти и зайти снова, и тогда ему нужно полностью новое
  // соединение, а не переписанный поверх старый документ. Документ создаёт
  // тот, чей uid меньше (поле a), он же делает offer; второй (b) отвечает.
  // Правило "кто первый" одинаково считается на обоих клиентах (см.
  // utils/groupCalls.js -> isOfferer), поэтому встречных offer'ов не бывает.

  function attachCandidates(entry, pc, callId, connDocId, mySide) {
    const theirSide = mySide === "a" ? "b" : "a";
    entry.connDocId = connDocId;
    const pendingLocal = entry.pendingLocal;
    entry.pendingLocal = [];
    pendingLocal.forEach((json) =>
      addDoc(candidatesCollection(callId, connDocId, mySide), json).catch(() => {})
    );
    entry.unsubCandidates?.();
    entry.unsubCandidates = onSnapshot(
      query(candidatesCollection(callId, connDocId, theirSide), orderBy("__name__")),
      (snap) => {
        snap.docChanges().forEach((change) => {
          if (change.type !== "added") return;
          const candidate = new RTCIceCandidate(change.doc.data());
          if (pc.remoteDescription) {
            pc.addIceCandidate(candidate).catch(() => {});
          } else {
            entry.pendingRemote.push(candidate);
          }
        });
      },
      () => setError(t("groupCalls.signalingError"))
    );
  }

  function flushRemoteCandidates(entry, pc) {
    const pending = entry.pendingRemote;
    entry.pendingRemote = [];
    pending.forEach((candidate) => pc.addIceCandidate(candidate).catch(() => {}));
  }

  // Обработка offer'а ставится в очередь на соединение: в одном снапшоте может
  // прийти несколько документов для одной пары, а параллельные
  // setRemoteDescription/createAnswer на одном RTCPeerConnection ломают его
  // насмерть (InvalidStateError).
  function applyIncomingOffer(entry, otherUid, callId, docId, offerData) {
    entry.chain = entry.chain
      .then(async () => {
        if (peersRef.current.get(otherUid) !== entry) return;
        const pc = entry.pc;
        if (pc.signalingState === "closed") return;
        entry.connDocId = docId;
        await pc.setRemoteDescription(new RTCSessionDescription(offerData));
        if (peersRef.current.get(otherUid) !== entry) return;
        attachCandidates(entry, pc, callId, docId, "b");
        flushRemoteCandidates(entry, pc);
        const answer = await pc.createAnswer();
        if (peersRef.current.get(otherUid) !== entry) return;
        await pc.setLocalDescription(answer);
        await updateDoc(doc(db, "groupCalls", callId, "conns", docId), {
          answer: { type: answer.type, sdp: answer.sdp },
          updatedAt: serverTimestamp(),
        });
      })
      .catch(() => {
        // Соединение могло закрыться посреди согласования — это нормально;
        // ошибку показываем, только если этот собеседник всё ещё в звонке.
        if (peersRef.current.get(otherUid) === entry) setError(t("groupCalls.peerFailedError"));
      });
  }

  // Соединение с конкретным участником зависло на "Соединяем…" — собираем его
  // заново: закрываем старое и создаём новое, с новым offer'ом в новом
  // документе. Именно так лечится потерянный по дороге снапшот сигнализации —
  // переспросить его невозможно, можно только начать попытку заново.
  function restartPeer(otherUid) {
    const attempts = (peerAttemptsRef.current.get(otherUid) || 0) + 1;
    peerAttemptsRef.current.set(otherUid, attempts);
    closePeer(otherUid);
    if (!participantsRef.current.includes(otherUid)) return;
    if (attempts >= MAX_PEER_ATTEMPTS) {
      // Больше не пытаемся: дело не в потерянном сообщении, а в сети.
      setError(t("groupCalls.peerFailedError"));
      return;
    }
    createPeer(otherUid);
  }

  // Заводим таймер на попытку соединения. Снимается, как только соединение
  // встало (см. onconnectionstatechange ниже) или собеседник вышел.
  function armConnectWatchdog(otherUid, entry) {
    if (entry.watchdog) clearTimeout(entry.watchdog);
    entry.watchdog = setTimeout(() => {
      if (peersRef.current.get(otherUid) !== entry) return;
      if (entry.pc.connectionState === "connected") return;
      restartPeer(otherUid);
    }, PEER_CONNECT_TIMEOUT_MS);
  }

  function createPeer(otherUid) {
    if (!user || peersRef.current.has(otherUid)) return;
    const callId = callIdRef.current;
    if (!callId) return;

    const pc = new RTCPeerConnection({ iceServers: iceServers() });
    const mySide = isOfferer(user.uid, otherUid) ? "a" : "b";
    const entry = {
      pc,
      mySide,
      connDocId: null,
      unsubConn: null,
      unsubCandidates: null,
      pendingRemote: [],
      pendingLocal: [],
      chain: Promise.resolve(),
      watchdog: null,
    };
    peersRef.current.set(otherUid, entry);
    armConnectWatchdog(otherUid, entry);

    const stream = localStreamRef.current;
    if (stream) {
      const audioTrack = localAudioTrackRef.current;
      if (audioTrack) pc.addTrack(audioTrack, stream);
      const videoTrack = localVideoTrackRef.current;
      if (videoTrack) {
        pc.addTrack(videoTrack, stream);
      } else {
        // Своего видео нет (не куплено, звонок большой или камера недоступна) —
        // всё равно резервируем приём, чтобы видеть тех, кто камеру включит.
        pc.addTransceiver("video", { direction: "recvonly" });
      }
    }

    pc.ontrack = (event) => {
      const track = event.track;
      const remoteStream = event.streams[0] || new MediaStream([track]);
      const syncVideo = () => {
        const on = !track.muted && track.readyState === "live";
        setPeers((prev) => ({
          ...prev,
          [otherUid]: { ...(prev[otherUid] || {}), stream: remoteStream, videoOn: on },
        }));
      };
      if (track.kind === "video") {
        track.onmute = syncVideo;
        track.onunmute = syncVideo;
        syncVideo();
      } else {
        setPeers((prev) => ({
          ...prev,
          [otherUid]: { ...(prev[otherUid] || {}), stream: remoteStream },
        }));
      }
    };

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      const json = event.candidate.toJSON();
      if (entry.connDocId) {
        addDoc(candidatesCollection(callId, entry.connDocId, entry.mySide), json).catch(() => {});
      } else {
        entry.pendingLocal.push(json);
      }
    };

    pc.onconnectionstatechange = () => {
      const connected = pc.connectionState === "connected";
      setPeers((prev) => ({
        ...prev,
        [otherUid]: { ...(prev[otherUid] || {}), connected },
      }));
      if (connected) {
        // Дошло — сторожевой таймер больше не нужен, и счётчик попыток можно
        // обнулить: следующий обрыв снова получит все три попытки.
        if (entry.watchdog) {
          clearTimeout(entry.watchdog);
          entry.watchdog = null;
        }
        peerAttemptsRef.current.delete(otherUid);
        return;
      }
      // "failed" — ICE признал, что путь не найден. Ждать тут нечего, сразу
      // пересобираем: часто со второй попытки кандидаты приходят другие и
      // соединение встаёт.
      if (pc.connectionState === "failed" && peersRef.current.get(otherUid) === entry) {
        restartPeer(otherUid);
      }
    };

    if (mySide === "a") {
      entry.chain = entry.chain
        .then(async () => {
          const offer = await pc.createOffer();
          if (peersRef.current.get(otherUid) !== entry) return;
          await pc.setLocalDescription(offer);
          if (peersRef.current.get(otherUid) !== entry) return;
          const connRef = await addDoc(collection(db, "groupCalls", callId, "conns"), {
            a: user.uid,
            b: otherUid,
            offer: { type: offer.type, sdp: offer.sdp },
            createdAt: serverTimestamp(),
          });
          // Пока шла запись, человек мог выйти из звонка — тогда вешать
          // слушателей уже некуда и незачем (иначе они останутся висеть
          // навсегда).
          if (peersRef.current.get(otherUid) !== entry) return;
          attachCandidates(entry, pc, callId, connRef.id, "a");
          entry.unsubConn = onSnapshot(
            connRef,
            async (snap) => {
              const data = snap.data();
              if (!data?.answer || pc.signalingState !== "have-local-offer") return;
              try {
                await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
                flushRemoteCandidates(entry, pc);
              } catch {
                /* соединение закрылось, пока шёл ответ */
              }
            },
            () => setError(t("groupCalls.signalingError"))
          );
        })
        .catch(() => {
          if (peersRef.current.get(otherUid) === entry) setError(t("groupCalls.peerFailedError"));
        });
    } else {
      // Сторона b сама ничего не создаёт: offer приходит в общий слушатель
      // (watchIncomingConnections). Он мог прийти ещё до того, как этот
      // человек появился в списке участников — тогда он лежит отложенным.
      const pending = pendingOffersRef.current.get(otherUid);
      if (pending) {
        pendingOffersRef.current.delete(otherUid);
        bestOfferRef.current.set(otherUid, pending.createdMs);
        applyIncomingOffer(entry, otherUid, callId, pending.docId, pending.offer);
      }
    }
  }

  // Один слушатель на весь звонок: документы соединений, где отвечающая
  // сторона — я. Документы прошлых сессий той же пары тоже остаются в conns
  // (удалять их правила не разрешают), поэтому берём строго самый свежий по
  // createdAt и никогда не возвращаемся к более старому.
  function watchIncomingConnections(callId) {
    if (unsubConnsRef.current) unsubConnsRef.current();
    unsubConnsRef.current = onSnapshot(
      query(collection(db, "groupCalls", callId, "conns"), where("b", "==", user.uid)),
      (snap) => {
        const newest = new Map();
        snap.docs.forEach((d) => {
          const data = d.data();
          if (!data?.offer || !data.a) return;
          const createdMs = data.createdAt?.toMillis?.() || 0;
          const prev = newest.get(data.a);
          if (!prev || createdMs > prev.createdMs) {
            newest.set(data.a, { docId: d.id, offer: data.offer, createdMs });
          }
        });
        newest.forEach((info, otherUid) => {
          const known = bestOfferRef.current.get(otherUid) || 0;
          // createdMs === 0 — серверная метка ещё не проставилась; такой
          // документ обрабатываем, если он не тот же самый, что уже обработан.
          if (info.createdMs && info.createdMs <= known) return;
          if (!info.createdMs && peersRef.current.get(otherUid)?.connDocId === info.docId) return;
          const entry = peersRef.current.get(otherUid);
          if (!entry) {
            pendingOffersRef.current.set(otherUid, info);
            return;
          }
          bestOfferRef.current.set(otherUid, info.createdMs);
          applyIncomingOffer(entry, otherUid, callId, info.docId, info.offer);
        });
      },
      () => setError(t("groupCalls.signalingError"))
    );
  }

  const syncPeers = useCallback(
    (participants) => {
      if (!user) return;
      const others = participants.filter((uid) => uid !== user.uid);
      others.forEach((uid) => {
        if (!peersRef.current.has(uid)) createPeer(uid);
      });
      [...peersRef.current.keys()].forEach((uid) => {
        if (!others.includes(uid)) closePeer(uid);
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user?.uid, closePeer]
  );

  // --- живость участников ----------------------------------------------------

  // Своя отметка "я ещё здесь" — отдельным документом
  // groupCalls/{id}/presence/{uid}, чтобы не переписывать сам звонок каждые
  // полминуты (его снапшот прилетает всем участникам и всем, у кого открыт
  // чат группы).
  function writePresence(callId) {
    if (!user) return Promise.resolve();
    return setDoc(doc(db, "groupCalls", callId, "presence", user.uid), {
      at: serverTimestamp(),
    }).catch(() => {});
  }

  function startHeartbeat(callId) {
    if (heartbeatRef.current) clearInterval(heartbeatRef.current);
    const beat = () => {
      if (!user || callIdRef.current !== callId) return;
      writePresence(callId);
    };
    beat();
    heartbeatRef.current = setInterval(beat, HEARTBEAT_MS);
  }

  async function readPresence(callId) {
    const snap = await getDocs(collection(db, "groupCalls", callId, "presence"));
    const map = {};
    snap.docs.forEach((d) => {
      map[d.id] = d.data()?.at;
    });
    return map;
  }

  // Вычищаем тех, чьи отметки протухли (вкладку закрыли, связь пропала) — по
  // одному за раз, ровно как это разрешают правила. Если после этого в звонке
  // никого не осталось, закрываем и сам звонок, иначе группа осталась бы с
  // вечной плашкой "идёт звонок".
  //
  // Подметает только ОДИН участник — тот, у кого самый маленький uid среди
  // живых: иначе все двадцать человек читали бы отметки друг друга по кругу.
  function startStaleSweeper(callId) {
    if (staleTimerRef.current) clearInterval(staleTimerRef.current);
    staleTimerRef.current = setInterval(async () => {
      if (!user || callIdRef.current !== callId) return;
      const participants = participantsRef.current;
      if (participants.length < 2) return;
      try {
        const presence = await readPresence(callId);
        const alive = participants.filter((uid) => !isStaleParticipant(presence[uid]));
        // Подметает тот, кто "первый по алфавиту" среди живых.
        if (alive.length && [...alive].sort()[0] !== user.uid) return;
        const stale = participants.find(
          (uid) => uid !== user.uid && isStaleParticipant(presence[uid])
        );
        if (!stale) return;
        await runTransaction(db, async (tx) => {
          const ref = doc(db, "groupCalls", callId);
          const snap = await tx.get(ref);
          const data = snap.data();
          if (!data || data.status !== "live") return;
          if (!(data.participants || []).includes(stale)) return;
          const rest = (data.participants || []).filter((uid) => uid !== stale);
          tx.update(ref, { participants: rest, updatedAt: serverTimestamp() });
        });
      } catch {
        /* кто-то успел раньше — не страшно */
      }
    }, Math.round(STALE_PARTICIPANT_MS / 3));
  }

  // --- слежение за звонком ---------------------------------------------------

  function watchCall(callId) {
    if (unsubCallRef.current) unsubCallRef.current();
    watchIncomingConnections(callId);
    startHeartbeat(callId);
    startStaleSweeper(callId);
    // Пока сервер не ответил ни разу, снапшоты приходят ИЗ КЭША — и держат
    // состояние звонка на момент ДО нашего входа.
    //
    // Из-за этого вход ломался наглухо. Человек нажимал "Присоединиться",
    // микрофон включался, транзакция добавляла его в participants — а сразу
    // за ней onSnapshot синхронно отдавал кэшированный документ, где его в
    // participants ещё нет (кэш заполнил экран входящего вызова, который всё
    // это время слушал тот же документ). Ветка "меня убрали из звонка" ниже
    // принимала это за чистую монету и вызывала endLocally(): микрофон гас,
    // экран закрывался. На сервере при этом человек оставался участником и
    // висел там, пока его не вычистят как протухшего, а звонивший через
    // несколько секунд получал "не удалось соединиться с участником".
    //
    // Транзакции Firestore принципиально не обновляют локальный кэш заранее
    // (в отличие от обычных записей), поэтому лечится это только здесь:
    // кэшу до первого ответа сервера доверять нельзя.
    let sawServerSnapshot = false;
    // Видел ли я хоть один снапшот, где я ЕСТЬ в участниках.
    //
    // Это главная защита от вылета при входе, и вот почему одного признака
    // "снапшот из кэша" мало. fromCache === false означает "SDK считает, что
    // синхронизирован с сервером" — а вовсе не "здесь учтена моя последняя
    // запись". Транзакция подтверждается раньше, чем обновление документа
    // доезжает по потоку изменений, и в этом промежутке приходит снапшот с
    // fromCache === false, где меня в участниках ещё нет.
    //
    // Заметнее всего это было при входе с экрана входящего вызова: там на
    // тот же документ УЖЕ висел слушатель (экран звонка), документ был
    // синхронизирован, и первый же снапшот нового слушателя приходил
    // "серверным", но старым. Ветка "меня убрали из звонка" принимала это
    // за правду и вызывала endLocally(): окно звонка вспыхивало и тут же
    // закрывалось, микрофон гас. При входе по плашке в чате слушателя на
    // документе не было, снапшот приходил уже с учётом входа — и всё
    // работало. Отсюда и разница между двумя кнопками.
    //
    // Поэтому решение о выходе принимается только после того, как звонок
    // хоть раз подтвердил моё присутствие.
    let sawMyself = false;
    const joinTimer = setTimeout(() => {
      if (sawMyself || callIdRef.current !== callId) return;
      // За всё это время сервер так и не подтвердил вход — выходим честно,
      // с объяснением, а не висим в звонке, которого нет.
      endLocally();
      setError(t("groupCalls.joinNotConfirmedError"));
    }, JOIN_CONFIRM_TIMEOUT_MS);
    const unsubCall = onSnapshot(
      doc(db, "groupCalls", callId),
      (snap) => {
        // Кэшу не доверяем только в РЕШЕНИЯХ О ВЫХОДЕ (две ветки ниже):
        // показать список участников по кэшу можно и нужно — тот, кто звонок
        // начал, увидит свой экран сразу, не дожидаясь ответа сервера.
        const stale = snap.metadata.fromCache && !sawServerSnapshot;
        if (!snap.metadata.fromCache) sawServerSnapshot = true;
        const data = snap.data();
        if (!data || data.status !== "live") {
          if (stale) return;
          endLocally();
          return;
        }
        const participants = data.participants || [];
        setCall({ id: callId, ...data });
        participantsRef.current = participants;
        if (user && participants.includes(user.uid)) sawMyself = true;
        if (user && !participants.includes(user.uid)) {
          // Меня убрали из звонка (вышел с другого устройства, вычистили как
          // протухшего) — закрываем экран. Но только если звонок хотя бы раз
          // уже подтвердил, что я в нём был: см. комментарий выше.
          if (stale || !sawMyself) return;
          endLocally();
          return;
        }
        syncPeers(participants);
        // Гудки — только пока я действительно жду ответа. Один в комнате без
        // дозвона — это уже обычный активный звонок, просто пока пустой.
        setState(participants.length > 1 || !(data.invited || []).length ? "active" : "ringing-out");
        if (participants.length > 1 && !startedAtRef.current) startedAtRef.current = Date.now();
      },
      () => {
        // Сначала уборка, потом текст ошибки: cleanup() в конце сбрасывает
        // error, и если поменять порядок, сообщение молча исчезнет.
        endLocally();
        setError(t("groupCalls.signalingError"));
      }
    );
    // Таймер подтверждения входа снимается вместе с самим слушателем.
    unsubCallRef.current = () => {
      clearTimeout(joinTimer);
      unsubCall();
    };
  }

  // --- заметка в чат ---------------------------------------------------------

  async function postGroupCallNote(chatId, durationSec) {
    if (!chatId || !user) return;
    try {
      await addDoc(collection(db, "chats", chatId, "messages"), {
        type: "call_ended",
        text: "",
        senderId: user.uid,
        durationSec: durationSec || 0,
        groupCall: true,
        createdAt: serverTimestamp(),
      });
      await updateDoc(doc(db, "chats", chatId), {
        lastMessage: {
          text: t("groupCalls.chatNote"),
          senderId: user.uid,
          senderName: profile?.name || null,
          createdAt: serverTimestamp(),
        },
        updatedAt: serverTimestamp(),
      });
    } catch {
      /* заметка не критична — сам звонок уже состоялся */
    }
  }

  // --- действия --------------------------------------------------------------

  // Дозвониться ещё кому-то (в том числе сразу после входа в чужой звонок).
  const inviteToCall = useCallback(
    async (uids) => {
      const callId = callIdRef.current;
      if (!callId || !user || !uids?.length) return;
      setError("");
      try {
        await runTransaction(db, async (tx) => {
          const ref = doc(db, "groupCalls", callId);
          const snap = await tx.get(ref);
          const data = snap.data();
          if (!data || data.status !== "live") return;
          const participants = data.participants || [];
          const invited = data.invited || [];
          const next = [...invited];
          uids.forEach((uid) => {
            if (uid !== user.uid && !invited.includes(uid) && !participants.includes(uid)) next.push(uid);
          });
          if (next.length === invited.length) return;
          if (participants.length + next.length > MAX_PARTICIPANTS) throw new Error(t("groupCalls.fullError"));
          tx.update(ref, { invited: next, updatedAt: serverTimestamp() });
        });
        scheduleRingTimeout(callId);
      } catch (err) {
        setError(err?.message || String(err));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user?.uid]
  );

  // Войти в звонок: и ответ на входящий вызов, и "присоединиться" из чата.
  const joinGroupCall = useCallback(
    async (callId, chatId) => {
      if (!user || privateCallState || joiningRef.current) return;
      if (callIdRef.current) return; // уже в звонке
      joiningRef.current = true;
      setError("");
      // На каком шаге всё сломалось. Без этого человек видел просто гаснущий
      // микрофон и закрывшийся экран: причина терялась, а уборка в конце ещё
      // и затирала текст ошибки (см. cleanup -> setError("")).
      let stage = "read";
      try {
        // Сначала читаем звонок и берём микрофон, и только потом входим.
        // Наоборот нельзя: пока человек думает над запросом разрешений
        // (на телефоне это легко больше минуты), его успели бы вычистить из
        // участников как протухшего, а при отказе он остался бы в списке
        // "призраком", которого некому убрать.
        const preSnap = await getDoc(doc(db, "groupCalls", callId));
        const preData = preSnap.data();
        if (!preData || preData.status !== "live") throw new Error(t("groupCalls.alreadyEndedError"));
        const preParticipants = preData.participants || [];
        if (preParticipants.length >= MAX_PARTICIPANTS && !preParticipants.includes(user.uid)) {
          throw new Error(t("groupCalls.fullError"));
        }
        // Камеру захватываем, только если ею вообще можно будет пользоваться —
        // иначе в звонке на 15 человек лампочка камеры горела бы впустую.
        const wantVideo =
          hasVideoCallUnlocked(profile) && preParticipants.length + 1 <= MAX_VIDEO_PARTICIPANTS;
        stage = "media";
        await ensureLocalMedia(wantVideo);
        // Отметку живости ставим ДО входа — иначе в первые секунды нас можно
        // было бы принять за призрака.
        stage = "presence";
        await writePresence(callId);
        stage = "join";
        await runTransaction(db, async (tx) => {
          const ref = doc(db, "groupCalls", callId);
          const snap = await tx.get(ref);
          const data = snap.data();
          if (!data || data.status !== "live") throw new Error(t("groupCalls.alreadyEndedError"));
          const participants = data.participants || [];
          if (participants.includes(user.uid)) return;
          if (participants.length >= MAX_PARTICIPANTS) throw new Error(t("groupCalls.fullError"));
          tx.update(ref, {
            participants: participants.concat([user.uid]),
            invited: (data.invited || []).filter((uid) => uid !== user.uid),
            updatedAt: serverTimestamp(),
          });
        });
        stage = "watch";
        callIdRef.current = callId;
        chatIdRef.current = chatId || null;
        setIncoming(null);
        declinedRef.current.delete(callId);
        setState("active");
        watchCall(callId);
      } catch (err) {
        cleanup();
        setState(null);
        setCall(null);
        setIncoming(null);
        // Текст ставим ПОСЛЕ уборки — она обнуляет error.
        setError(describeCallError(err, t, stage));
      } finally {
        joiningRef.current = false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user?.uid, profile, privateCallState, cleanup]
  );

  // Начать звонок в группе и позвонить выбранным людям. Если звонок в этой
  // группе уже идёт, второй не создаём — заходим в существующий, иначе группа
  // разъехалась бы по двум комнатам.
  const startGroupCall = useCallback(
    async (chat, inviteUids) => {
      if (!user || busy || privateCallState || joiningRef.current) return;
      setError("");
      try {
        const existing = await getDocs(
          query(
            collection(db, "groupCalls"),
            where("chatId", "==", chat.id),
            where("status", "==", "live"),
            limit(5)
          )
        );
        // "Живой" — не просто с непустым списком участников, а с хотя бы одной
        // свежей отметкой присутствия: иначе можно было бы войти в мёртвую
        // комнату с призраками и минуту ждать, пока их вычистят.
        let alive = null;
        for (const d of existing.docs) {
          const data = d.data();
          if (!(data.participants || []).length) continue;
          // eslint-disable-next-line no-await-in-loop
          const presence = await readPresence(d.id).catch(() => null);
          if (hasLiveParticipant({ id: d.id, ...data }, presence)) {
            alive = d;
            break;
          }
        }
        if (alive) {
          await joinGroupCall(alive.id, chat.id);
          await inviteToCall(inviteUids);
          return;
        }

        joiningRef.current = true;
        const invited = (inviteUids || []).filter((uid) => uid !== user.uid).slice(0, MAX_PARTICIPANTS - 1);
        const wantVideo = hasVideoCallUnlocked(profile) && invited.length + 1 <= MAX_VIDEO_PARTICIPANTS;
        await ensureLocalMedia(wantVideo);
        const callRef = await addDoc(collection(db, "groupCalls"), {
          chatId: chat.id,
          chatName: chat.name || "",
          startedBy: user.uid,
          startedByName: profile?.name || "",
          status: "live",
          participants: [user.uid],
          invited,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        callIdRef.current = callRef.id;
        chatIdRef.current = chat.id;
        await writePresence(callRef.id);
        setState(invited.length ? "ringing-out" : "active");
        watchCall(callRef.id);
        scheduleRingTimeout(callRef.id);
      } catch (err) {
        cleanup();
        setError(describeCallError(err, t, "start"));
        setState(null);
        setCall(null);
      } finally {
        joiningRef.current = false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user?.uid, profile, busy, privateCallState, cleanup, joinGroupCall, inviteToCall]
  );

  // Через 45 секунд перестаём дозваниваться тем, кто не ответил: сам звонок
  // продолжается как комната, просто у них перестаёт звонить телефон.
  function scheduleRingTimeout(callId) {
    if (ringTimeoutRef.current) clearTimeout(ringTimeoutRef.current);
    ringTimeoutRef.current = setTimeout(() => {
      ringTimeoutRef.current = null;
      runTransaction(db, async (tx) => {
        const ref = doc(db, "groupCalls", callId);
        const snap = await tx.get(ref);
        const data = snap.data();
        if (!data || data.status !== "live" || !(data.invited || []).length) return;
        tx.update(ref, { invited: [], updatedAt: serverTimestamp() });
      }).catch(() => {});
    }, GROUP_RING_TIMEOUT_MS);
  }

  const acceptIncoming = useCallback(async () => {
    if (!incoming) return;
    await joinGroupCall(incoming.id, incoming.chatId);
  }, [incoming, joinGroupCall]);

  // Отклонить входящий: убираем себя из списка "звоним". Сам звонок
  // продолжается без меня, зайти позже из чата всё ещё можно.
  const declineIncoming = useCallback(async () => {
    const target = incoming;
    setIncoming(null);
    setState(null);
    if (!target || !user) return;
    declinedRef.current.add(target.id);
    try {
      await runTransaction(db, async (tx) => {
        const ref = doc(db, "groupCalls", target.id);
        const snap = await tx.get(ref);
        const data = snap.data();
        if (!data || data.status !== "live") return;
        if (!(data.invited || []).includes(user.uid)) return;
        tx.update(ref, {
          invited: (data.invited || []).filter((uid) => uid !== user.uid),
          updatedAt: serverTimestamp(),
        });
      });
    } catch {
      /* звонок мог уже закончиться */
    }
  }, [incoming, user]);

  // Выйти из звонка. Последний уходящий закрывает звонок целиком и оставляет
  // заметку в чате.
  const leaveCall = useCallback(async () => {
    const callId = callIdRef.current;
    const chatId = chatIdRef.current;
    const durationSec = startedAtRef.current ? Math.round((Date.now() - startedAtRef.current) / 1000) : 0;
    // Список участников на момент выхода — endLocally() ниже обнуляет
    // participantsRef, а он нужен запасному пути в catch.
    const participantsBefore = [...participantsRef.current];
    let wasLast = false;
    endLocally();
    if (!callId || !user) return;
    try {
      await runTransaction(db, async (tx) => {
        const ref = doc(db, "groupCalls", callId);
        const snap = await tx.get(ref);
        const data = snap.data();
        if (!data || data.status !== "live") return;
        const participants = data.participants || [];
        if (!participants.includes(user.uid)) return;
        const rest = participants.filter((uid) => uid !== user.uid);
        if (rest.length === 0) {
          wasLast = true;
          tx.update(ref, { participants: [], invited: [], status: "ended", updatedAt: serverTimestamp() });
        } else {
          tx.update(ref, { participants: rest, updatedAt: serverTimestamp() });
        }
      });
    } catch {
      // Закрыть звонок целиком не вышло (правила, гонка, обрыв связи).
      // Запасной путь: выйти хотя бы из participants — это разрешено всегда
      // и никем не блокируется. Комната останется live, но уже ПУСТОЙ, а
      // пустую закрывает любой участник группы, у кого открыт чат (см.
      // ChatWindow.jsx -> closeDeadGroupCall). Молча проглатывать ошибку
      // нельзя: именно так у тех, кто не успел присоединиться, звонок
      // "продолжал идти" до перезагрузки страницы.
      try {
        await updateDoc(doc(db, "groupCalls", callId), {
          participants: participantsBefore.filter((uid) => uid !== user.uid),
          updatedAt: serverTimestamp(),
        });
      } catch {
        /* и это не прошло — меня уберут по протухшей отметке presence */
      }
    }
    if (wasLast) postGroupCallNote(chatId, durationSec).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid, endLocally]);

  // Завершить звонок ДЛЯ ВСЕХ — в отличие от обычного выхода, комната
  // закрывается целиком и присоединиться к ней больше нельзя. Право на это
  // есть у того, кто звонок начал, и у владельца группы (то же самое
  // проверяют правила, см. firestore.rules -> groupCalls update).
  const endCallForAll = useCallback(async () => {
    const callId = callIdRef.current;
    const chatId = chatIdRef.current;
    const durationSec = startedAtRef.current ? Math.round((Date.now() - startedAtRef.current) / 1000) : 0;
    endLocally();
    if (!callId || !user) return;
    try {
      await updateDoc(doc(db, "groupCalls", callId), {
        participants: [],
        invited: [],
        status: "ended",
        updatedAt: serverTimestamp(),
      });
      postGroupCallNote(chatId, durationSec).catch(() => {});
    } catch {
      // Правила не пустили (например, звонок начал кто-то другой) — тогда это
      // всё равно обычный выход, я из участников уже вышел локально.
      setError(t("groupCalls.endForAllError"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid, endLocally]);

  const toggleMute = useCallback(() => {
    const track = localAudioTrackRef.current;
    if (!track) return;
    track.enabled = !track.enabled;
    setMuted(!track.enabled);
  }, []);

  const participantsCount = (call?.participants || []).length;
  const videoUnlocked = hasVideoCallUnlocked(profile);
  const cameraAvailable =
    videoUnlocked && !!localVideoTrackRef.current && participantsCount <= MAX_VIDEO_PARTICIPANTS;

  const toggleCamera = useCallback(() => {
    const track = localVideoTrackRef.current;
    if (!track) return;
    if (!track.enabled && participantsRef.current.length > MAX_VIDEO_PARTICIPANTS) {
      setError(t("groupCalls.videoTooManyError", { max: MAX_VIDEO_PARTICIPANTS }));
      return;
    }
    track.enabled = !track.enabled;
    setCameraOn(track.enabled);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);

  // Звонок разросся, пока камера была включена — выключаем её сами: иначе
  // видео продолжало бы уходить во все соединения, а кнопки, чтобы его
  // выключить, на экране уже нет.
  useEffect(() => {
    if (!cameraOn || participantsCount <= MAX_VIDEO_PARTICIPANTS) return;
    const track = localVideoTrackRef.current;
    if (track) track.enabled = false;
    setCameraOn(false);
    setError(t("groupCalls.videoTooManyError", { max: MAX_VIDEO_PARTICIPANTS }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraOn, participantsCount]);

  // --- входящие вызовы -------------------------------------------------------

  useEffect(() => {
    if (!user) return undefined;
    const q = query(
      collection(db, "groupCalls"),
      where("invited", "array-contains", user.uid),
      where("status", "==", "live")
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        snap.docs.forEach((d) => {
          const data = d.data();
          const invited = data.invited || [];
          // Меня перестали звать — забываем отказ, чтобы повторный вызов
          // (кнопка "Добавить" в идущем звонке) снова зазвонил.
          if (!invited.includes(user.uid)) {
            declinedRef.current.delete(d.id);
            return;
          }
          if (declinedRef.current.has(d.id)) return;
          if ((data.participants || []).includes(user.uid)) return;
          if (callIdRef.current || stateRef.current || privateCallStateRef.current) return;
          setIncoming({ id: d.id, ...data });
          setState("ringing-in");
        });
      },
      () => setError(t("groupCalls.signalingError"))
    );
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid]);

  // Пока я думаю, отвечать ли, звонок могли завершить или перестать
  // дозваниваться именно мне — в обоих случаях экран входящего закрывается
  // сам, а не звонит вечно. Плюс свой таймаут на случай, если инициатор
  // просто исчез вместе с вкладкой.
  useEffect(() => {
    if (!incoming || !user) return undefined;
    const unsub = onSnapshot(
      doc(db, "groupCalls", incoming.id),
      (snap) => {
        const data = snap.data();
        const stillRinging = data && data.status === "live" && (data.invited || []).includes(user.uid);
        if (!stillRinging) {
          setIncoming(null);
          if (!callIdRef.current) setState(null);
        }
      },
      () => {
        setIncoming(null);
        if (!callIdRef.current) setState(null);
      }
    );
    incomingTimeoutRef.current = setTimeout(() => {
      // Никто не убрал меня из invited (инициатор мог просто закрыть вкладку) —
      // помечаем звонок отказанным локально, иначе экран входящего всплывал бы
      // заново при каждом изменении документа звонка.
      declinedRef.current.add(incoming.id);
      setIncoming(null);
      if (!callIdRef.current) setState(null);
    }, GROUP_RING_TIMEOUT_MS);
    return () => {
      unsub();
      if (incomingTimeoutRef.current) {
        clearTimeout(incomingTimeoutRef.current);
        incomingTimeoutRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming?.id, user?.uid]);

  // Закрытие вкладки: пытаемся выйти по-честному. Если я последний — сразу
  // закрываем звонок, иначе группа осталась бы с вечной плашкой "идёт
  // звонок". Если запись не успеет уйти, меня вычистят по протухшей отметке
  // seen (см. startStaleSweeper).
  useEffect(() => {
    if (!state || state === "ringing-in") return undefined;
    const onUnload = () => {
      const callId = callIdRef.current;
      if (!callId || !user) return;
      const rest = participantsRef.current.filter((uid) => uid !== user.uid);
      const payload =
        rest.length === 0
          ? { participants: [], invited: [], status: "ended", updatedAt: serverTimestamp() }
          : { participants: rest, updatedAt: serverTimestamp() };
      updateDoc(doc(db, "groupCalls", callId), payload).catch(() => {
        // Закрытие целиком могло не пройти — выходим хотя бы из participants,
        // чтобы комната осталась пустой и её смог закрыть кто-то ещё.
        updateDoc(doc(db, "groupCalls", callId), {
          participants: rest,
          updatedAt: serverTimestamp(),
        }).catch(() => {});
      });
    };
    window.addEventListener("pagehide", onUnload);
    return () => window.removeEventListener("pagehide", onUnload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, user?.uid]);

  const value = {
    groupCallState: state,
    groupCall: call,
    incomingGroupCall: incoming,
    peers,
    muted,
    cameraOn,
    cameraAvailable,
    videoUnlocked,
    minimized,
    setMinimized,
    groupCallError: error,
    clearGroupCallError: () => setError(""),
    startGroupCall,
    joinGroupCall,
    acceptIncoming,
    declineIncoming,
    endCallForAll,
    leaveCall,
    inviteToCall,
    toggleMute,
    toggleCamera,
    attachLocalVideo,
    inGroupCall: busy,
  };

  return <GroupCallContext.Provider value={value}>{children}</GroupCallContext.Provider>;
}

export function useGroupCall() {
  return useContext(GroupCallContext);
}
