module.exports.config = { api: { bodyParser: false } };

/* ====== НАСТРОЙКИ ====== */
const TELEGRAM_TOKEN = "7744092789:AAFrGBNAC5uZt5mWz0n7MX7veG22EqBXApg";
const SHEET_ID       = "1FQdRuNu64Q-1Da3shqSHrB-DnWEzgIDyY5uKMjFQxZU";
const SHEET_NAME     = "Лист1";
const TZ             = "Europe/Moscow";
/* ======================= */

const TG_API    = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const SHEET_URL =
  `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(SHEET_NAME)}`;

// ===== Роли (названия из таблицы -> внутренние ключи) =====
const ROLE_ALIASES = {
  // из твоей таблицы (строка 2):
  "оператор":    "operator",
  "ведущие":     "host",
  "монтаж":      "editor_video",
  "сценаристы":  "writer",
  "редакторы":   "editor_text",

  // на всякий случай — синонимы/варианты:
  "ведущий":     "host",
  "редактор":    "editor_text",
  "сценарий":    "writer",
  "монтажёр":    "editor_video",
  "монтажеры":   "editor_video",
  "операторы":   "operator"
};

// порядок и подписи с эмодзи
const RENDER_ORDER = ["operator", "host", "editor_video", "writer", "editor_text"];
const ROLE_LABEL = {
  operator:     "🎥 Оператор",
  host:         "🎙 Ведущий",
  editor_video: "✂️ Монтажёр",
  writer:       "📝 Сценарий",
  editor_text:  "💻 Редактор",
};

/* ---------- utils ---------- */
function todayStr() {
  return new Intl.DateTimeFormat("ru-RU", {
    day:"2-digit", month:"2-digit", year:"numeric", timeZone:TZ
  }).format(new Date()).replace(/\//g,".");
}
function csvParse(t){ return t.trim().split(/\r?\n/).map(r=>r.split(",").map(c=>c.trim())); }

// Собираем людей по фиксированным ключам ролей
function makeByRoleFixed(rows, row) {
  const header = rows[1];
  const out = {};
  for (let i = 1; i < header.length; i++) {
    const roleRaw = (header[i] || "").toString().trim().toLowerCase();
    const key = ROLE_ALIASES[roleRaw];
    if (!key) continue;

    const val = (row[i] == null ? "" : row[i].toString()).trim();
    if (!val || val === "-") continue; // "-" скрываем; "х" оставляем как есть
    (out[key] ||= []).push(val);
  }
  return out;
}

// Рендер в нужном порядке, с эмодзи и "—" если пусто
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

async function fetchSheetRows(){
  const r = await fetch(SHEET_URL);
  const txt = await r.text();
  const looksHtml = /^\s*</.test(txt) || txt.includes("<!DOCTYPE html");
  if (!r.ok || looksHtml){
    console.error("Sheets fetch error:", { status:r.status, looksHtml, head:txt.slice(0,200) });
    throw new Error("SHEETS_ACCESS");
  }
  return csvParse(txt);
}
function normDate(s) {
  if (s == null) return null;
  let t = String(s).trim();

  // убираем кавычки и "г." в конце
  t = t.replace(/^["']|["']$/g, "").replace(/\s*г\.?$/i, "");

  // приводим / к .
  t = t.replace(/\//g, ".");

  const m = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/);
  if (!m) return null;

  let [, dd, mm, yy] = m;
  dd = dd.padStart(2, "0");
  mm = mm.padStart(2, "0");
  if (yy.length === 2) yy = "20" + yy;

  return `${dd}.${mm}.${yy}`;
}
function findRowByDate(rows, targetDS) {
  const target = normDate(targetDS);
  if (!target) return null;

  for (const row of rows.slice(2)) {           // со строки 3 — данные
    const raw = row[0];
    const ds  = normDate(raw);
    if (ds && ds === target) return row;
  }
  return null;
}
function makeByRole(rows, row){
  const header = rows[1], byRole = {};
  for (let i=1;i<header.length;i++){
    const role = header[i] || `Колонка ${i+1}`;
    const val  = (row[i]||"").trim();
    if (!val || val === "-") continue; // "-" скрываем, "х" оставляем
    (byRole[role] ||= []).push(val);
  }
  return byRole;
}
function formatByRole(byRole){
  const lines=[];
  for (const [role,arr] of Object.entries(byRole)){
    const uniq=[...new Set(arr.map(s=>s.replace(/\s+/g," ").trim()))].filter(Boolean);
    if (uniq.length) lines.push(`${role}: ${uniq.join(", ")}`);
  }
  return lines.join("\n");
}

/* --- отправка в TG с ретраями --- */
async function sendMessage(chatId, text, replyMarkup){
  const url = `${TG_API}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: text || " ",
    parse_mode: "HTML",
    disable_web_page_preview: true
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;

  const headers = { "Content-Type":"application/json" };
  const body = JSON.stringify(payload);

  let lastErr;
  for (const delay of [0, 400, 1200]) { // 3 попытки
    if (delay) await new Promise(r=>setTimeout(r, delay));
    try {
      const resp = await fetch(url, { method:"POST", headers, body });
      const txt  = await resp.text();
      if (!resp.ok){
        console.error("TG sendMessage error:", resp.status, txt.slice(0,180));
        lastErr = new Error(`TG ${resp.status}`);
        continue;
      }
      console.log("TG sendMessage ok:", txt.slice(0,160));
      return;
    } catch(e){
      console.error("TG sendMessage fetch fail:", e?.message || e);
      lastErr = e;
    }
  }
  console.error("TG sendMessage failed after retries:", lastErr?.message || lastErr);
}

/* --- меню --- */
function menu(){
  return { inline_keyboard: [[
    { text:"Сегодня", callback_data:"today" },
    { text:"3 дня",  callback_data:"3days" }
  ]]};
}

/* --- ответы --- */
async function answerToday(chatId){
  try{
    const rows = await fetchSheetRows();
    const ds   = todayStr();
    const row  = findRowByDate(rows, ds);
    if (!row) return sendMessage(chatId, `Нет записей на ${ds}`, menu());
    const text = `📅 Сегодня (${ds}) по графику:\n` + formatFixed(makeByRoleFixed(rows, row));
    return sendMessage(chatId, text, menu());
  }catch(e){
    if (String(e.message)==="SHEETS_ACCESS"){
      return sendMessage(chatId, "Не могу прочитать таблицу. Дай доступ: «Любой, у кого есть ссылка — Просмотр».", menu());
    }
    console.error("answerToday error:", e);
  }
}
async function answer3Days(chatId){
  try{
    const rows = await fetchSheetRows();
    const parts=[];
    for (let i=0;i<3;i++){
      const d=new Date(); d.setDate(d.getDate()+i);
      const ds=new Intl.DateTimeFormat("ru-RU",{day:"2-digit",month:"2-digit",year:"numeric",timeZone:TZ})
        .format(d).replace(/\//g,".");
      const row=findRowByDate(rows, ds);
      parts.push(row ? `📅 ${ds} по графику:\n${formatFixed(makeByRoleFixed(rows,row))}` : `📅 ${ds} по графику:\n—`);
    }
    return sendMessage(chatId, parts.join("\n\n"), menu());
  }catch(e){
    if (String(e.message)==="SHEETS_ACCESS"){
      return sendMessage(chatId, "Не могу прочитать таблицу. Дай доступ: «Любой, у кого есть ссылка — Просмотр».", menu());
    }
    console.error("answer3Days error:", e);
  }
}

/* --- чтение тела --- */
async function readRawBody(req){
  if (req.method === "GET") return { ping:true }; // чтобы /api/webhook в браузере отвечал
  if (req.body) return req.body;
  const chunks=[]; for await (const ch of req) chunks.push(ch);
  const raw=Buffer.concat(chunks).toString();
  try { return JSON.parse(raw); } catch { return {}; }
}

/* --- handler --- */
// ВАЖНО: сначала выполняем всю работу, потом шлём 200 OK.
module.exports = async (req,res)=>{
  let body={};
  try { body = await readRawBody(req); } catch(e){ console.error("read body error", e); }

  try{
    if (body.callback_query){
      const cq = body.callback_query;
      console.log("update_type=callback_query", cq.data);
      const chatId = cq?.message?.chat?.id;
      if (chatId){
        if (cq.data === "today") await answerToday(chatId);
        else if (cq.data === "3days") await answer3Days(chatId);
      }
    } else if (body.message){
      const msg = body.message;
      const chatId = msg.chat.id;
      const text   = (msg.text||"").trim();
      console.log("update_type=message", text);

      if (/^\/start/i.test(text))                         await sendMessage(chatId, "Выбери:", menu());
      else if (/^(\/график|график|сегодня|\/today)$/i.test(text)) await answerToday(chatId);
      else if (/^(3\s*дня|три\s*дня|\/three)$/i.test(text))       await answer3Days(chatId);
    }
  }catch(e){
    console.error("Webhook error:", e);
  }

  // Отвечаем после обработки
  res.status(200).send("ok");
};
