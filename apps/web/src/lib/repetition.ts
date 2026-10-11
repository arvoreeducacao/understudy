export const REPEAT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const REPEAT_GAP_MS = 60 * 60 * 1000;
export const REPEAT_MIN_TIMES = 3;
export const SIMILARITY_THRESHOLD = 0.5;
const MIN_WORDS = 3;

const STOPWORDS = new Set(
  (
    "the and for with from that this these those you your yours our ours can could would should will please thanks thank just also then than into onto about again " +
    "what when where which who whom how why are was were been being have has had does did doing not but all any some each every more most other such only own same " +
    "too very now there here them they their its it's i'm let lets let's me my mine get got give make made need want like send show tell check look find " +
    "today tomorrow yesterday week weekly day daily month monthly morning afternoon evening " +
    "que para com por uma umas uns dos das nos nas pelo pela pelos pelas como mais mas ser sao foi tem ter isso esse essa este esta aqui ali voce voces meu minha " +
    "seu sua favor obrigado obrigada tambem entao depois antes hoje amanha ontem semana semanal dia diario mes mensal manha tarde noite faz fazer manda mandar " +
    "envia enviar mostra mostrar pega pegar ver olha olhar preciso quero pode poderia"
  ).split(/\s+/),
);

export function askWords(text: string): Set<string> {
  const plain = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ");
  const words = plain
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !/^\d+$/.test(word) && !STOPWORDS.has(word))
    .map((word) => (word.length > 4 ? word.replace(/([^s])s$/, "$1") : word));
  return new Set(words);
}

export function similarity(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export function isSimilarAsk(a: string, b: string, threshold = SIMILARITY_THRESHOLD) {
  const left = askWords(a);
  const right = askWords(b);
  return left.size >= MIN_WORDS && right.size >= MIN_WORDS && similarity(left, right) >= threshold;
}

export type PastAsk = { text: string; at: Date };

export function repeatedAsk(current: string, history: PastAsk[], now = new Date()): { times: number; since: Date } | null {
  const words = askWords(current);
  if (words.size < MIN_WORDS) return null;
  const occasions: Date[] = [now];
  const similar = history
    .filter((past) => now.getTime() - past.at.getTime() <= REPEAT_WINDOW_MS && past.at.getTime() < now.getTime())
    .filter((past) => {
      const other = askWords(past.text);
      return other.size >= MIN_WORDS && similarity(words, other) >= SIMILARITY_THRESHOLD;
    })
    .sort((a, b) => b.at.getTime() - a.at.getTime());
  for (const past of similar) {
    const last = occasions[occasions.length - 1];
    if (last.getTime() - past.at.getTime() >= REPEAT_GAP_MS) occasions.push(past.at);
  }
  if (occasions.length < REPEAT_MIN_TIMES) return null;
  return { times: occasions.length, since: occasions[occasions.length - 1] };
}

export function overlap(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

export function recipeWords(recipe: { title: string; trigger: string; steps: { text: string }[] }) {
  return askWords([recipe.title, recipe.trigger, ...recipe.steps.map((step) => step.text)].join(" "));
}

export function coveredBy(ask: string, recipes: { title: string; trigger: string; steps: { text: string }[] }[], threshold = 0.6) {
  const words = askWords(ask);
  return words.size > 0 && recipes.some((recipe) => overlap(words, recipeWords(recipe)) >= threshold);
}

export function sameTask(a: { title: string; trigger: string; steps: { text: string }[] }, b: { title: string; trigger: string; steps: { text: string }[] }) {
  const left = askWords(a.title);
  const right = askWords(b.title);
  if (left.size && right.size && overlap(left, right) >= 0.75) return true;
  return similarity(recipeWords(a), recipeWords(b)) >= SIMILARITY_THRESHOLD;
}
