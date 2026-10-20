const MOJIBAKE = /Ã[\u0080-¿]|Â[\u0080-¿ ]|â€[\u0080-¿™œ�“”˜]|Ã¼|Ã¶|Ã¤|ÃŸ/;

/** Decodes a file buffer: UTF-8 when valid (BOM stripped), otherwise Windows-1252. */
export function decodeText(buf: Uint8Array): { text: string; encoding: "utf-8" | "windows-1252" } {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return { text: text.replace(/^﻿/, ""), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(buf), encoding: "windows-1252" };
  }
}

function junkScore(s: string): number {
  return (s.match(/[ÃÂâ€�]/g) ?? []).length;
}

/** Repairs UTF-8 text that was decoded as Latin-1 (`GrÃ¶ÃŸe` → `Größe`). Returns null when nothing changed. */
export function fixMojibake(s: string): string | null {
  if (!MOJIBAKE.test(s)) return null;
  let current = s;
  for (let i = 0; i < 2; i++) {
    const bytes = Uint8Array.from(Array.from(current, (ch) => {
      const code = ch.charCodeAt(0);
      return code <= 0xff ? code : CP1252_REVERSE.get(code) ?? 0x3f;
    }));
    let repaired: string;
    try {
      repaired = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      break;
    }
    if (junkScore(repaired) >= junkScore(current)) break;
    current = repaired;
  }
  return current === s ? null : current;
}

// Windows-1252 code points 0x80–0x9F that differ from Latin-1.
const CP1252_REVERSE = new Map<number, number>([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85], [0x2020, 0x86],
  [0x2021, 0x87], [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c],
  [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95],
  [0x2013, 0x96], [0x2014, 0x97], [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b],
  [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
]);

/** Cleans a single cell: mojibake repair, NFC, control characters and whitespace. */
export function cleanText(raw: unknown): { value: string; repaired: boolean } {
  if (raw === null || raw === undefined) return { value: "", repaired: false };
  let s = String(raw);
  const fixed = fixMojibake(s);
  if (fixed !== null) s = fixed;
  s = s
    .normalize("NFC")
    .replace(/^﻿/, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
  return { value: s, repaired: fixed !== null };
}
