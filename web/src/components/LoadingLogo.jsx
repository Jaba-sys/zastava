// Мультяшный "прыгающий" логотип-загрузчик — используется вместо простого
// текста "Загрузка..." везде на экранах ожидания (см. App.jsx -> Gate/
// AuthOnlyRoute, InviteJoin.jsx, MyBotsView.jsx). Буквы "MyPeal"
// подпрыгивают по очереди волной — сама анимация и цвета букв заданы в
// app.css (.loading-logo*), задержки через nth-child, как и остальные
// волновые анимации в проекте (см. .kazik-reels.spinning).
const LETTERS = "MyPeal".split("");

export default function LoadingLogo({ label, size = "large" }) {
  return (
    <div className={`loading-logo loading-logo-${size}`}>
      <div className="loading-logo-letters" aria-label="MyPeal" role="img">
        {LETTERS.map((ch, i) => (
          <span key={i}>{ch}</span>
        ))}
      </div>
      {label && <div className="loading-logo-label">{label}</div>}
    </div>
  );
}
