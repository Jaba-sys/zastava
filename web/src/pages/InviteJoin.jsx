import { useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { arrayUnion, doc, getDoc, updateDoc } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../contexts/AuthContext";
import VerifiedBadge from "../components/VerifiedBadge";
import LoadingLogo from "../components/LoadingLogo";
import { getInviteLink, linkProblem, writeJoinPass } from "../utils/groupLinks";
import { useLanguage } from "../i18n/LanguageContext";

const PENDING_KEY = "pendingInvitePath";
// Ключ прошлой версии — там хранился только id группы. Читаем его, чтобы у
// тех, кто открыл старую ссылку до входа, переход не потерялся.
const LEGACY_PENDING_KEY = "pendingInviteChatId";

// Экран вступления в группу. Два адреса:
//   /join/:linkId    — нынешние ссылки-приглашения (срок, адресат, отзыв);
//   /invite/:chatId  — прежние вечные ссылки, теперь нерабочие.
//
// Специально НЕ обёрнут в Gate — если человек ещё не вошёл или не закончил
// регистрацию, запоминаем адрес в localStorage и проводим его по обычной
// цепочке входа; ChatsList.jsx на финише сам вернёт сюда.
export default function InviteJoin() {
  const { chatId: legacyChatId, linkId } = useParams();
  const { user, profile, loading } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();
  const location = useLocation();
  const [chat, setChat] = useState(null);
  const [error, setError] = useState("");
  const [joining, setJoining] = useState(false);
  const [fetching, setFetching] = useState(true);

  const onboarded = !!(user && profile?.verified && profile?.tag && profile?.profileComplete);

  useEffect(() => {
    if (loading) return;
    const remember = () => {
      try {
        localStorage.setItem(PENDING_KEY, location.pathname);
      } catch {
        // localStorage недоступен — просто откроют ссылку ещё раз после входа
      }
    };
    if (!user) {
      remember();
      navigate("/login", { replace: true });
      return;
    }
    // Профиля нет вообще — значит почта не подтверждена и аккаунта в базе
    // ещё не существует (см. pages/VerifyEmail.jsx, utils/pendingAccounts.js).
    if (!profile) {
      remember();
      navigate("/verify", { replace: true });
      return;
    }
    if (!profile.verified || !profile.tag || !profile.profileComplete) {
      remember();
      const next = !profile.verified ? "/verify" : !profile.tag ? "/setup-tag" : "/setup-profile";
      navigate(next, { replace: true });
      return;
    }
    try {
      localStorage.removeItem(PENDING_KEY);
      localStorage.removeItem(LEGACY_PENDING_KEY);
    } catch {
      // ignore
    }
  }, [loading, user, profile, location.pathname, navigate]);

  useEffect(() => {
    if (!onboarded) return;
    let cancelled = false;
    (async () => {
      setFetching(true);
      setError("");
      setChat(null);
      try {
        // Старый адрес: вступить по нему больше нельзя — правила требуют
        // пропуск, а его выдаёт только живая ссылка. Объясняем прямо, чтобы
        // человек не думал, что сломалось приложение.
        if (legacyChatId) {
          if (!cancelled) setError(t("inviteJoin.legacyLink"));
          return;
        }
        const link = await getInviteLink(linkId);
        if (cancelled) return;
        const problem = linkProblem(link, user.uid);
        if (problem) {
          setError(t(`inviteJoin.link_${problem}`));
          return;
        }
        const snap = await getDoc(doc(db, "chats", link.chatId));
        if (cancelled) return;
        if (!snap.exists() || !snap.data().isGroup) {
          setError(t("inviteJoin.invalidLink"));
          return;
        }
        setChat({ id: snap.id, ...snap.data(), linkId });
      } catch (err) {
        if (!cancelled) setError(t("inviteJoin.loadError", { message: err.message }));
      } finally {
        if (!cancelled) setFetching(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [linkId, legacyChatId, onboarded, user, t]);

  async function join() {
    if (!chat) return;
    setJoining(true);
    setError("");
    try {
      if (!chat.members?.includes(user.uid)) {
        // Сначала пропуск — его правило и проверяет саму ссылку, — и только
        // потом добавление себя в участники. Обратный порядок не сработает:
        // вступление требует, чтобы пропуск уже лежал в базе.
        await writeJoinPass(chat.id, user.uid, "link", chat.linkId);
        await updateDoc(doc(db, "chats", chat.id), { members: arrayUnion(user.uid) });
      }
      navigate(`/chat/${chat.id}`, { replace: true });
    } catch (err) {
      setError(t("inviteJoin.joinError", { message: err.message }));
    } finally {
      setJoining(false);
    }
  }

  if (!onboarded) {
    return (
      <div className="center-screen">
        <LoadingLogo label={t("inviteJoin.loading")} />
      </div>
    );
  }

  return (
    <div className="center-screen">
      <div className="panel" style={{ maxWidth: 420 }}>
        <h2>{t("inviteJoin.title")}</h2>
        {fetching && <LoadingLogo size="small" label={t("inviteJoin.loading")} />}
        {error && <div className="error">{error}</div>}
        {error && (
          <button type="button" className="secondary" onClick={() => navigate("/")}>
            {t("inviteJoin.backToChats")}
          </button>
        )}
        {chat && (
          <>
            <p>
              <b>
                {chat.name}
                <VerifiedBadge show={chat.verifiedBadge} />
              </b>
            </p>
            <p className="muted">
              {t("inviteJoin.membersCount", { count: chat.members?.length || 0 })}
            </p>
            {chat.members?.includes(user.uid) ? (
              <button type="button" onClick={() => navigate(`/chat/${chat.id}`)}>
                {t("inviteJoin.openChat")}
              </button>
            ) : (
              <button type="button" onClick={join} disabled={joining}>
                {joining ? t("inviteJoin.joining") : t("inviteJoin.join")}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
