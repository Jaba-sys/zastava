import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { initTheme } from './utils/theme.js'

// Тема применяется до рендера. Первичная покраска уже сделана инлайновым
// скриптом в index.html (чтобы не мигало), здесь — подписка на смену
// системной темы в режиме "как в системе". См. utils/theme.js.
initTheme()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
