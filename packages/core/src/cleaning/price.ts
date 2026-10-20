import { issue, type Issue } from "./issues";

export interface Money {
  cents: number;
  currency: string;
}

export interface PriceResult {
  money: Money | null;
  issues: Issue[];
}

const SYMBOLS: Array<[RegExp, string]> = [
  [/€|\bEUR\b|\bEuro?s?\b/i, "EUR"],
  [/£|\bGBP\b/i, "GBP"],
  [/\bCHF\b|\bFr\.\s?/i, "CHF"],
  [/US\$|\bUSD\b/i, "USD"],
  [/CA\$|C\$|\bCAD\b/i, "CAD"],
  [/A\$|\bAUD\b/i, "AUD"],
  [/\bSEK\b/i, "SEK"],
  [/\bDKK\b/i, "DKK"],
  [/\bNOK\b/i, "NOK"],
  [/\bPLN\b|zł/i, "PLN"],
];

const MAX_CENTS = 100_000_000; // 1,000,000.00

export function normalizeCurrencyCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  for (const [re, code] of SYMBOLS) if (re.test(s)) return code;
  if (/^\$$/.test(s)) return null;
  return /^[A-Za-z]{3}$/.test(s) ? s.toUpperCase() : null;
}

/**
 * Parses a supplier price into integer cents + ISO currency using string math only.
 * Handles `1.299,00 €`, `1,299.00`, `12.5`, `£8`, `EUR 12`, `12,-`, `1 299,00`, `1'299.00`.
 */
export function parsePrice(
  input: string | number | null | undefined,
  opts: { currencyHint?: string | null; defaultCurrency: string; field?: string },
): PriceResult {
  const field = opts.field ?? "price";
  const issues: Issue[] = [];
  if (input === null || input === undefined || String(input).trim() === "") {
    return { money: null, issues: [issue("PRICE_MISSING", "error", "Price is missing", { field })] };
  }
  const original = String(input).trim();

  let currency = normalizeCurrencyCode(opts.currencyHint ?? null);
  if (!currency) {
    for (const [re, code] of SYMBOLS) {
      if (re.test(original)) {
        currency = code;
        break;
      }
    }
  }
  if (!currency && original.includes("$")) {
    currency = opts.defaultCurrency;
    issues.push(
      issue("CURRENCY_AMBIGUOUS", "warn", `"$" is ambiguous, assumed ${currency}`, { field, original }),
    );
  }
  if (!currency) currency = opts.defaultCurrency;

  let s = original
    .replace(/[A-Za-z€£$¥zł]/g, "")
    .replace(/[\s '’]/g, "")
    .replace(/[.,]-+$/, "")
    .replace(/^[^\d\-+]+|[^\d]+$/g, "");

  const negative = s.startsWith("-");
  s = s.replace(/^[-+]/, "");

  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) {
    return {
      money: null,
      issues: [...issues, issue("PRICE_UNPARSEABLE", "error", `Could not read price "${original}"`, { field, original })],
    };
  }

  const lastSep = Math.max(s.lastIndexOf("."), s.lastIndexOf(","));
  let intPart = s;
  let fracPart = "";
  if (lastSep >= 0) {
    const sep = s[lastSep];
    const after = s.slice(lastSep + 1);
    const otherSepPresent = s.slice(0, lastSep).replaceAll(sep as string, "").match(/[.,]/) !== null;
    const sameSepCount = s.split(sep as string).length - 1;
    // Rightmost separator followed by 1–2 digits is the decimal mark; 3 digits means thousands.
    if (after.length === 1 || after.length === 2) {
      intPart = s.slice(0, lastSep);
      fracPart = after;
    } else if (after.length === 3) {
      if (sameSepCount === 1 && !otherSepPresent) {
        issues.push(
          issue("PRICE_SEPARATOR_AMBIGUOUS", "warn", `"${original}" read as ${s.replace(/[.,]/g, "")} (thousands separator)`, {
            field,
            original,
          }),
        );
      }
      intPart = s;
    } else if (after.length === 0) {
      intPart = s.slice(0, lastSep);
    } else {
      return {
        money: null,
        issues: [...issues, issue("PRICE_UNPARSEABLE", "error", `Could not read price "${original}"`, { field, original })],
      };
    }
  }
  intPart = intPart.replace(/[.,]/g, "");
  if (!/^\d+$/.test(intPart || "0")) {
    return {
      money: null,
      issues: [...issues, issue("PRICE_UNPARSEABLE", "error", `Could not read price "${original}"`, { field, original })],
    };
  }
  const cents = Number(intPart || "0") * 100 + Number(fracPart.padEnd(2, "0") || "0");

  if (negative) {
    return { money: null, issues: [...issues, issue("PRICE_NEGATIVE", "error", `Negative price "${original}"`, { field, original })] };
  }
  if (cents === 0) {
    return { money: null, issues: [...issues, issue("PRICE_ZERO", "error", "Price is zero", { field, original })] };
  }
  if (cents > MAX_CENTS) {
    return {
      money: null,
      issues: [...issues, issue("PRICE_IMPLAUSIBLE", "error", `Price "${original}" is implausibly high`, { field, original })],
    };
  }
  return { money: { cents, currency }, issues };
}

export function formatMoney(cents: number, currency: string, locale = "en"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(cents / 100);
}
