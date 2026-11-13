// Приём заявок сайта «Дед Мороз заходил».
// POST multipart/form-data (с сайта, можно с фото) или application/json (без фото).
// Сохраняет заявку в dedmoroz.orders, собирает PDF (письмо, бирки, бланк) и отправляет всё в Telegram.
// GET ?gift=<токен> отдаёт письмо для подарочной страницы gift.html, GET ?gift=<токен>&pdf=1 отдаёт PDF письма.
//
// Секреты функции:
//   TELEGRAM_BOT_TOKEN  токен бота от @BotFather (обязателен для уведомлений)
//   TELEGRAM_CHAT_ID    необязателен: если не задан, берётся чат, где боту написали /start
//   ALLOWED_ORIGINS     необязателен: список доменов сайта через запятую, по умолчанию все
//   ELEVENLABS_API_KEY  необязателен: ключ ElevenLabs, включает озвучку письма голосом Деда Мороза
//   ELEVENLABS_VOICE_ID необязателен: id голоса из библиотеки ElevenLabs (по умолчанию стандартный голос)
//   ELEVENLABS_MODEL    необязателен: модель, по умолчанию eleven_multilingual_v2
import postgres from "npm:postgres@3.4.5";
import * as PL from "npm:pdf-lib@1.17.1";
import fontkit from "npm:@pdf-lib/fontkit@1.1.1";
import { buildLetter, letterPlain, years } from "./letter.js";
import { makeLetterPdf, makeTagsPdf, makeBlankPdf } from "./pdf.js";

const PRODUCTS: Record<string, { title: string; price: number }> = {
  both: { title: "Письмо и видео", price: 1490 },
  letter: { title: "Только письмо", price: 390 },
  video: { title: "Только видео", price: 1490 },
};
const ADDONS: Record<string, { title: string; price: number; childOnly?: boolean }> = {
  tags: { title: "Бирки на подарки", price: 99 },
  blank: { title: "Бланк «Письмо Деду Морозу»", price: 99, childOnly: true },
};
const MAX_PHOTO = 10 * 1024 * 1024;
const RATE_LIMIT = 5; // заявок с одного адреса за 15 минут

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2, idle_timeout: 20 });
const TG = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";

// ---------- ответы и CORS ----------
function corsHeaders(req: Request) {
  const allowed = (Deno.env.get("ALLOWED_ORIGINS") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.get("origin") || "";
  const allow = !allowed.length ? "*" : allowed.includes(origin) ? origin : allowed[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
    "Vary": "Origin",
  };
}
function json(req: Request, status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(req), "Content-Type": "application/json; charset=utf-8" } });
}

// ---------- шрифты для PDF (кэшируются, пока функция «тёплая») ----------
// шрифты и фон бланка лежат на сайте (папка letter/), запасной путь для шрифтов — репозиторий Google Fonts
const SITE = Deno.env.get("SITE_URL") || "https://pavelgh96.github.io/ded-moroz";
const ASSETS: Record<string, string[]> = {
  hand: [`${SITE}/letter/BadScript-Regular.ttf`, "https://raw.githubusercontent.com/google/fonts/main/ofl/badscript/BadScript-Regular.ttf"],
  callig: [`${SITE}/letter/GreatVibes-Regular.ttf`, "https://raw.githubusercontent.com/google/fonts/main/ofl/greatvibes/GreatVibes-Regular.ttf"],
  serif: [`${SITE}/letter/CormorantSC-SemiBold.ttf`, "https://raw.githubusercontent.com/google/fonts/main/ofl/cormorantsc/CormorantSC-SemiBold.ttf"],
  bg: [`${SITE}/letter/bg-a4.jpg`],
  tagsBg: [`${SITE}/letter/tags-a4.jpg`],
  blankBg: [`${SITE}/letter/blank-a4.jpg`],
};
let assetsPromise: Promise<Record<string, Uint8Array | null>> | null = null;
async function fetchFirst(urls: string[]) {
  for (const u of urls) {
    try { const r = await fetch(u); if (r.ok) return new Uint8Array(await r.arrayBuffer()); } catch { /* следующий адрес */ }
  }
  return null;
}
function loadAssets() {
  if (!assetsPromise) {
    assetsPromise = Promise.all(Object.entries(ASSETS).map(async ([k, urls]) => [k, await fetchFirst(urls)] as const))
      .then((list) => {
        const a = Object.fromEntries(list);
        for (const k of ["hand", "callig", "serif"]) if (!a[k]) throw new Error(`не загрузился шрифт ${k}`);
        if (!a.bg || !a.tagsBg || !a.blankBg) assetsPromise = null; // без фона письмо соберётся, но в следующий раз попробуем снова
        return a;
      })
      .catch((e) => { assetsPromise = null; throw e; });
  }
  return assetsPromise;
}
const newYear = () => { const m = new Date(Date.now() + 3 * 3600e3); return m.getUTCMonth() === 0 ? m.getUTCFullYear() - 1 : m.getUTCFullYear(); };
async function letterPdf(data: Record<string, unknown>, orderId: number) {
  const fonts = await loadAssets();
  return await makeLetterPdf({ ...PL, fontkit }, fonts, data, { year: newYear(), orderId });
}
async function addonPdf(kind: string, data: Record<string, unknown>) {
  const fonts = await loadAssets();
  return kind === "tags" ? await makeTagsPdf({ ...PL, fontkit }, fonts, data) : await makeBlankPdf({ ...PL, fontkit }, fonts, data);
}
// ---------- озвучка письма (ElevenLabs) ----------
// Голос создаётся один раз, при первом открытии подарочной ссылки, и хранится в dedmoroz.voice.
const XI = Deno.env.get("ELEVENLABS_API_KEY") || "";
const VOICE_ID = Deno.env.get("ELEVENLABS_VOICE_ID") || "JBFqnCBsd6RMkjVDRZzb";
const VOICE_MODEL = Deno.env.get("ELEVENLABS_MODEL") || "eleven_multilingual_v2";
const DEMO = { recipient: "child", name: "Маша", age: 5, gender: "f", praise: "научилась кататься на коньках и сама заплетаешь косички", wish: "не спорить с братом за пульт", gift: "кукольный домик с фонариками" };
function voiceText(d: Record<string, unknown>) {
  const l = buildLetter(d);
  const t = (runs: { t: string }[]) => runs.map((r) => r.t).join("");
  return [t(l.greeting), ...l.paragraphs.map(t), "С любовью, твой Дед Мороз."].join("\n\n");
}
const voiceJobs = new Map<string, Promise<Uint8Array>>();
async function getVoice(key: string, orderId: number | null, data: Record<string, unknown>) {
  const [row] = await sql`select mp3 from dedmoroz.voice where key = ${key}`;
  if (row) return new Uint8Array(row.mp3);
  if (!XI) throw new Error("озвучка не настроена");
  if (!voiceJobs.has(key)) {
    voiceJobs.set(key, (async () => {
      const text = voiceText(data);
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_128`, {
        method: "POST",
        headers: { "xi-api-key": XI, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({ text, model_id: VOICE_MODEL, voice_settings: { stability: 0.55, similarity_boost: 0.8, style: 0.25, use_speaker_boost: true, speed: 0.92 } }),
      });
      if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const mp3 = new Uint8Array(await r.arrayBuffer());
      await sql`insert into dedmoroz.voice (key, order_id, mp3, chars) values (${key}, ${orderId}, ${mp3}, ${text.length}) on conflict (key) do nothing`;
      return mp3;
    })().finally(() => setTimeout(() => voiceJobs.delete(key), 1000)));
  }
  return await voiceJobs.get(key)!;
}
// отдаёт mp3 с поддержкой Range: без этого Safari на iPhone не проигрывает звук
function audioResponse(req: Request, mp3: Uint8Array) {
  const base = { ...corsHeaders(req), "Content-Type": "audio/mpeg", "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=86400" };
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get("range") || "");
  if (m) {
    const size = mp3.length;
    let start = m[1] ? parseInt(m[1], 10) : size - parseInt(m[2] || "0", 10);
    let end = m[1] && m[2] ? parseInt(m[2], 10) : size - 1;
    if (isNaN(start) || start < 0) start = 0;
    if (end >= size) end = size - 1;
    if (start > end) return new Response(null, { status: 416, headers: { ...base, "Content-Range": `bytes */${size}` } });
    return new Response(mp3.slice(start, end + 1) as BodyInit, { status: 206, headers: { ...base, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) } });
  }
  return new Response(mp3 as BodyInit, { headers: { ...base, "Content-Length": String(mp3.length) } });
}

const giftUrl = (token: string) => `${SITE}/gift.html?t=${token}`;
function newToken() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------- Telegram ----------
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function tg(method: string, body: FormData | Record<string, unknown>) {
  const isForm = body instanceof FormData;
  const r = await fetch(`https://api.telegram.org/bot${TG}/${method}`, {
    method: "POST",
    headers: isForm ? undefined : { "Content-Type": "application/json" },
    body: isForm ? body : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }));
  if (!j.ok) throw new Error(`${method}: ${j.description || r.status}`);
  return j.result;
}

async function chatId(): Promise<string | null> {
  const fromEnv = Deno.env.get("TELEGRAM_CHAT_ID");
  if (fromEnv) return fromEnv;
  const [row] = await sql`select value from dedmoroz.settings where key = 'tg_chat_id'`;
  if (row) return row.value;
  // первый, кто написал боту /start, становится получателем заявок
  const updates = (await tg("getUpdates", { limit: 100 })) as any[];
  const msgs = updates.map((u) => u.message || u.channel_post || u.my_chat_member).filter((m) => m && m.chat);
  const starts = msgs.filter((m) => typeof m.text === "string" && m.text.startsWith("/start"));
  const pick = (starts.length ? starts : msgs).at(-1);
  if (!pick) {
    const me = await tg("getMe", {}).catch(() => null);
    throw new Error(`Боту ${me?.username ? "@" + me.username : ""} ещё никто не написал (обновлений: ${updates.length})`);
  }
  const id = String(pick.chat.id);
  await sql`insert into dedmoroz.settings (key, value) values ('tg_chat_id', ${id}) on conflict (key) do nothing`;
  const [saved] = await sql`select value from dedmoroz.settings where key = 'tg_chat_id'`;
  return saved?.value ?? id;
}

function contactHtml(c: string) {
  const t = c.trim();
  if (/^@[A-Za-z0-9_]{4,32}$/.test(t)) return `<a href="https://t.me/${t.slice(1)}">${esc(t)}</a>`;
  return esc(t);
}

async function sendDoc(chat: string, bytes: Blob | File, name: string, caption: string) {
  const f = new FormData();
  f.append("chat_id", chat);
  f.append("caption", caption);
  f.append("document", bytes, name);
  await tg("sendDocument", f);
}

async function notify(order: any, data: any, files: { photo: File | null; letterPhoto: File | null }, pdfs: { letter: Uint8Array | null; extra: [string, Uint8Array][] }) {
  if (!TG) throw new Error("TELEGRAM_BOT_TOKEN не задан");
  const chat = await chatId();
  if (!chat) throw new Error("Не удалось определить чат для заявок");
  const p = PRODUCTS[data.product];
  const adult = data.recipient === "adult";
  const g = adult ? (data.gender === "f" ? "женщина" : data.gender === "m" ? "мужчина" : "") : (data.gender === "f" ? "девочка" : data.gender === "m" ? "мальчик" : "");
  const who = [esc(data.name), adult ? "" : years(data.age), g].filter(Boolean).join(", ");
  const addons = (data.addons as string[]).map((a) => `${ADDONS[a].title} (+${ADDONS[a].price} ₽)`);
  const lines = [
    `🎄 <b>Заказ №${order.id}</b> · ${esc(p.title)} · <b>${order.total} ₽</b>`,
    addons.length ? `➕ ${esc(addons.join(", "))}` : "",
    ``,
    `${adult ? "🧑 Взрослому" : "👶"} ${who}`,
    data.praise ? `⭐ ${adult ? "Поблагодарить" : "Похвалить"}: ${esc(data.praise)}` : "",
    data.wish ? `🎯 ${adult ? "Пожелать" : "Постараться"}: ${esc(data.wish)}` : "",
    data.gift ? `🎁 Подарок: ${esc(data.gift)}` : "",
    data.product !== "letter" ? `📷 Фото комнаты: ${files.photo ? "ниже" : "пришлют позже"}` : "",
    files.letterPhoto ? `✉️ Письмо ребёнка Деду Морозу: фото ниже${data.product === "letter" ? "" : " (показать в видео)"}` : "",
    `👤 ${esc(data.parent || "без имени")} · ${contactHtml(data.contact)}`,
    ``,
    `🔗 Подарочная ссылка (отправить после оплаты):\n${esc(giftUrl(order.gift_token))}`,
    ``,
    `✉️ <b>Текст письма</b>`,
    `<blockquote>${esc(letterPlain(data))}</blockquote>`,
  ].filter((l, i, a) => l !== "" || (a[i - 1] !== "" && i > 0));
  await tg("sendMessage", { chat_id: chat, text: lines.join("\n"), parse_mode: "HTML", link_preview_options: { is_disabled: true } });

  const pdfBlob = (b: Uint8Array) => new Blob([b as BlobPart], { type: "application/pdf" });
  if (pdfs.letter) await sendDoc(chat, pdfBlob(pdfs.letter), `pismo-deda-moroza-${order.id}.pdf`, `Письмо к заказу №${order.id}`);
  for (const [kind, bytes] of pdfs.extra) {
    await sendDoc(chat, pdfBlob(bytes), kind === "tags" ? `birki-${order.id}.pdf` : `pismo-dedu-morozu-${order.id}.pdf`, `${ADDONS[kind].title} к заказу №${order.id}`);
  }
  if (files.photo) await sendDoc(chat, files.photo, files.photo.name || `photo-${order.id}.jpg`, `Фото комнаты к заказу №${order.id}`);
  if (files.letterPhoto) await sendDoc(chat, files.letterPhoto, files.letterPhoto.name || `letter-${order.id}.jpg`, `Письмо ребёнка Деду Морозу к заказу №${order.id}`);
}

// ---------- проверка данных ----------
const str = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

function parse(raw: Record<string, unknown>) {
  const errors: Record<string, string> = {};
  const d = {
    product: str(raw.product, 10),
    recipient: str(raw.recipient, 5) === "adult" ? "adult" : "child",
    addons: [...new Set(str(raw.addons, 40).split(",").map((s) => s.trim()).filter((a) => ADDONS[a]))],
    child_letter: false,
    name: str(raw.name, 24),
    age: parseInt(String(raw.age ?? ""), 10) || null,
    gender: str(raw.gender, 1),
    praise: str(raw.praise, 140),
    wish: str(raw.wish, 100),
    gift: str(raw.gift, 80),
    parent: str(raw.parent, 40),
    contact: str(raw.contact, 60),
    consent: ["1", "true", "on", "yes"].includes(String(raw.consent ?? "").toLowerCase()) || raw.consent === true,
  };
  if (!PRODUCTS[d.product]) errors.product = "Выберите, что готовить.";
  if (!d.name) errors.name = d.recipient === "adult" ? "Впишите имя получателя." : "Впишите имя ребёнка.";
  if (d.age !== null && (d.age < 1 || d.age > 17)) d.age = null;
  if (d.recipient === "adult") { d.age = null; d.addons = d.addons.filter((a) => !ADDONS[a].childOnly); }
  if (d.gender !== "m" && d.gender !== "f") d.gender = "";
  if (d.contact.length < 3) errors.contact = "Укажите, куда прислать готовый заказ.";
  if (!d.consent) errors.consent = "Без согласия на обработку данных мы не можем принять заказ.";
  return { d, errors };
}

async function ipHash(req: Request) {
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || req.headers.get("cf-connecting-ip") || "unknown";
  const salt = Deno.env.get("SUPABASE_URL") || "dm";
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(salt + "|" + ip));
  return Array.from(new Uint8Array(buf)).slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- подарочная страница ----------
function rowToData(r: any) {
  return { recipient: r.recipient, name: r.child_name, age: r.child_age, gender: r.child_gender || "", praise: r.praise || "", wish: r.wish || "", gift: r.gift || "", child_letter: r.has_letter_photo };
}
async function giftHandler(req: Request) {
  const u = new URL(req.url);
  if (u.searchParams.get("demo_voice")) {
    try { return audioResponse(req, await getVoice("demo", null, DEMO)); }
    catch (e) { return json(req, 503, { ok: false, error: (e as Error).message }); }
  }
  const token = (u.searchParams.get("gift") || "").trim();
  if (!/^[A-Za-z0-9_-]{16,40}$/.test(token)) return json(req, 400, { ok: false, error: "Ссылка неполная. Проверьте, что она скопирована целиком." });
  const [r] = await sql`select id, recipient, child_name, child_age, child_gender, praise, wish, gift, has_letter_photo, video_url, created_at, anonymized_at
                          from dedmoroz.orders where gift_token = ${token}`;
  if (!r || r.anonymized_at || !r.child_name) return json(req, 404, { ok: false, error: "Это письмо уже вернулось в Великий Устюг. Ссылка больше не работает." });
  const data = rowToData(r);
  if (u.searchParams.get("pdf")) {
    const bytes = await letterPdf(data, Number(r.id));
    return new Response(bytes as BodyInit, { headers: { ...corsHeaders(req), "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="pismo-deda-moroza-${r.id}.pdf"`, "Cache-Control": "private, max-age=300" } });
  }
  if (u.searchParams.get("voice")) {
    try { return audioResponse(req, await getVoice(`order:${r.id}`, Number(r.id), data)); }
    catch (e) { console.error("voice", (e as Error).message); return json(req, 503, { ok: false, error: "Озвучка сейчас недоступна." }); }
  }
  sql`update dedmoroz.orders set gift_opened_at = now() where id = ${r.id} and gift_opened_at is null`.catch(() => {});
  return json(req, 200, { ok: true, id: Number(r.id), year: newYear(), recipient: r.recipient, gender: data.gender, letter: buildLetter(data), video: r.video_url || null, voice: !!XI });
}

// ---------- обработчик ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (req.method === "GET") return await giftHandler(req);
  if (req.method !== "POST") return json(req, 405, { ok: false, error: "Только GET и POST" });

  let raw: Record<string, unknown> = {};
  let photo: File | null = null;
  let letterPhoto: File | null = null;
  try {
    const type = req.headers.get("content-type") || "";
    if (type.includes("multipart/form-data") || type.includes("application/x-www-form-urlencoded")) {
      const form = await req.formData();
      for (const [k, v] of form.entries()) {
        if (k === "photo") { if (v instanceof File && v.size > 0) photo = v; }
        else if (k === "letter_photo") { if (v instanceof File && v.size > 0) letterPhoto = v; }
        else raw[k] = v;
      }
    } else {
      raw = await req.json();
    }
  } catch {
    return json(req, 400, { ok: false, error: "Не удалось прочитать заявку. Обновите страницу и попробуйте ещё раз." });
  }

  // ловушка для ботов: это поле на сайте скрыто от людей
  if (str(raw.website, 100)) return json(req, 200, { ok: true, id: 0 });

  const { d, errors } = parse(raw);
  for (const [key, f] of [["photo", photo], ["letter_photo", letterPhoto]] as const) {
    if (!f) continue;
    if (!/^image\//.test(f.type)) errors[key] = "Подойдёт только фото (JPG, PNG, HEIC).";
    else if (f.size > MAX_PHOTO) errors[key] = "Фото больше 10 МБ. Уменьшите его или пришлите позже в переписке.";
  }
  if (Object.keys(errors).length) return json(req, 422, { ok: false, error: Object.values(errors)[0], fields: errors });
  if (d.product === "letter") photo = null;
  if (d.recipient === "adult") letterPhoto = null;
  d.child_letter = !!letterPhoto;
  const total = PRODUCTS[d.product].price + d.addons.reduce((s, a) => s + ADDONS[a].price, 0);
  const token = newToken();

  const ih = await ipHash(req);
  const [{ n }] = await sql`select count(*)::int as n from dedmoroz.orders where ip_hash = ${ih} and created_at > now() - interval '15 minutes'`;
  if (n >= RATE_LIMIT) return json(req, 429, { ok: false, error: "Слишком много заявок подряд. Подождите 15 минут или напишите нам напрямую." });

  const letter = letterPlain(d);
  const [order] = await sql`
    insert into dedmoroz.orders (product, price_rub, recipient, addons, child_name, child_age, child_gender, praise, wish, gift, parent_name, contact,
                                 has_photo, has_letter_photo, letter_text, consent_at, ip_hash, gift_token)
    values (${d.product}, ${total}, ${d.recipient}, ${d.addons}, ${d.name}, ${d.age}, ${d.gender || null}, ${d.praise || null}, ${d.wish || null}, ${d.gift || null},
            ${d.parent || null}, ${d.contact}, ${!!photo}, ${!!letterPhoto}, ${letter}, now(), ${ih}, ${token})
    returning id, gift_token`;
  order.total = total;

  // письмо и уведомление: заявка уже сохранена, поэтому ошибки здесь не теряют заказ
  let pdf: Uint8Array | null = null;
  let tgError: string | null = null;
  const extra: [string, Uint8Array][] = [];
  try {
    pdf = await letterPdf(d, order.id);
    for (const a of d.addons) extra.push([a, await addonPdf(a, d)]);
  } catch (e) { tgError = "PDF: " + (e as Error).message; console.error(tgError); }
  try {
    await notify(order, d, { photo, letterPhoto }, { letter: pdf, extra });
  } catch (e) {
    tgError = [tgError, "Telegram: " + (e as Error).message].filter(Boolean).join("; ");
    console.error(tgError);
  }
  await sql`update dedmoroz.orders set tg_sent = ${!tgError || !tgError.includes("Telegram")}, tg_error = ${tgError} where id = ${order.id}`;

  return json(req, 200, { ok: true, id: order.id });
});
