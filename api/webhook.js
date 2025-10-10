module.exports.config = { api: { bodyParser: false } };

// === настройки ===
const TELEGRAM_TOKEN = "7744092789:AAFrGBNAC5uZt5mWz0n7MX7veG22EqBXApg";
const SHEET_ID = "1FQdRuNu64Q-1Da3shqSHrB-DnWEzgIDyY5uKMjFQxZU";
const SHEET_NAME = "Лист1";
const TZ = "Europe/Moscow";

const TG_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const SHEET_URL =
  `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(SHEET_NAME)}`;

// === утилиты ===
function todayStr() {
  return new Intl.DateTimeFormat("ru-RU", { day:"2-digit", month:"2-digit", year:"numeric", timeZone:TZ })
    .format(new Date()).replace(/\//g, ".");
}
function csvParse(text) {
  return text.trim().split(/\r?\n/).map(r => r.split(",").map(c => c.trim()));
}
async function fetchSheetRows() {
  const r = await fetch(SHEET_URL);
  if (!r.ok) throw new Error(`Sheets HTTP ${r.status}`);
  return csvParse(await r.text());
}
function findRowByDate(rows, ds) {
  for (const row of rows.slice(2)) if ((row[0]||"").trim() === ds) return row;
  return null;
}
function makeByRole(rows, row) {
  const header = rows[1];
  const byRole = {};
  for (let i=1;i<header.length;i++){
    const role = header[i] || `Колонка ${i+1}`;
    const val = (row[i]||"").trim();
    if (!val || val === "-") continue; // "-" скрываем, "х" оставляем
    (byRole[role] ||= []).push(val);
  }
  return byRole;
}
function formatByRole(byRole) {
  const lines = [];
  for (const [role, arr] of Object.entries(byRole)) {
    const uniq = [...new Set(arr.map(s=>s.replace(/\s+/g," ").trim()))].filter(Boolean);
    if (uniq.length) lines.push(`${role}: ${uniq.join(", ")}`);
  }
  return lines.join("\n");
}
async function sendMessage(chatId, text, replyMarkup){
  const payload = { chat_id: chatId, text: text||" ", parse_mode:"HTML", disable_web_page_preview:true };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  await fetch(`${TG_API}/sendMessage`, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(payload) });
}
async function answerCallbackQuery(id){
  try { await fetch(`${TG_API}/answerCallbackQuery`, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({callback_query_id:id}) }); } catch {}
}
function menu(){
  return { inline_keyboard: [[
    { text:"Сегодня", callback_data:"today" },
    { text:"3 дня",  callback_data:"3days" }
  ]]};
}
async function answerToday(chatId){
  const rows = await fetchSheetRows();
  const ds = todayStr();
  const row = findRowByDate(rows, ds);
  if (!row) return sendMessage(chatId, `Нет записей на ${ds}`, menu());
  const text = `📅 Сегодня (${ds}) по графику:\n` + formatByRole(makeByRole(rows, row));
  return sendMessage(chatId, text, menu());
}
async function answer3Days(chatId){
  const rows = await fetchSheetRows();
  const parts = [];
  for (let i=0;i<3;i++){
    const d = new Date(); d.setDate(d.getDate()+i);
    const ds = new Intl.DateTimeFormat("ru-RU",{day:"2-digit",month:"2-digit",year:"numeric",timeZone:TZ}).format(d).replace(/\//g,".");
    const row = findRowByDate(rows, ds);
    parts.push(row ? `📅 ${ds} по графику:\n${formatByRole(makeByRole(rows,row))}` : `📅 ${ds} по графику:\n—`);
  }
  return sendMessage(chatId, parts.join("\n\n"), menu());
}
async function readRawBody(req){
  if (req.body) return req.body;
  const chunks=[]; for await (const ch of req) chunks.push(ch);
  const raw = Buffer.concat(chunks).toString();
  try { return JSON.parse(raw); } catch { return {}; }
}

// === handler ===
module.exports = async (req, res) => {
  res.status(200).send("ok"); // отвечаем Телеге мгновенно

  try{
    const body = await readRawBody(req);

    if (body.callback_query){
      const cq = body.callback_query;
      await answerCallbackQuery(cq.id);
      const chatId = cq?.message?.chat?.id;
      const data = cq?.data;
      if (!chatId) return;
      if (data === "today") return answerToday(chatId);
      if (data === "3days") return answer3Days(chatId);
      return;
    }

    const msg = body.message;
    if (!msg) return;
    const chatId = msg.chat.id;
    const text = (msg.text||"").trim();

    if (/^\/start/i.test(text))                       return sendMessage(chatId, "Выбери:", menu());
    if (/^(\/график|график|сегодня|\/today)$/i.test(text)) return answerToday(chatId);
    if (/^(3\s*дня|три\s*дня|\/three)$/i.test(text))       return answer3Days(chatId);
  }catch(e){ console.error("Webhook error:", e); }
};
