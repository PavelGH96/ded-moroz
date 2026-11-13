// PDF-письмо от Деда Мороза, A4. Фон (бумага, рамка, герб, портрет, подпись, печать) — готовая картинка
// letter/bg-a4.jpg, сюда накладывается только текст под конкретного ребёнка.
// Библиотеки передаются снаружи, поэтому код работает и в Deno, и в Node.
import { buildLetter } from "./letter.js";

const W = 595.28, H = 841.89, K = W / 794; // пункты PDF на 1 px макета фона (794×1123)
const px = (x) => x * K, py = (y) => H - y * K;

const INK = [0.106, 0.165, 0.369];      // тёмно-синие чернила
const INK_SOFT = [0.30, 0.34, 0.50];
const GOLD = [0.54, 0.39, 0.13];

const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

export async function makeLetterPdf(lib, fonts, data, opts = {}) {
  const { PDFDocument, rgb, fontkit } = lib;
  const col = (a) => rgb(a[0], a[1], a[2]);
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const name = String(data.name || "").trim();
  doc.setTitle(name ? `Письмо от Деда Мороза для ${name}` : "Письмо от Деда Мороза");
  doc.setAuthor("Дед Мороз");
  doc.setCreator("Дед Мороз заходил");
  const hand = await doc.embedFont(fonts.hand, { subset: true });
  const callig = await doc.embedFont(fonts.callig, { subset: true });
  // pdf-lib не применяет кернинг шрифта, поэтому пары букв выравниваем сами по данным из шрифта
  const typo = new Map([[hand, kerner(fontkit, fonts.hand, true)], [callig, kerner(fontkit, fonts.callig, false)]]);
  const textW = (font, str, size) => typo.has(font) ? typo.get(font).width(font, str, size) : font.widthOfTextAtSize(str, size);
  const drawT = (str, o) => typo.has(o.font) ? typo.get(o.font).draw(page, str, o) : page.drawText(str, o);
  const serif = await doc.embedFont(fonts.serif, { subset: true });

  const page = doc.addPage([W, H]);
  if (fonts.bg) {
    const img = await doc.embedJpg(fonts.bg);
    page.drawImage(img, { x: 0, y: 0, width: W, height: H });
  } else {
    page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: rgb(0.98, 0.95, 0.89) });
  }

  // зона текста на фоне: x 104…690 px, y 250…842 px
  const left = px(104), right = px(690), maxW = right - left;
  const top = py(252), bottom = py(842);

  // дата
  const d = opts.date || new Date(Date.UTC(opts.year || new Date().getUTCFullYear(), 11, 31));
  const dateStr = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} года`;

  const letter = buildLetter(data);
  const greet = letter.greeting.map((r) => r.t).join("");

  function wrap(font, size, runs, indent) {
    const words = runs.map((r) => r.t).join("").split(/\s+/).filter(Boolean);
    const lines = [];
    let line = "", w = 0, first = true;
    for (const wd of words) {
      const lim = maxW - (first ? indent : 0);
      const next = line ? line + " " + wd : wd;
      if (line && textW(font, next, size) > lim) { lines.push({ text: line, indent: first ? indent : 0 }); line = wd; first = false; }
      else line = next;
    }
    if (line) lines.push({ text: line, indent: first ? indent : 0 });
    return lines;
  }

  function layout(size) {
    const lh = size * 1.6, gap = size * 0.42, indent = size * 1.6;
    const gSize = Math.min(34, size * 2.05);
    let gLines = wrap(callig, gSize, [{ t: greet }], 0);
    const paras = letter.paragraphs.map((p) => wrap(hand, size, p, indent));
    const dateH = size * 1.2 + 10;
    const greetH = gLines.length * gSize * 1.05 + size * 0.5;
    const bodyH = paras.reduce((s, ls) => s + ls.length * lh + gap, 0) - gap;
    return { size, lh, gap, gSize, gLines, paras, dateH, greetH, total: dateH + greetH + bodyH };
  }
  let lay = layout(17);
  for (let s = 17; s >= 11.5 && lay.total > top - bottom; s -= 0.5) lay = layout(s);

  let y = top - lay.size;
  drawT(dateStr, { x: right - textW(hand, dateStr, lay.size * 0.95), y, size: lay.size * 0.95, font: hand, color: col(INK_SOFT) });
  y -= lay.dateH - lay.size + lay.gSize * 0.9;
  for (const gl of lay.gLines) {
    drawT(gl.text, { x: left, y, size: lay.gSize, font: callig, color: col(INK) });
    y -= lay.gSize * 1.05;
  }
  y -= lay.size * 0.5 - lay.gSize * 0.05 + lay.size * 0.35;
  for (const lines of lay.paras) {
    for (const ln of lines) {
      drawT(ln.text, { x: left + ln.indent, y, size: lay.size, font: hand, color: col(INK) });
      y -= lay.lh;
    }
    y -= lay.gap;
  }

  // номер письма под подписью
  if (opts.orderId) {
    const num = `письмо № ${String(opts.orderId).padStart(4, "0")}`;
    const s = 8.5;
    page.drawText(num, { x: px(690) - serif.widthOfTextAtSize(num, s), y: py(1046), size: s, font: serif, color: col(GOLD) });
  }

  return await doc.save();
}

// Кернинг по парам букв (GPOS шрифта) и дополнительный воздух перед «Я»,
// у которой в Bad Script длинный завиток влево и он наезжает на точку предыдущего предложения.
function kerner(fontkit, bytes, handFix) {
  let fk = null;
  try { fk = fontkit.create(bytes); } catch { fk = null; }
  const upm = fk ? fk.unitsPerEm : 1000;
  const cache = new Map();
  function pair(a, b) {
    const k = a + b;
    if (cache.has(k)) return cache.get(k);
    let v = 0;
    if (fk && a !== " " && b !== " ") {
      try {
        const r = fk.layout(k, ["kern"]);
        if (r.glyphs.length === 2) v = r.positions[0].xAdvance - r.glyphs[0].advanceWidth;
      } catch { v = 0; }
      // в Bad Script у «Т» и «Г» кернинг задан не для всех строчных букв: добиваем недостающие пары
      if (handFix && v === 0 && (a === "Т" || a === "Г") && /[а-яё]/.test(b)) v = -220 * upm / 1000;
    }
    cache.set(k, v);
    return v;
  }
  const swashBefore = (prev, ch) => (handFix && ch === "Я" && (prev === " " || prev === undefined) ? 0.55 : 0);
  // делит строку на куски, между которыми нужен сдвиг; возвращает [{text, shift}]
  function pieces(str, size) {
    const out = [];
    let cur = "", shift = 0;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i], prev = str[i - 1];
      let adj = 0;
      if (i > 0) adj += pair(prev, ch) * size / upm;
      adj += swashBefore(prev, ch) * size * (i === 0 ? 0 : 1);
      if (Math.abs(adj) > size * 0.012 && cur) { out.push({ text: cur, shift }); cur = ""; shift = adj; }
      else if (!cur) shift += adj;
      cur += ch;
    }
    if (cur) out.push({ text: cur, shift });
    return out;
  }
  return {
    width(font, str, size) {
      return pieces(str, size).reduce((w, p) => w + p.shift + font.widthOfTextAtSize(p.text, size), 0);
    },
    draw(page, str, o) {
      let x = o.x;
      for (const p of pieces(str, o.size)) {
        x += p.shift;
        page.drawText(p.text, { ...o, x });
        x += o.font.widthOfTextAtSize(p.text, o.size);
      }
    },
  };
}

// ---------- допродажи ----------
async function simpleDoc(lib, fonts, bgBytes, title) {
  const { PDFDocument, rgb, fontkit } = lib;
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(title);
  doc.setAuthor("Дед Мороз");
  doc.setCreator("Дед Мороз заходил");
  const page = doc.addPage([W, H]);
  if (bgBytes) page.drawImage(await doc.embedJpg(bgBytes), { x: 0, y: 0, width: W, height: H });
  else page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: rgb(0.98, 0.95, 0.89) });
  return { doc, page, col: (a) => rgb(a[0], a[1], a[2]) };
}
function fitSize(font, str, max, start, min) {
  let s = start;
  while (s > min && font.widthOfTextAtSize(str, s) > max) s -= 0.5;
  return s;
}
const firstName = (d) => { const n = String(d.name || "").replace(/\s+/g, " ").trim(); return n ? n[0].toUpperCase() + n.slice(1) : ""; };

// Бирки на подарки: 8 штук на листе, в строке «Кому» имя получателя (фон letter/tags-a4.jpg)
export async function makeTagsPdf(lib, fonts, data) {
  const name = firstName(data);
  const { doc, page, col } = await simpleDoc(lib, fonts, fonts.tagsBg, name ? `Бирки на подарки для ${name}` : "Бирки на подарки");
  if (name) {
    const callig = await doc.embedFont(fonts.callig, { subset: true });
    const size = fitSize(callig, name, px(166), 30, 14);
    for (const ty of [40, 301, 562, 823]) for (const tx of [40, 407]) {
      const w = callig.widthOfTextAtSize(name, size);
      page.drawText(name, { x: px(tx + 196) - w / 2, y: py(ty + 136), size, font: callig, color: col(INK) });
    }
  }
  return await doc.save();
}

// Бланк «Письмо Деду Морозу» для ребёнка: имя и возраст уже вписаны (фон letter/blank-a4.jpg)
export async function makeBlankPdf(lib, fonts, data) {
  const name = firstName(data);
  const { doc, page, col } = await simpleDoc(lib, fonts, fonts.blankBg, "Письмо Деду Морозу");
  const hand = await doc.embedFont(fonts.hand, { subset: true });
  if (name) {
    const size = fitSize(hand, name, px(306), 24, 14);
    page.drawText(name, { x: px(214), y: py(339), size, font: hand, color: col(INK) });
  }
  const age = parseInt(data.age, 10);
  if (age > 0 && age < 18) {
    const s = String(age), size = 24;
    page.drawText(s, { x: px(626) - hand.widthOfTextAtSize(s, size) / 2, y: py(339), size, font: hand, color: col(INK) });
  }
  return await doc.save();
}
