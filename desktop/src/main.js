// MyPeal Desktop — тонкая обёртка вокруг боевого сайта
// https://mypeal.web.app в окне Electron.
//
// Зачем это вообще нужно, если это просто открыть сайт в браузере? Разница —
// в том, что происходит, когда окно свёрнуто/закрыто крестиком:
//   - веб-приложение (см. web/src/hooks/useMessageNotifications.js) уже сама
//     умеет показывать системные уведомления о новых сообщениях через
//     стандартный Notification API браузера — но только пока вкладка жива;
//   - обычную вкладку браузера человек рано или поздно закрывает или браузер
//     выгружает фоновые вкладки, и уведомления перестают приходить;
//   - это окно вместо закрытия при клике на крестик прячется в системный
//     трей и продолжает жить в фоне, поэтому те же самые уведомления
//     (тот же код, тот же Notification API — мы ничего не дублируем и не
//     переписываем) продолжают приходить, как в десктопном Telegram.
//
// Это НЕ замена email-уведомлений (см. web/src/utils/emailNotify.js) — то
// решение работает, даже когда получатель вообще не за компьютером. Это —
// дополнительный, куда более надёжный канал для тех случаев, когда человек
// просто не держит вкладку с сайтом открытой.
const { app, BrowserWindow, Tray, Menu, shell, nativeImage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const APP_URL = "https://mypeal.web.app";
const ICON_PATH = path.join(__dirname, "tray-icon.png");
const APP_ICON_PATH = path.join(__dirname, "..", "build", "icon.png");
const SETTINGS_PATH = path.join(app.getPath("userData"), "desktop-settings.json");

let mainWindow = null;
let tray = null;
let isQuitting = false;

// Простой персист на диске — только для одного флага: применили ли мы уже
// однажды поведение "автозапуск включён по умолчанию". Без этого при каждом
// запуске мы бы молча заново включали автозапуск, даже если человек сам его
// выключил через трей.
function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    return {};
  }
}
function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next), "utf8");
  } catch {
    // некритично — просто на следующий запуск повторится тот же дефолт
  }
  return next;
}

function applyDefaultAutoLaunchOnce() {
  const settings = readSettings();
  if (settings.autoLaunchDefaultApplied) return;
  app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
  writeSettings({ autoLaunchDefaultApplied: true });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    title: "MyPeal",
    icon: APP_ICON_PATH,
    backgroundColor: "#0e1621",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadURL(APP_URL);

  // Клик по крестику сворачивает в трей вместо выхода — иначе весь смысл
  // фонового окна (см. комментарий в шапке файла) теряется.
  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });

  // Ссылки, которые пытаются открыться в новом окне (window.open / target=_blank),
  // отправляем в обычный браузер — у Electron-окна нет адресной строки и это
  // было бы небезопасно/неудобно открывать прямо внутри приложения.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Переход по обычной ссылке на чужой домен (не сам сайт MyPeal) —
  // тоже наружу, в браузер, а не поверх этого окна.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(APP_URL)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
}

function buildTrayMenu() {
  const autoLaunchEnabled = app.getLoginItemSettings().openAtLogin;
  return Menu.buildFromTemplate([
    {
      label: "Открыть MyPeal",
      click: () => {
        mainWindow.show();
        mainWindow.focus();
      },
    },
    { type: "separator" },
    {
      label: "Запускать при включении компьютера",
      type: "checkbox",
      checked: autoLaunchEnabled,
      click: (menuItem) => {
        app.setLoginItemSettings({ openAtLogin: menuItem.checked, openAsHidden: true });
        writeSettings({ autoLaunchDefaultApplied: true });
      },
    },
    { type: "separator" },
    {
      label: "Выход",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function createTray() {
  const image = nativeImage.createFromPath(ICON_PATH);
  tray = new Tray(image.resize({ width: 32, height: 32 }));
  tray.setToolTip("MyPeal");
  tray.setContextMenu(buildTrayMenu());
  // На Windows/Linux один клик по значку — открыть/показать окно (на macOS
  // клик по трею традиционно просто раскрывает меню, отдельная обработка не нужна).
  tray.on("click", () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible() && mainWindow.isFocused()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    applyDefaultAutoLaunchOnce();
    createWindow();
    createTray();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  });

  app.on("before-quit", () => {
    isQuitting = true;
  });

  // Не выходим при закрытии всех окон — приложение продолжает жить в трее
  // (обычное поведение мессенджеров на Windows/Linux; на macOS это и так
  // стандартное поведение, но пропишем явно для единообразия).
  app.on("window-all-closed", (event) => {
    event.preventDefault();
  });
}
