export type Lang = "en" | "de" | "fr" | "unknown";

const STOP: Record<Exclude<Lang, "unknown">, Set<string>> = {
  en: new Set(["the", "and", "with", "for", "of", "is", "in", "to", "a", "this", "not", "made", "from", "bring", "below", "indoors", "hole"]),
  de: new Set(["der", "die", "das", "und", "mit", "für", "aus", "ist", "nicht", "ein", "eine", "im", "bei", "unter", "von", "zu", "auf", "handgefertigt", "frostfest", "frostbeständig", "topf", "hergestellt"]),
  fr: new Set(["le", "la", "les", "et", "avec", "pour", "de", "du", "des", "est", "pas", "un", "une", "en", "sous", "fait", "main", "pot"]),
};

/** Stop-word language guess; deterministic and good enough for short supplier cells. */
export function detectLanguage(text: string): Lang {
  const words = text.toLowerCase().match(/[a-zäöüßàâçéèêëîïôûùüÿœ]+/g) ?? [];
  if (words.length < 3) return "unknown";
  const scores = { en: 0, de: 0, fr: 0 };
  for (const w of words) {
    for (const lang of ["en", "de", "fr"] as const) if (STOP[lang].has(w)) scores[lang]++;
  }
  if (/[äöüß]/.test(text)) scores.de += 2;
  if (/[àâçèêëîïôûœ]/.test(text)) scores.fr += 2;
  const ranked = (Object.entries(scores) as Array<[Exclude<Lang, "unknown">, number]>).sort((a, b) => b[1] - a[1]);
  const [top, second] = ranked;
  if (!top || top[1] === 0 || (second && top[1] === second[1])) return "unknown";
  return top[0];
}
