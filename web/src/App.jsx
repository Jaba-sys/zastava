import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { FileTransferProvider } from "./contexts/FileTransferContext";
import { CallProvider } from "./contexts/CallContext";
import { GroupCallProvider } from "./contexts/GroupCallContext";
import CallOverlay from "./components/CallOverlay";
import GroupCallOverlay from "./components/GroupCallOverlay";
import { LanguageProvider, useLanguage } from "./i18n/LanguageContext";
import Register from "./pages/Register";
import Login from "./pages/Login";
import ForgotPassword from "./pages/ForgotPassword";
import ResetPassword from "./pages/ResetPassword";
import VerifyEmail from "./pages/VerifyEmail";
import TagSetup from "./pages/TagSetup";
import LanguageSetup from "./pages/LanguageSetup";
import ProfileSetup from "./pages/ProfileSetup";
import Layout from "./pages/Layout";
import ChatsList from "./pages/ChatsList";
import ChatWindow from "./pages/ChatWindow";
import FriendsSearch from "./pages/FriendsSearch";
import MyBotsView from "./pages/MyBotsView";
import ProfileView from "./pages/ProfileView";
import SettingsView from "./pages/SettingsView";
import ShopView from "./pages/ShopView";
import AdminPanel from "./pages/AdminPanel";
import CreateGroup from "./pages/CreateGroup";
import InviteJoin from "./pages/InviteJoin";
import Authorize from "./pages/Authorize";
import ShortLink from "./pages/ShortLink";
import LoadingLogo from "./components/LoadingLogo";
import "./app.css";

function Gate({ children }) {
  const { user, profile, loading, deviceTrust, retryDeviceApproval } = useAuth();
  const { t } = useLanguage();

  if (loading) return <div className="center-screen"><LoadingLogo label={t("common.loading")} /></div>;
  if (!user) return <Navigate to="/login" replace />;
  // Профиля нет — значит почта ещё не подтверждена и аккаунта в базе пока не
  // существует (см. Register.jsx, VerifyEmail.jsx, utils/pendingAccounts.js).
  // Держим человека на экране подтверждения, а не на вечной "загрузке профиля".
  if (!profile) return <Navigate to="/verify" replace />;
  if (!profile.verified) return <Navigate to="/verify" replace />;
  if (!profile.tag) return <Navigate to="/setup-tag" replace />;
  if (!profile.language) return <Navigate to="/setup-language" replace />;
  if (!profile.profileComplete) return <Navigate to="/setup-profile" replace />;

  // Вход с непривычного устройства — ждём подтверждения "это вы?" с уже
  // доверенного устройства (см. contexts/AuthContext.jsx, utils/
  // deviceTrust.js). Показываем поверх всего остального экрана, пока не
  // разрешат или не заблокируют.
  if (deviceTrust === "blocked") {
    return (
      <div className="center-screen">
        <h2>{t("deviceTrust.blockedTitle")}</h2>
        <p>{t("deviceTrust.blockedText")}</p>
        <button type="button" onClick={retryDeviceApproval}>
          {t("deviceTrust.retryBtn")}
        </button>
      </div>
    );
  }
  if (deviceTrust === "pending") {
    return (
      <div className="center-screen">
        <h2>{t("deviceTrust.pendingTitle")}</h2>
        <p>{t("deviceTrust.pendingText")}</p>
      </div>
    );
  }

  if (profile.banned) {
    const isPermanent = !profile.bannedUntil;
    const stillBanned = isPermanent || new Date(profile.bannedUntil) > new Date();
    if (stillBanned) {
      return (
        <div className="center-screen">
          <h2>{t("banned.title")}</h2>
          {profile.banReason && <p>{t("banned.reason", { reason: profile.banReason })}</p>}
          <p>{isPermanent ? t("banned.forever") : t("banned.until", { date: profile.bannedUntil })}</p>
        </div>
      );
    }
  }

  return children;
}

function AuthOnlyRoute({ children }) {
  const { user, loading } = useAuth();
  const { t } = useLanguage();
  if (loading) return <div className="center-screen"><LoadingLogo label={t("common.loading")} /></div>;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  return (
    <AuthProvider>
      <LanguageProvider>
      <FileTransferProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/register" element={<Register />} />
          <Route path="/login" element={<Login />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/invite/:chatId" element={<InviteJoin />} />
          <Route path="/join/:linkId" element={<InviteJoin />} />
        {/* Вход стороннего приложения под аккаунтом MyPeal — см. pages/Authorize.jsx */}
        <Route path="/authorize" element={<Authorize />} />
          <Route path="/r/:code" element={<ShortLink />} />
          <Route
            path="/verify"
            element={
              <AuthOnlyRoute>
                <VerifyEmail />
              </AuthOnlyRoute>
            }
          />
          <Route
            path="/setup-tag"
            element={
              <AuthOnlyRoute>
                <TagSetup />
              </AuthOnlyRoute>
            }
          />
          <Route
            path="/setup-language"
            element={
              <AuthOnlyRoute>
                <LanguageSetup />
              </AuthOnlyRoute>
            }
          />
          <Route
            path="/setup-profile"
            element={
              <AuthOnlyRoute>
                <ProfileSetup />
              </AuthOnlyRoute>
            }
          />

          <Route
            path="/"
            element={
              <Gate>
                <CallProvider>
                  <GroupCallProvider>
                    <CallOverlay />
                    <GroupCallOverlay />
                    <Layout />
                  </GroupCallProvider>
                </CallProvider>
              </Gate>
            }
          >
            <Route index element={<ChatsList />} />
            <Route path="friends" element={<FriendsSearch />} />
            <Route path="bots" element={<MyBotsView />} />
            <Route path="me" element={<ProfileView />} />
            <Route path="settings" element={<SettingsView />} />
            <Route path="shop" element={<ShopView />} />
            <Route path="create-group" element={<CreateGroup />} />
            <Route path="chat/:chatId" element={<ChatWindow />} />
          </Route>

          <Route
            path="/admin"
            element={
              <Gate>
                <AdminPanel />
              </Gate>
            }
          />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
      </FileTransferProvider>
      </LanguageProvider>
    </AuthProvider>
  );
}
