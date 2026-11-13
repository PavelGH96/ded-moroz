// Текст письма от Деда Мороза. Один и тот же код на сайте (предпросмотр) и на сервере (PDF, Telegram).
// Абзацы состоят из кусочков { t: текст, em: true|false }: em отмечает то, что вписали родители.

export function years(n) {
  n = parseInt(n, 10);
  if (!n || n < 1 || n > 17) return "";
  const a = n % 10, b = n % 100;
  const w = a === 1 && b !== 11 ? "год" : a >= 2 && a <= 4 && (b < 12 || b > 14) ? "года" : "лет";
  return n + " " + w;
}

const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

export function buildLetter(d) {
  const girl = d.gender === "f";
  const name = clean(d.name) || (girl ? "моя юная подруга" : "мой юный друг");
  const praise = clean(d.praise) || (girl ? "очень старалась и радовала маму с папой" : "очень старался и радовал маму с папой");
  const wish = clean(d.wish);
  const gift = clean(d.gift);
  const age = years(d.age);

  const p = [];
  p.push([{ t: "Здравствуй, " }, { t: name, em: true }, { t: "!" }]);
  p.push([{ t: "Этой ночью я заглянул к тебе. Ты крепко спишь, и я не стал тебя будить." }]);
  if (age) p.push([{ t: "Тебе уже " }, { t: age, em: true }, { t: girl ? ", совсем большая девочка." : ", совсем большой человек." }]);
  p.push([{ t: "Мне рассказали, что в этом году ты " }, { t: praise, em: true }, { t: ". Я тобой горжусь." }]);
  if (wish) p.push([{ t: "В новом году постарайся " }, { t: wish, em: true }, { t: ". У тебя получится." }]);
  p.push(gift
    ? [{ t: "А про подарок я помню: " }, { t: gift, em: true }, { t: ". Жди под ёлкой." }]
    : [{ t: "А подарок уже лежит в моих санях. Жди под ёлкой." }]);
  return { paragraphs: p, signature: "Твой Дед Мороз" };
}

export function letterPlain(d) {
  const l = buildLetter(d);
  return l.paragraphs.map((p) => p.map((r) => r.t).join("")).join("\n") + "\n" + l.signature;
}
