// hud.js — всё, что нарисовано поверх трёхмерной картинки: здоровье, патроны,
// лента убийств, табло и чат. Это обычный HTML поверх холста, а не текстуры в
// сцене: так текст всегда чёткий, читается на любом экране и переводится без
// перерисовки шрифтов.

import { modeName } from "./modes.js";
import { WEAPONS } from "./weapons.js";

const $ = id => document.getElementById(id);

export class Hud {
  constructor(){
    this.feed = $("feed");
    this.chatLog = $("chatLog");
    this.chatInput = $("chatInput");
    this.chatBox = $("chat");
    this.board = $("board");
    this.boardRows = $("boardRows");
    this.hint = $("hint");
    this.chatOpen = false;
    this.onSend = null;

    this.chatInput.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Enter"){
        const text = this.chatInput.value.trim();
        this.chatInput.value = "";
        this.closeChat();
        if (text) this.onSend?.(text);
      }
      if (e.key === "Escape"){ this.chatInput.value = ""; this.closeChat(); }
    });
  }

  health(hp){
    const value = Math.max(0, Math.round(hp));
    $("hpValue").textContent = value;
    $("hpBar").style.width = value + "%";
    $("hpBar").classList.toggle("low", value <= 30);
  }

  /**
   * Инвентарь: полоса слотов, как в тех играх, откуда этот режим и пришёл.
   *
   * Смысл полосы не в красоте, а в одном вопросе, который возникает в бою
   * постоянно: ЧТО У МЕНЯ ЕСТЬ. До неё ответ приходилось собирать по углам
   * экрана — ствол в одном месте, гранаты в другом, а бомба не показывалась
   * нигде вовсе: человек узнавал, что она у него, только по строчке «иди на
   * точку». Теперь всё в одном ряду и под одними номерами, которыми это и
   * переключается.
   *
   * Слот пятый — бомба — появляется только у того, кому она выпала, и это
   * единственный слот, который может исчезнуть посреди раунда: заложил — и
   * его нет.
   */
  slots({ arsenal, nades, nextNade, carries, owns }){
    const box = $("slots");
    if (!box) return;

    const cells = [];
    arsenal.order.forEach((id, i) => {
      const weapon = WEAPONS[id] || arsenal.current;
      const active = arsenal.current.id === id;
      cells.push(`<span class="slot${active ? " on" : ""}">
        <i>${i + 1}</i><b>${escape(weapon.short || weapon.name)}</b></span>`);
    });

    if (owns){
      const left = (nades.frag || 0) + (nades.smoke || 0);
      const which = nextNade === "smoke" ? "Дым" : "Оск.";
      cells.push(`<span class="slot${left ? "" : " empty"}">
        <i>3</i><b>${which}</b><u>${nades[nextNade] || 0}</u></span>`);
    }

    if (carries){
      cells.push(`<span class="slot bomb"><i>5</i><b>Бомба</b></span>`);
    }

    box.classList.toggle("show", cells.length > 0);
    document.body.classList.toggle("slots", cells.length > 0);
    box.innerHTML = cells.join("");
  }

  /** Строка про бомбу: где она и сколько осталось. Пусто — значит режим не тот. */
  bomb(text, hot){
    const box = $("bombLine");
    if (!box) return;
    box.classList.toggle("show", !!text);
    box.classList.toggle("hot", !!hot);
    box.textContent = text || "";
  }

  ammo(arsenal){
    $("weaponName").textContent = arsenal.current.name;
    $("ammoValue").textContent = arsenal.reloading ? "···" : arsenal.inMagazine;
    $("ammoMax").textContent = arsenal.current.magazine;
  }

  score(mine, goal, mode){
    $("scoreMine").textContent = mine;
    $("scoreGoal").textContent = goal;
    // В заминировании на табло не убийства, а выигранные раунды — и подпись
    // обязана говорить именно это, иначе «4 / 8» читается как счёт по трупам.
    $("scoreLabel").textContent =
      mode === "bomb" ? "раундов" : mode === "team" ? "счёт команды" : "убийств";
  }

  timer(secondsLeft){
    const s = Math.max(0, Math.floor(secondsLeft));
    $("clock").textContent = `${String(Math.floor(s / 60))}:${String(s % 60).padStart(2, "0")}`;
  }

  /** Лента убийств: строчки живут шесть секунд и уходят сами. */
  kill(killerName, victimName, isMe){
    const line = document.createElement("div");
    line.className = "feed-line" + (isMe ? " mine" : "");
    line.innerHTML = `<b>${escape(killerName)}</b> <i>—</i> <span>${escape(victimName)}</span>`;
    this.feed.append(line);
    setTimeout(() => line.remove(), 6000);
  }

  /** Крупная надпись посреди экрана: "вас убил такой-то", "матч окончен". */
  banner(title, sub = "", ms = 2600){
    const el = $("banner");
    el.querySelector("b").textContent = title;
    el.querySelector("span").textContent = sub;
    el.classList.add("show");
    clearTimeout(this._bannerTimer);
    if (ms) this._bannerTimer = setTimeout(() => el.classList.remove("show"), ms);
  }

  hideBanner(){ $("banner").classList.remove("show"); }

  /** Отметка попадания — та самая галочка, по которой понятно, что задел. */
  hitMark(){
    const mark = $("hitmark");
    mark.classList.remove("show");
    void mark.offsetWidth;          // перезапуск анимации
    mark.classList.add("show");
  }

  damageFlash(){
    const flash = $("damage");
    flash.classList.remove("show");
    void flash.offsetWidth;
    flash.classList.add("show");
  }

  scoreboard(rows, mode){
    this.boardRows.innerHTML = "";
    const sorted = [...rows].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    for (const row of sorted){
      const line = document.createElement("div");
      line.className = "board-row" + (row.me ? " me" : "");
      line.innerHTML = `
        <span class="board-team ${row.team || "free"}"></span>
        <b>${escape(row.name)}</b>
        <i>${row.tag ? "@" + escape(row.tag) : ""}</i>
        <u>${row.kills}</u><u>${row.deaths}</u>`;
      this.boardRows.append(line);
    }
    $("boardMode").textContent = modeName(mode);
  }

  showBoard(on){ this.board.classList.toggle("show", on); }

  chat(message, mine){
    const line = document.createElement("div");
    line.className = "chat-line" + (mine ? " mine" : "");
    line.innerHTML = `<b>${escape(message.name)}</b>${escape(message.text)}`;
    this.chatLog.append(line);
    while (this.chatLog.children.length > 8) this.chatLog.firstChild.remove();
    this.chatBox.classList.add("lit");
    clearTimeout(this._chatTimer);
    // Чат сам гаснет, чтобы не загораживать карту, но при открытой строке
    // ввода остаётся видимым — иначе не видно, кому отвечаешь.
    this._chatTimer = setTimeout(() => {
      if (!this.chatOpen) this.chatBox.classList.remove("lit");
    }, 7000);
  }

  openChat(){
    this.chatOpen = true;
    this.chatBox.classList.add("lit", "typing");
    this.chatInput.focus();
  }

  closeChat(){
    this.chatOpen = false;
    this.chatBox.classList.remove("typing");
    this.chatInput.blur();
  }

  /**
   * Подсказка под прицелом.
   *
   * Их две, и путать их нельзя. Подсказка КАРТЫ («наверх ведут только три
   * прореза») висит весь матч — это часть карты. Всё остальное — «код
   * скопирован», «граната кончилась», «связь вернулась» — сказано на секунду
   * и должно уйти. Пока обе писались в одну строчку, первое же случайное
   * сообщение навсегда затирало подсказку карты, и вернуть её было нечем.
   */
  setHint(text){
    this.baseHint = text || "";
    clearTimeout(this._hintTimer);
    this.hint.textContent = this.baseHint;
  }

  say(text, ms = 4000){
    this.hint.textContent = text;
    clearTimeout(this._hintTimer);
    this._hintTimer = setTimeout(() => {
      this.hint.textContent = this.baseHint || "";
    }, ms);
  }
}

function escape(text){
  return String(text ?? "").replace(/[&<>"]/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
