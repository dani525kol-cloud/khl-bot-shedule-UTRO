// ВАЖНО: говорим Vercel не парсить тело — прочитаем сами
module.exports.config = { api: { bodyParser: false } };

/* ================== НАСТРОЙКИ ================== */
const TELEGRAM_TOKEN = "7744092789:AAFrGBNAC5uZt5mWz0n7MX7veG22EqBXApg";
const SHEET_ID       = "1FQdRuNu64Q-1Da3shqSHrB-DnWEzgIDyY5uKMjFQxZU";
const SHEET_NAME     = "Лист1";
const TZ             = "Europe/Moscow";
/* =============================================== */

const TG_API    = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(SHEET_NAME)}`;

/* ----------------- Утилиты ----------------- */
function todayStr() {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit", month: "2-digit", year: "numeric", timeZone: TZ
  }).format(new Date()).replace(/\//g, ".");
}

function csvParse(text) {
  return text.trim().split(/\r?\n/).map(r => r.split(",").map(c => c.trim()));
}

async function fetchSheetRows() {
  const r = await fetch(SHEET_URL);
  const text = await r.text();

  // Если таблица приватна, часто прилетает HTML-страница входа
  const looksHtml = /^\s*</.test(text) || text.includes("<!DOCTYPE html");
  if (!r.ok || looksHtml) {
    console.error("Sheets fetch error:", {
      status: r.status,
      looksHtml,
      head: text.slice(0, 200)
    });
    throw new Error("SHEETS_ACCESS");
  }
  return csvParse(text);
}

function findRowByDate(rows, ds) {
  // предполагаем: строка 1 — шапка даты ("Дата"), строка 2 — роли, со строки 3 — данные
  for (const row of rows.slice(2)) {
    if ((row[0] || "").trim() === ds) return row;
  }
  return null;
}

function makeByRole(rows, row) {
  const header = rows[1]; // строка с названиями ролей
  const byRole = {};
  for (let i = 1; i < header.length; i++) {
    const role = header[i] || `Колонка ${i + 1}`;
    const val  = (row[i] || "").trim();
    if (!val || val === "-") continue; // "-" пропускаем, "х" оставляем как есть
    (byRole[role] ||= []).push(val);
  }
  return byRole;
}

function formatByRole(byRole) {
  const lines = [];
  for (const [role, arr] of Object.entries(byRole)) {
    const uniq = [...new Set(arr.map(s => s.replace(/\s+/g, " ").trim()))].filter(Boolean);
    if (uniq.length) lines.push(`${role}: ${uniq.join(", ")}`);
  }
  return lines.join("\n");
}

async function sendMessage(chatId, text, replyMarkup){
  const payload = {
    chat_id: chatId,
    text: text || " ",
    parse_mode: "HTML",
    disable_web_page_preview: true
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;

  const url = `${TG_API}/sendMessage`;
  const body = JSON.stringify(payload);
  const headers = { "Content-Type": "application/json" };

  let lastErr;
  for (const delay of [0, 400, 1200]) { // 3 попытки: сразу, через 0.4с и 1.2с
    if (delay) await new Promise(r => setTimeout(r, delay));
    try {
      const resp = await fetch(url, { method:"POST", headers, body });
      const txt = await resp.text();
      if (!resp.ok) {
        console.error("TG sendMessage error:", resp.status, txt.slice(0,180));
        lastErr = new Error(`TG ${resp.status}`);
        continue;
      }
      console.log("TG sendMessage ok:", txt.slice(0,160));
      return;
    } catch (e) {
      console.error("TG sendMessage fetch fail:", e?.message || e);
      lastErr = e;
      continue;
    }
  }
  // окончательно не удалось — просто залогируем
  console.error("TG sendMessage failed after retries:", lastErr?.message || lastErr);
}

async function answerCallbackQuery(id) {
  try {
    await fetch(`${TG_API}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: id })
    });
  } catch (e) {
    console.error("answerCallbackQuery error", e);
  }
}

function menu() {
  return {
    inline_keyboard: [
      [
        { text: "Сегодня", callback_data: "today" },
        { text: "3 дня",  callback_data: "3days" }
      ]
    ]
  };
}

/* ------------- Бизнес-логика ответов ------------- */
async function answerToday(chatId) {
  try {
    const rows = await fetchSheetRows();
    const ds   = todayStr();
    const row  = findRowByDate(rows, ds);

    if (!row) {
      return sendMessage(chatId, `Нет записей на ${ds}`, menu());
    }

    const text = `📅 Сегодня (${ds}) по графику:\n` + formatByRole(makeByRole(rows, row));
    return sendMessage(chatId, text, menu());

  } catch (e) {
    if (String(e.message) === "SHEETS_ACCESS") {
      return sendMessage(
        chatId,
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
      const d  = new Date(); d.setDate(d.getDate() + i);
      const ds = new Intl.DateTimeFormat("ru-RU", {
        day: "2-digit", month: "2-digit", year: "numeric", timeZone: TZ
      }).format(d).replace(/\//g, ".");

      const row = findRowByDate(rows, ds);
      if (row) {
        parts.push(`📅 ${ds} по графику:\n${formatByRole(makeByRole(rows, row))}`);
      } else {
        parts.push(`📅 ${ds} по графику:\n—`);
      }
    }

    return sendMessage(chatId, parts.join("\n\n"), menu());

  } catch (e) {
    if (String(e.message) === "SHEETS_ACCESS") {
      return sendMessage(
        chatId,
        "Не могу прочитать таблицу. Дай доступ: «Любой, у кого есть ссылка — Просмотр».",
        menu()
      );
    }
    console.error("answer3Days error:", e);
  }
}

/* ------------- Чтение тела запроса ------------- */
async function readRawBody(req) {
  if (req.body) return req.body; // вдруг Vercel уже распарсил
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  const raw = Buffer.concat(chunks).toString();
  try { return JSON.parse(raw); } catch { return {}; }
}

/* ----------------- Handler ----------------- */
// ВАЖНО: сначала читаем тело, только потом отвечаем 200.
module.exports = async (req, res) => {
  let body = {};
  try {
    body = await readRawBody(req);
  } catch (e) {
    console.error("read body error", e);
  }

  // Быстрый ответ Телеге, чтобы она не делала ретраи
  res.status(200).send("ok");

  try {
    // Нажатие на inline-кнопки
    if (body.callback_query) {
      const cq = body.callback_query;
      console.log("update_type=callback_query", cq.data);
      answerCallbackQuery(cq.id).catch(()=>{});
      const chatId = cq?.message?.chat?.id;
      if (!chatId) return;
      if (cq.data === "today") return answerToday(chatId);
      if (cq.data === "3days") return answer3Days(chatId);
      return;
    }

    // Обычные сообщения
    const msg = body.message;
    if (!msg) return;
    const chatId = msg.chat.id;
    const text   = (msg.text || "").trim();
    console.log("update_type=message", text);

    if (/^\/start/i.test(text))                         return sendMessage(chatId, "Выбери:", menu());
    if (/^(\/график|график|сегодня|\/today)$/i.test(text)) return answerToday(chatId);
    if (/^(3\s*дня|три\s*дня|\/three)$/i.test(text))       return answer3Days(chatId);

  } catch (e) {
    console.error("Webhook error:", e);
  }
};
