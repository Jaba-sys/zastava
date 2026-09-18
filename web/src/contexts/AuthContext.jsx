import { createContext, useContext, useEffect, useState } from "react";
import { onAuthStateChanged, signOut as fbSignOut } from "firebase/auth";
import { doc, onSnapshot, serverTimestamp, updateDoc } from "firebase/firestore";
import { auth, db } from "../firebase";
import { HEARTBEAT_INTERVAL_MS } from "../utils/presence";
import { ensureSystemChat } from "../utils/systemChat";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null); // firebase auth user
  const [profile, setProfile] = useState(null); // firestore users/{uid} doc
  const [loading, setLoading] = useState(true);
  // Стабильный признак "профиль уже есть" — именно он идёт в зависимости
  // эффектов, которые сами пишут в базу (см. ниже).
  const hasProfile = !!profile;

  useEffect(() => {
    const unsubAuth = onAuthStateChanged(auth, (u) => {
      setUser(u);
      if (!u) {
        setProfile(null);
        setLoading(false);
      }
    });
    return unsubAuth;
  }, []);

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    const unsub = onSnapshot(doc(db, "users", user.uid), (snap) => {
      setProfile(snap.exists() ? { id: snap.id, ...snap.data() } : null);
      setLoading(false);
    });
    return unsub;
  }, [user]);

  // Предустановленный чат "Системные сообщения" — как в Telegram, есть у
  // каждого с самого начала, туда приходят уведомления сайта. Досоздаём при
  // каждом входе на случай, если аккаунт был создан ещё до этой функции.
  // profile здесь обязателен: пока почта не подтверждена, документа
  // users/{uid} вообще нет (см. pages/VerifyEmail.jsx,
  // utils/pendingAccounts.js) — такому "полуаккаунту" ни системный чат, ни
  // heartbeat не нужны, а запись всё равно не прошла бы по правилам.
  // ВАЖНО про зависимости: здесь и в heartbeat ниже нельзя писать [user,
  // profile]. profile — НОВЫЙ объект при каждом снапшоте users/{uid}, а сам
  // эффект в базу и пишет: запись меняет документ → приходит снапшот →
  // эффект перезапускается → снова запись. Получается бесконечный цикл
  // записей на полной скорости сети: Firestore захлёбывается (сервер начинает
  // отвечать 503), из-за чего тормозит ВСЁ приложение — и доставка сообщений,
  // и сигнализация звонков, — а дневная квота бесплатного плана сгорает за
  // час. Поэтому зависимость — стабильное булево hasProfile.
  useEffect(() => {
    if (!user || !hasProfile) return;
    ensureSystemChat(user.uid);
  }, [user, hasProfile]);

  // "Онлайн"-статус на чистом Firestore: пока пользователь авторизован и
  // вкладка открыта, периодически отмечаем lastActive. См. utils/presence.js.
  useEffect(() => {
    if (!user || !hasProfile) return;
    const beat = () =>
      updateDoc(doc(db, "users", user.uid), { lastActive: serverTimestamp() }).catch(() => {});
    beat();
    const interval = setInterval(beat, HEARTBEAT_INTERVAL_MS);
    const onVisible = () => document.visibilityState === "visible" && beat();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // Зависимость — hasProfile, а не profile: см. комментарий выше про цикл
    // "запись → снапшот → запись".
  }, [user, hasProfile]);

  // Смена email (см. SettingsView.jsx -> verifyBeforeUpdateEmail): сам email
  // в Firebase Auth меняется только когда пользователь переходит по ссылке
  // подтверждения, присланной на НОВЫЙ адрес — это может случиться в любой
  // момент, даже пока это самое приложение открыто в другой вкладке. Firestore
  // хранит email отдельным (денормализованным) полем users/{uid}.email,
  // поэтому здесь досинхронизируем его, как только замечаем расхождение
  // между тем, что реально подтвердил Auth (user.email), и тем, что ещё
  // лежит в профиле. Тот же приём, что и подтверждение почты в VerifyEmail.jsx:
  // сначала принудительно обновляем сам ID-токен (getIdToken(true)) — иначе
  // request.auth.token.email в firestore.rules ещё смотрит на старый email,
  // и запись падает с permission-denied.
  useEffect(() => {
    if (!user || !profile) return;
    if (!user.email || user.email === profile.email) return;
    let cancelled = false;
    (async () => {
      try {
        await user.getIdToken(true);
        if (cancelled) return;
        await updateDoc(doc(db, "users", user.uid), { email: user.email });
      } catch {
        /* токен/правила ещё не готовы — попробуем на следующем снапшоте профиля */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, profile]);

  const signOut = () => fbSignOut(auth);

  return (
    <AuthContext.Provider value={{ user, profile, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
