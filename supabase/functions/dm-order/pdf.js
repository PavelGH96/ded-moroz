// PDF-письмо от Деда Мороза, A4. Библиотеки передаются снаружи, поэтому код работает и в Deno, и в Node.
import { buildLetter } from "./letter.js";

const C = {
  paper: [0.988, 0.962, 0.905],
  paperEdge: [0.955, 0.91, 0.82],
  frost: [0.42, 0.56, 0.8],
  frostPale: [0.74, 0.82, 0.94],
  ink: [0.12, 0.2, 0.43],
  red: [0.69, 0.14, 0.11],
  rule: [0.62, 0.72, 0.88],
  muted: [0.42, 0.45, 0.55],
  wax: [0.73, 0.17, 0.13],
  waxDark: [0.5, 0.09, 0.07],
  waxText: [1, 0.9, 0.82],
};

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function ruDate(year) {
  return `31 декабря ${year} года`;
}

export async function makeLetterPdf(lib, fonts, data, opts = {}) {
  const { PDFDocument, rgb, degrees, fontkit, setCharacterSpacing, pushGraphicsState, popGraphicsState } = lib;
  const col = (a) => rgb(a[0], a[1], a[2]);
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle("Письмо от Деда Мороза");
  doc.setAuthor("Дед Мороз");
  doc.setCreator("Дед Мороз заходил");
  const script = await doc.embedFont(fonts.script, { subset: true });
  const sans = await doc.embedFont(fonts.sans, { subset: true });
  const sansBold = await doc.embedFont(fonts.sansBold, { subset: true });
  const serifBold = await doc.embedFont(fonts.serifBold, { subset: true });

  const W = 595.28, H = 841.89;
  const page = doc.addPage([W, H]);
  const year = opts.year || new Date().getFullYear();
  const r = rng(String(data.name || "").length * 131 + (parseInt(data.age, 10) || 3) * 17 + 7);

  // бумага с чуть потемневшим краем
  page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: col(C.paperEdge) });
  page.drawRectangle({ x: 10, y: 10, width: W - 20, height: H - 20, color: col(C.paper) });

  // морозная рамка: двойная линия
  const inset = 30;
  page.drawRectangle({ x: inset, y: inset, width: W - inset * 2, height: H - inset * 2, borderColor: col(C.frost), borderWidth: 1.4 });
  page.drawRectangle({ x: inset + 5, y: inset + 5, width: W - (inset + 5) * 2, height: H - (inset + 5) * 2, borderColor: col(C.frostPale), borderWidth: 0.7 });

  function flake(cx, cy, s, color, w = 0.9) {
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3 + Math.PI / 2;
      const ex = cx + Math.cos(a) * s, ey = cy + Math.sin(a) * s;
      page.drawLine({ start: { x: cx, y: cy }, end: { x: ex, y: ey }, thickness: w, color, lineCap: 1 });
      for (const k of [0.45, 0.72]) {
        const bx = cx + Math.cos(a) * s * k, by = cy + Math.sin(a) * s * k, bl = s * (k < 0.5 ? 0.3 : 0.22);
        for (const sgn of [-1, 1]) {
          const b = a + sgn * 0.75;
          page.drawLine({ start: { x: bx, y: by }, end: { x: bx + Math.cos(b) * bl, y: by + Math.sin(b) * bl }, thickness: w * 0.85, color, lineCap: 1 });
        }
      }
    }
  }
  // уголки рамки
  for (const [x, y] of [[inset, inset], [W - inset, inset], [inset, H - inset], [W - inset, H - inset]]) {
    page.drawCircle({ x, y, size: 15, color: col(C.paper) });
    flake(x, y, 12, col(C.frost), 1.1);
  }
  // редкие снежинки по полям
  for (let i = 0; i < 16; i++) {
    const side = i % 4, t = 0.08 + r() * 0.84, off = 10 + r() * 12;
    let x, y;
    if (side === 0) { x = inset + off + 6; y = H * t; }
    else if (side === 1) { x = W - inset - off - 6; y = H * t; }
    else if (side === 2) { x = W * t; y = H - inset - off - 4; }
    else { x = W * t; y = inset + off + 4; }
    if (side === 2 && x > 120 && x < W - 120) continue;
    flake(x, y, 3 + r() * 5, col(C.frostPale), 0.7);
  }

  // шапка письма
  const head = "ВЕЛИКИЙ УСТЮГ · ВОТЧИНА ДЕДА МОРОЗА";
  const hs = 8.6, sp = 1.6;
  const hw = sans.widthOfTextAtSize(head, hs) + sp * (head.length - 1);
  page.pushOperators(pushGraphicsState(), setCharacterSpacing(sp));
  page.drawText(head, { x: (W - hw) / 2, y: H - 86, size: hs, font: sansBold, color: col(C.frost) });
  page.pushOperators(popGraphicsState());
  const lineY = H - 100;
  page.drawLine({ start: { x: W / 2 - 120, y: lineY }, end: { x: W / 2 - 14, y: lineY }, thickness: 0.6, color: col(C.frostPale) });
  page.drawLine({ start: { x: W / 2 + 14, y: lineY }, end: { x: W / 2 + 120, y: lineY }, thickness: 0.6, color: col(C.frostPale) });
  flake(W / 2, lineY, 6, col(C.frost), 0.8);

  const dateStr = ruDate(year);
  const ds = 17;
  page.drawText(dateStr, { x: W - 78 - script.widthOfTextAtSize(dateStr, ds), y: H - 140, size: ds, font: script, color: col(C.muted) });

  // текст письма с переносами; вписанное родителями выделено красным
  const letter = buildLetter(data);
  const left = 78, right = W - 78, maxW = right - left, top = H - 190, bottomLimit = 250;
  function layout(size) {
    const lh = size * 1.55, gap = size * 0.35;
    const lines = [];
    for (const para of letter.paragraphs) {
      const words = [];
      for (const run of para) for (const part of run.t.split(/(\s+)/)) if (part) words.push({ t: part, em: !!run.em, space: /^\s+$/.test(part) });
      let line = [], w = 0;
      for (const wd of words) {
        const ww = script.widthOfTextAtSize(wd.space ? " " : wd.t, size);
        if (wd.space) { if (line.length) { line.push({ t: " ", em: wd.em, w: ww }); w += ww; } continue; }
        if (w + ww > maxW && line.length) {
          while (line.length && line[line.length - 1].t === " ") w -= line.pop().w;
          lines.push({ runs: line, gapAfter: 0 }); line = []; w = 0;
        }
        line.push({ t: wd.t, em: wd.em, w: ww }); w += ww;
      }
      while (line.length && line[line.length - 1].t === " ") line.pop();
      if (line.length) lines.push({ runs: line, gapAfter: gap });
    }
    const height = lines.reduce((s, l) => s + lh + l.gapAfter, 0);
    return { lines, lh, height, size };
  }
  let lay = layout(22);
  for (let s = 22; s >= 14 && top - lay.height < bottomLimit; s -= 1) lay = layout(s);

  let y = top;
  for (const ln of lay.lines) {
    page.drawLine({ start: { x: left - 4, y: y - lay.size * 0.36 }, end: { x: right + 4, y: y - lay.size * 0.36 }, thickness: 0.45, color: col(C.rule), opacity: 0.55 });
    let x = left;
    for (const run of ln.runs) {
      page.drawText(run.t, { x, y, size: lay.size, font: script, color: col(run.em ? C.red : C.ink) });
      x += run.w;
    }
    y -= lay.lh + ln.gapAfter;
  }

  // подпись
  const sig = letter.signature, ss = Math.max(lay.size + 6, 24);
  const sigY = Math.min(y - 22, 214);
  page.drawText(sig, { x: right - script.widthOfTextAtSize(sig, ss), y: sigY, size: ss, font: script, color: col(C.ink) });
  // росчерк под подписью
  const sx = right - script.widthOfTextAtSize(sig, ss);
  page.drawSvgPath(`M ${sx + 10} 0 C ${sx + 80} -14, ${right - 40} 12, ${right + 6} -6`, { x: 0, y: sigY - 10, borderColor: col(C.ink), borderWidth: 1.1, borderOpacity: 0.8 });

  // сургучная печать
  const cx = 150, cy = 150, R = 44;
  let path = "";
  for (let i = 0; i <= 40; i++) {
    const a = (i / 40) * Math.PI * 2, rr = R + (r() - 0.5) * 6 + Math.sin(a * 5) * 1.5;
    path += (i ? " L " : "M ") + (Math.cos(a) * rr).toFixed(2) + " " + (Math.sin(a) * rr).toFixed(2);
  }
  page.drawSvgPath(path + " Z", { x: cx + 2, y: cy - 3, color: col(C.waxDark), opacity: 0.35 });
  page.drawSvgPath(path + " Z", { x: cx, y: cy, color: col(C.wax) });
  page.drawCircle({ x: cx, y: cy, size: R - 10, borderColor: col(C.waxDark), borderWidth: 1.6, opacity: 0 });
  page.drawCircle({ x: cx - 12, y: cy + 14, size: 9, color: rgb(1, 1, 1), opacity: 0.12 });
  const seal = "Д. М.", sls = 21;
  const slw = serifBold.widthOfTextAtSize(seal, sls);
  const ang = -12 * Math.PI / 180;
  page.drawText(seal, {
    x: cx - (slw / 2) * Math.cos(ang) + (sls * 0.35) * Math.sin(ang),
    y: cy - (slw / 2) * Math.sin(ang) - (sls * 0.35) * Math.cos(ang),
    size: sls, font: serifBold, color: col(C.waxText), rotate: degrees(-12),
  });

  // подпись внизу
  const foot = "Письмо доставлено почтой Деда Мороза";
  page.drawText(foot, { x: (W - sans.widthOfTextAtSize(foot, 7.5)) / 2, y: 52, size: 7.5, font: sans, color: col(C.muted), opacity: 0.8 });

  return await doc.save();
}
