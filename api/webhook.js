// Отключаем bodyParser — сами читаем сырое тело
module.exports.config = { api: { bodyParser: false } };

/* =============== НАСТРОЙКИ =============== */
const TELEGRAM_TOKEN = "7744092789:AAFrGBNAC5uZt5mWz0n7MX7veG22EqBXApg";
const SHEET_ID       = "1FQdRuNu64Q-1Da3shqSHrB-DnWEzgIDyY5uKMjFQxZU";
const SHEET_NAME     = "Лист1";
const TZ             = "Europe/Moscow";
/* ========================================= */

const TG_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const SHEET_URL =
  `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(SHEET_NAME)}`;

/* ---------- Роли/рендер ---------- */
// Варианты заголовков из таблицы (в любом регистре/с пробелами)
const ROLE_ALIASES = {
  "оператор":    "operator",
  "операторы":   "operator",

  "ведущий":     "host",
  "ведущие":     "host",

  "монтаж":      "editor_video",
  "монтажёр":    "editor_video",
  "монтажеры":   "editor_video",

  "сценарий":    "writer",
  "сценаристы":  "writer",

  "редактор":    "editor_text",
  "редакторы":   "editor_text",
};

// порядок вывода и подписи с эмодзи
const RENDER_ORDER = ["operator", "host", "editor_video", "writer", "editor_text"];
const ROLE_LABEL = {
  operator:     "🎥 Оператор",
  host:         "🎙 Ведущий",
  editor_video: "✂️ Монтажёр",
  writer:       "📝 Сценарий",
  editor_text:  "💻 Редактор",
};

function menu() {
  return {
    inline_keyboard: [[
      { text: "Сегодня", callback_data: "today" },
      { text: "3 дня",  callback_data: "3days" }
    ]]
  };
}

/* ---------- Утилиты ---------- */
function todayStr() {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit", month: "2-digit", year: "numeric", timeZone: TZ
  }).format(new Date()).replace(/\//g, ".");
}

function csvParse(text) {
  // простой CSV: разделитель — запятая; кавычки Google тоже понимаем
  return text
    .trim()
    .split(/\r?\n/)
    .map(line => {
      // грубая, но рабочая разбивка: учитываем простые "..."
      const out = [];
      let cur = "", inQ = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"' ) {
          if (inQ && line[i+1] === '"') { cur += '"'; i++; }
          else inQ = !inQ;
        } else if (ch === ',' && !inQ) {
          out.push(cur.trim());
          cur = "";
        } else {
          cur += ch;
        }
      }
      out.push(cur.trim());
      return out;
    });
}

// Нормализация дат к dd.MM.yyyy
function normDate(s) {
  if (s == null) return null;
  let t = String(s).trim();
  t = t.replace(/^["']|["']$/g, "").replace(/\s*г\.?$/i, "").replace(/\//g, ".");
  const m = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/);
  if (!m) return null;
  let [, dd, mm, yy] = m;
  dd = dd.padStart(2, "0");
  mm = mm.padStart(2, "0");
  if (yy.length === 2) yy = "20" + yy;
  return `${dd}.${mm}.${yy}`;
}

// Жёсткая нормализация заголовка: убираем неразрывные пробелы/скрытые символы
function normHeader(s) {
  if (s == null) return "";
  return String(s)
    .replace(/[\u00A0\u2000-\u200B\u202F\uFEFF]/g, " ") // экзотические пробелы
    .replace(/[^\p{L}\p{N}\s._-]/gu, "")               // мусор
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

// Нормализованная карта алиасов
const ROLE_ALIASES_NORM = Object.fromEntries(
  Object.entries(ROLE_ALIASES).map(([k, v]) => [normHeader(k), v])
);

async function fetchSheetRows() {
  const r = await fetch(SHEET_URL);
  const text = await r.text();
  const looksHtml = /^\s*</.test(text) || text.includes("<!DOCTYPE html");
  if (!r.ok || looksHtml) {
    console.error("Sheets fetch error:", { status: r.status, looksHtml, head: text.slice(0, 200) });
    throw new Error("SHEETS_ACCESS");
  }
  return csvParse(text);
}

function findRowByDate(rows, targetDS) {
  const target = normDate(targetDS);
  if (!target) return null;
  for (const row of rows.slice(2)) { // данные начиная со строки 3
    const ds = normDate(row[0]);
    if (ds && ds === target) return row;
  }
  return null;
}

function makeByRoleFixed(rows, row) {
  const header = rows[1];
  const out = {};
  for (let i = 1; i < header.length; i++) {
    const keyNorm = normHeader(header[i] || "");
    const roleKey = ROLE_ALIASES_NORM[keyNorm];
    if (!roleKey) continue;

    const val = (row[i] == null ? "" : String(row[i]).trim());
    if (!val || val === "-") continue;     // "-" скрываем; "х" показываем как есть
    (out[roleKey] ||= []).push(val);
  }
  return out;
}

function formatFixed(byRole) {
  const lines = [];
  for (const key of RENDER_ORDER) {
    const label = ROLE_LABEL[key] || key;
    const arr = byRole[key] || [];
    const uniq = [...new Set(arr.map(s => s.replace(/\s+/g, " ").trim()))].filter(Boolean);
    lines.push(`${label}: ${uniq.length ? uniq.join(", ") : "—"}`);
  }
  return lines.join("\n");
}

/* ---------- Telegram ---------- */
async function sendMessage(chatId, text, replyMarkup) {
  const url = `${TG_API}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: text || " ",
    parse_mode: "HTML",
    disable_web_page_preview: true
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;

  const headers = { "Content-Type": "application/json" };
  const body = JSON.stringify(payload);

  let lastErr;
  for (const delay of [0, 400, 1200]) {
    if (delay) await new Promise(r => setTimeout(r, delay));
    try {
      const resp = await fetch(url, { method: "POST", headers, body });
      const txt = await resp.text();
      if (!resp.ok) {
        console.error("TG sendMessage error:", resp.status, txt.slice(0, 180));
        lastErr = new Error(`TG ${resp.status}`);
        continue;
      }
      console.log("TG sendMessage ok:", txt.slice(0, 160));
      return;
    } catch (e) {
      console.error("TG sendMessage fetch fail:", e?.message || e);
      lastErr = e;
    }
  }
  console.error("TG sendMessage failed after retries:", lastErr?.message || lastErr);
}

/* ---------- Чтение сырого тела ---------- */
async function readRawBody(req) {
  if (req.method === "GET") return { ping: true };
  if (req.body) return req.body;
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  const raw = Buffer.concat(chunks).toString();
  try { return JSON.parse(raw); } catch { return {}; }
}

/* ---------- Ответы ---------- */
async function answerToday(chatId) {
  try {
    const rows = await fetchSheetRows();
    const ds   = todayStr();
    const row  = findRowByDate(rows, ds);

    if (!row) {
      return sendMessage(chatId, `Нет записей на ${ds}`, menu());
    }
    const txt = `📅 Сегодня (${ds}) по графику:\n` + formatFixed(makeByRoleFixed(rows, row));
    return sendMessage(chatId, txt, menu());
  } catch (e) {
    if (String(e.message) === "SHEETS_ACCESS") {
      return sendMessage(chatId,
        "Не могу прочитать таблицу. Дай доступ: «Любой, у кого есть ссылка — Просмотр».",
        menu()
      );
    }
    console.error("answerToday error:", e);
  }
}

async function answer3Days(chatId) {
  try {
    const rows = await fetchSheetRows();
    const parts = [];
    for (let i = 0; i < 3; i++) {
      const d = new Date(); d.setDate(d.getDate() + i);
      const ds = new Intl.DateTimeFormat("ru-RU", {
        day: "2-digit", month: "2-digit", year: "numeric", timeZone: TZ
      }).format(d).replace(/\//g, ".");

      const row = findRowByDate(rows, ds);
      parts.push(
        row
          ? `📅 ${ds} по графику:\n${formatFixed(makeByRoleFixed(rows, row))}`
          : `📅 ${ds} по графику:\n—`
      );
    }
    return sendMessage(chatId, parts.join("\n\n"), menu());
  } catch (e) {
    if (String(e.message) === "SHEETS_ACCESS") {
      return sendMessage(chatId,
        "Не могу прочитать таблицу. Дай доступ: «Любой, у кого есть ссылка — Просмотр».",
        menu()
      );
    }
    console.error("answer3Days error:", e);
  }
}

/* ---------- Handler (важно: сначала работа, потом res.send) ---------- */
module.exports = async (req, res) => {
  let body = {};
  try {
    body = await readRawBody(req);
  } catch (e) {
    console.error("read body error", e);
  }

  try {
    if (body.callback_query) {
      const cq = body.callback_query;
      console.log("update_type=callback_query", cq.data);
      const chatId = cq?.message?.chat?.id;
      if (chatId) {
        if (cq.data === "today")  await answerToday(chatId);
        if (cq.data === "3days")  await answer3Days(chatId);
      }
    } else if (body.message) {
      const msg = body.message;
      const chatId = msg.chat.id;
      const text = (msg.text || "").trim();
      console.log("update_type=message", text);

      if (/^\/start/i.test(text))                               await sendMessage(chatId, "Выбери:", menu());
      else if (/^(\/график|график|сегодня|\/today)$/i.test(text)) await answerToday(chatId);
      else if (/^(3\s*дня|три\s*дня|\/three)$/i.test(text))       await answer3Days(chatId);
    }
  } catch (e) {
    console.error("Webhook error:", e);
  }

  // Ответ только ПОСЛЕ всей работы, иначе Vercel может “усыпить” процесс
  res.status(200).send("ok");
};
  // Ответ только ПОСЛЕ всей работы, иначе Vercel может “усыпить” процесс
  res.status(200).send("ok");
};
