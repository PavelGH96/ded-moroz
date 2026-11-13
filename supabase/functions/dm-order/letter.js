// Текст письма от Деда Мороза. Один и тот же текст на сайте (предпросмотр), в PDF и в Telegram.
// Кусочки { t: текст, em: true } отмечают то, что вписали родители: на сайте они подсвечены,
// в PDF печатаются теми же чернилами, что и остальной текст.

export function years(n) {
  n = parseInt(n, 10);
  if (!n || n < 1 || n > 17) return "";
  const a = n % 10, b = n % 100;
  const w = a === 1 && b !== 11 ? "год" : a >= 2 && a <= 4 && (b < 12 || b > 14) ? "года" : "лет";
  return n + " " + w;
}

const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const dropDot = (s) => s.replace(/[.!…]+$/, "");

export function buildLetter(d) {
  const girl = d.gender === "f";
  const g = (f, m) => (girl ? f : m);
  const name = cap(clean(d.name));
  const praise = dropDot(clean(d.praise)) || g("очень старалась и радовала родных", "очень старался и радовал родных");
  const wish = dropDot(clean(d.wish));
  const gift = dropDot(clean(d.gift));
  const n = parseInt(d.age, 10);
  const age = years(n);

  const greeting = name
    ? [{ t: "Здравствуй, " + g("дорогая", "дорогой") + " " }, { t: name, em: true }, { t: "!" }]
    : [{ t: g("Здравствуй, моя юная подруга!", "Здравствуй, мой юный друг!") }];

  const p = [];
  p.push([{ t: "Пишу тебе из Великого Устюга. За окном метёт метель, а в моей мастерской помощники заворачивают последние подарки и спорят, у кого бантик красивее." }]);
  p.push([{ t: "Этой ночью я заглянул к тебе. Ты так сладко " + g("спала", "спал") + ", что я не стал тебя будить и ушёл на цыпочках, чтобы не скрипнула ни одна половица." }]);
  const praisePara = [];
  if (age) {
    const big = n <= 7 ? g("совсем большая девочка", "совсем большой мальчик") : g("совсем взрослая", "совсем взрослый");
    praisePara.push({ t: "Тебе уже " }, { t: age, em: true }, { t: " — " + big + "! " });
  }
  praisePara.push({ t: "Мои помощники-снегири весь год присматривали за тобой и рассказали, что ты " }, { t: praise, em: true }, { t: ". Я очень тобой горжусь!" });
  p.push(praisePara);
  if (wish) p.push([{ t: "В новом году у меня к тебе маленькая просьба: постарайся " }, { t: wish, em: true }, { t: ". Я верю, что у тебя обязательно получится." }]);
  p.push(gift
    ? [{ t: "А про твоё желание я помню: " }, { t: gift, em: true }, { t: ". Загляни утром под ёлку!" }]
    : [{ t: "А твой подарок уже ждёт тебя под ёлкой." }]);
  p.push([{ t: "Расти " + g("доброй", "добрым") + ", береги родных и всегда верь в чудеса." }]);

  return { greeting, paragraphs: p, closing: "С любовью,", signature: "Дед Мороз" };
}

export function letterPlain(d) {
  const l = buildLetter(d);
  const text = (runs) => runs.map((r) => r.t).join("");
  return [text(l.greeting), ...l.paragraphs.map(text), l.closing + " твой " + l.signature].join("\n");
}
