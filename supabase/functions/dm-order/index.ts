// Приём заявок сайта «Дед Мороз заходил».
// POST multipart/form-data (с сайта, можно с фото) или application/json (без фото).
// Сохраняет заявку в dedmoroz.orders, собирает PDF-письмо и отправляет всё в Telegram.
//
// Секреты функции:
//   TELEGRAM_BOT_TOKEN  токен бота от @BotFather (обязателен для уведомлений)
//   TELEGRAM_CHAT_ID    необязателен: если не задан, берётся чат, где боту написали /start
//   ALLOWED_ORIGINS     необязателен: список доменов сайта через запятую, по умолчанию все
import postgres from "npm:postgres@3.4.5";
import * as PL from "npm:pdf-lib@1.17.1";
import fontkit from "npm:@pdf-lib/fontkit@1.1.1";
import { buildLetter, letterPlain, years } from "./letter.js";
import { makeLetterPdf } from "./pdf.js";

const PRODUCTS: Record<string, { title: string; price: number }> = {
  both: { title: "Письмо и видео", price: 1490 },
  letter: { title: "Только письмо", price: 390 },
  video: { title: "Только видео", price: 1490 },
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
    "Access-Control-Allow-Methods": "POST, OPTIONS",
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
        if (!a.bg) assetsPromise = null; // без фона письмо соберётся, но в следующий раз попробуем снова
        return a;
      })
      .catch((e) => { assetsPromise = null; throw e; });
  }
  return assetsPromise;
}
async function letterPdf(data: Record<string, unknown>, orderId: number) {
  const fonts = await loadAssets();
  const year = new Date(Date.now() + 3 * 3600e3).getUTCFullYear();
  return await makeLetterPdf({ ...PL, fontkit }, fonts, data, { year, orderId });
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

async function notify(order: any, data: any, photo: File | null, pdf: Uint8Array | null) {
  if (!TG) throw new Error("TELEGRAM_BOT_TOKEN не задан");
  const chat = await chatId();
  if (!chat) throw new Error("Не удалось определить чат для заявок");
  const p = PRODUCTS[data.product];
  const g = data.gender === "f" ? "девочка" : data.gender === "m" ? "мальчик" : "";
  const kid = [esc(data.name), years(data.age), g].filter(Boolean).join(", ");
  const lines = [
    `🎄 <b>Заказ №${order.id}</b> · ${esc(p.title)} · ${p.price} ₽`,
    ``,
    `👶 ${kid}`,
    data.praise ? `⭐ Похвалить: ${esc(data.praise)}` : "",
    data.wish ? `🎯 Постараться: ${esc(data.wish)}` : "",
    data.gift ? `🎁 Подарок: ${esc(data.gift)}` : "",
    data.product !== "letter" ? `📷 Фото: ${photo ? "ниже" : "пришлют позже"}` : "",
    `👤 ${esc(data.parent || "без имени")} · ${contactHtml(data.contact)}`,
    ``,
    `✉️ <b>Текст письма</b>`,
    `<blockquote>${esc(letterPlain(data))}</blockquote>`,
  ].filter((l, i, a) => l !== "" || (a[i - 1] !== "" && i > 0));
  await tg("sendMessage", { chat_id: chat, text: lines.join("\n"), parse_mode: "HTML", link_preview_options: { is_disabled: true } });

  if (pdf) {
    const f = new FormData();
    f.append("chat_id", chat);
    f.append("caption", `Письмо к заказу №${order.id}`);
    f.append("document", new Blob([pdf], { type: "application/pdf" }), `pismo-deda-moroza-${order.id}.pdf`);
    await tg("sendDocument", f);
  }
  if (photo) {
    const f = new FormData();
    f.append("chat_id", chat);
    f.append("caption", `Фото комнаты к заказу №${order.id}`);
    f.append("document", photo, photo.name || `photo-${order.id}.jpg`);
    await tg("sendDocument", f);
  }
}

// ---------- проверка данных ----------
const str = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

function parse(raw: Record<string, unknown>) {
  const errors: Record<string, string> = {};
  const d = {
    product: str(raw.product, 10),
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
  if (!d.name) errors.name = "Впишите имя ребёнка.";
  if (d.age !== null && (d.age < 1 || d.age > 17)) d.age = null;
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

// ---------- обработчик ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, 405, { ok: false, error: "Только POST" });

  let raw: Record<string, unknown> = {};
  let photo: File | null = null;
  try {
    const type = req.headers.get("content-type") || "";
    if (type.includes("multipart/form-data") || type.includes("application/x-www-form-urlencoded")) {
      const form = await req.formData();
      for (const [k, v] of form.entries()) {
        if (k === "photo") { if (v instanceof File && v.size > 0) photo = v; }
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
  if (photo) {
    if (!/^image\//.test(photo.type)) errors.photo = "Подойдёт только фото (JPG, PNG, HEIC).";
    else if (photo.size > MAX_PHOTO) errors.photo = "Фото больше 10 МБ. Уменьшите его или пришлите позже в переписке.";
  }
  if (Object.keys(errors).length) return json(req, 422, { ok: false, error: Object.values(errors)[0], fields: errors });
  if (d.product === "letter") photo = null;

  const ih = await ipHash(req);
  const [{ n }] = await sql`select count(*)::int as n from dedmoroz.orders where ip_hash = ${ih} and created_at > now() - interval '15 minutes'`;
  if (n >= RATE_LIMIT) return json(req, 429, { ok: false, error: "Слишком много заявок подряд. Подождите 15 минут или напишите нам напрямую." });

  const letter = letterPlain(d);
  const [order] = await sql`
    insert into dedmoroz.orders (product, price_rub, child_name, child_age, child_gender, praise, wish, gift, parent_name, contact, has_photo, letter_text, consent_at, ip_hash)
    values (${d.product}, ${PRODUCTS[d.product].price}, ${d.name}, ${d.age}, ${d.gender || null}, ${d.praise || null}, ${d.wish || null}, ${d.gift || null},
            ${d.parent || null}, ${d.contact}, ${!!photo}, ${letter}, now(), ${ih})
    returning id`;

  // письмо и уведомление: заявка уже сохранена, поэтому ошибки здесь не теряют заказ
  let pdf: Uint8Array | null = null;
  let tgError: string | null = null;
  try { pdf = await letterPdf(d, order.id); } catch (e) { tgError = "PDF: " + (e as Error).message; console.error(tgError); }
  try {
    await notify(order, d, photo, pdf);
  } catch (e) {
    tgError = [tgError, "Telegram: " + (e as Error).message].filter(Boolean).join("; ");
    console.error(tgError);
  }
  await sql`update dedmoroz.orders set tg_sent = ${!tgError || !tgError.includes("Telegram")}, tg_error = ${tgError} where id = ${order.id}`;

  return json(req, 200, { ok: true, id: order.id });
});
