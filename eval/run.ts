/**
 * Evaluation harness: runs the real pipeline (clean → group → prompt → AI → guards) over the
 * hand-labelled set and scores each field. Compare prompt versions (A/B) or model tiers.
 *
 *   bun run eval                                  # default prompt, auto routing
 *   bun run eval -- --prompt v1,v2 --tier strong  # A/B prompt versions on the strong model
 *   bun run eval -- --limit 10 --no-save
 *
 * Results are printed and stored in `eval_runs` (shown on the Metrics tab).
 */
import { readFileSync } from "node:fs";
import {
  AiBatchResponseSchema,
  applyGuards,
  buildProductPrompt,
  cleanRow,
  DEFAULT_PROMPT_VERSION,
  detectHeaders,
  groupRows,
  phraseStatus,
  PROMPT_VERSIONS,
  routeModel,
  slugify,
  type ProductGroup,
} from "../packages/core/src/index";
import { costMicros, extractJson, getProvider, RateLimitError, type Tier } from "../packages/ai/src/index";
import { createDb, evalRuns } from "../packages/db/src/index";

interface LabelledItem {
  id: string;
  variant: "clean" | "messy";
  rows: Array<Record<string, string>>;
  expected: {
    titleKeywords: string[];
    category: string;
    attributes: { material: string };
    allowedClaims: string[];
    forbiddenClaims: string[];
  };
}

const args = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const versions = (arg("prompt") ?? DEFAULT_PROMPT_VERSION).split(",").map((v) => v.trim()).filter(Boolean);
const forcedTier = arg("tier") as Tier | "auto" | undefined;
const limit = Number(arg("limit") ?? "0") || undefined;
const save = !args.includes("--no-save");
const verbose = args.includes("--verbose");
const BATCH = 5;

for (const v of versions) {
  if (!PROMPT_VERSIONS[v]) {
    console.error(`Unknown prompt version "${v}". Known: ${Object.keys(PROMPT_VERSIONS).join(", ")}`);
    process.exit(1);
  }
}

const data = JSON.parse(readFileSync(new URL("./labelled.json", import.meta.url), "utf8")) as { headers: string[]; items: LabelledItem[] };
const items = data.items.slice(0, limit);
const header = detectHeaders([data.headers]);

function toGroup(item: LabelledItem): ProductGroup {
  const rows = item.rows.map((r, i) => cleanRow(data.headers.map((h) => r[h] ?? ""), header, i + 2, { defaultCurrency: "EUR" }));
  const groups = groupRows(rows, { defaultCurrency: "EUR" });
  // The labelled rows are one product; if grouping split them, score the largest group (and count the split).
  return groups.sort((a, b) => b.rows.length - a.rows.length)[0] as ProductGroup;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9äöüß ]+/g, " ").replace(/\s+/g, " ").trim();
const mentions = (text: string, phrase: string) => norm(text).includes(norm(phrase));

interface ItemScore {
  jsonValid: number;
  category: number;
  categoryLeaf: number;
  title: number;
  material: number;
  claimPrecision: number | null;
  claimRecall: number;
  hallucinated: number; // forbidden claims that survived the guards
  groupedAsOne: number;
  needsReview: number;
}

async function complete(tier: Tier, system: string, user: string) {
  const provider = getProvider();
  for (let attempt = 1; ; attempt++) {
    try {
      return await provider.complete({ tier, system, user, json: true, maxTokens: 6000 });
    } catch (err) {
      if (err instanceof RateLimitError && attempt <= 8) {
        const wait = Math.min(err.retryAfterMs || 5000, 65_000);
        process.stdout.write(`  rate limited, waiting ${Math.ceil(wait / 1000)}s…\n`);
        await Bun.sleep(wait);
        continue;
      }
      if (attempt < 3) {
        await Bun.sleep(1000 * 2 ** attempt);
        continue;
      }
      throw err;
    }
  }
}

async function runVersion(version: string) {
  const provider = getProvider();
  const scores: ItemScore[] = [];
  let cost = 0;
  let model = "";
  for (let i = 0; i < items.length; i += BATCH) {
    const chunk = items.slice(i, i + BATCH).map((item) => ({ item, group: toGroup(item) }));
    const tier: Tier =
      forcedTier && forcedTier !== "auto" ? forcedTier : chunk.some((c) => routeModel(c.group, { hasPhotos: false }) === "strong") ? "strong" : "cheap";
    const prompt = buildProductPrompt(chunk.map((c) => ({ id: c.item.id, group: c.group })), version);
    let parsed: ReturnType<typeof AiBatchResponseSchema.safeParse> | null = null;
    try {
      const res = await complete(tier, prompt.system, prompt.user);
      model = res.model;
      cost += costMicros(res.model, res.inputTokens, res.outputTokens);
      parsed = AiBatchResponseSchema.safeParse(extractJson(res.text));
    } catch (err) {
      console.error(`  batch ${i / BATCH + 1} failed: ${(err as Error).message}`);
    }
    for (const { item, group } of chunk) {
      const ai = parsed?.success ? parsed.data.products.find((p) => p.id === item.id) : undefined;
      const groupedAsOne = toGroupCount(item) === 1 ? 1 : 0;
      if (!ai) {
        scores.push({ jsonValid: 0, category: 0, categoryLeaf: 0, title: 0, material: 0, claimPrecision: null, claimRecall: 0, hallucinated: 0, groupedAsOne, needsReview: 1 });
        continue;
      }
      const guarded = applyGuards(group, ai, { handle: slugify(ai.title) });
      const out = guarded.output;
      const exp = item.expected;
      const verified = guarded.claims.filter((c) => c.verified).map((c) => c.text);
      const published = [out.title, out.description_html, out.tags.join(" "), Object.values(out.attributes).join(" "), verified.join(" ")].join("\n");
      const leaked = exp.forbiddenClaims.filter((f) => phraseStatus(f, published) === "present");
      const hallucinated = leaked.length;
      if (verbose && leaked.length) console.info(`  ${item.id}: forbidden claim published: ${leaked.join(", ")}\n    ${published.replace(/\n/g, " | ").slice(0, 400)}`);
      const precise = verified.filter((c) => exp.allowedClaims.some((a) => mentions(c, a) || mentions(a, c))).length;
      scores.push({
        jsonValid: 1,
        category: out.category === exp.category ? 1 : 0,
        categoryLeaf: out.category.split(" > ").pop() === exp.category.split(" > ").pop() ? 1 : 0,
        title: exp.titleKeywords.filter((k) => mentions(out.title, k)).length / exp.titleKeywords.length,
        material: mentions(out.attributes.material ?? "", exp.attributes.material) || mentions(exp.attributes.material, out.attributes.material ?? "~") ? 1 : 0,
        claimPrecision: verified.length ? precise / verified.length : null,
        claimRecall: exp.allowedClaims.filter((a) => verified.some((c) => mentions(c, a) || mentions(a, c))).length / exp.allowedClaims.length,
        hallucinated,
        groupedAsOne,
        needsReview: guarded.status === "needs_review" ? 1 : 0,
      });
    }
    process.stdout.write(`  ${version}: ${Math.min(i + BATCH, items.length)}/${items.length}\n`);
  }
  return { version, scores, cost, model: model || provider.modelFor(forcedTier && forcedTier !== "auto" ? forcedTier : "cheap") };
}

function toGroupCount(item: LabelledItem): number {
  const rows = item.rows.map((r, i) => cleanRow(data.headers.map((h) => r[h] ?? ""), header, i + 2, { defaultCurrency: "EUR" }));
  return groupRows(rows, { defaultCurrency: "EUR" }).length;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

const provider = getProvider();
console.info(`Eval: ${items.length} labelled products, provider=${provider.name}, prompts=${versions.join(",")}, tier=${forcedTier ?? "auto"}\n`);

const results = [];
for (const v of versions) results.push(await runVersion(v));

const rows = results.map(({ version, scores, cost, model }) => {
  const fieldScores = {
    json_valid: avg(scores.map((s) => s.jsonValid)),
    category_exact: avg(scores.map((s) => s.category)),
    category_leaf: avg(scores.map((s) => s.categoryLeaf)),
    title_keywords: avg(scores.map((s) => s.title)),
    attributes_material: avg(scores.map((s) => s.material)),
    claim_precision: avg(scores.map((s) => s.claimPrecision).filter((x): x is number => x !== null)),
    claim_recall: avg(scores.map((s) => s.claimRecall)),
    grouping: avg(scores.map((s) => s.groupedAsOne)),
    review_rate: avg(scores.map((s) => s.needsReview)),
  };
  const forbiddenTotal = items.reduce((n, it) => n + it.expected.forbiddenClaims.length, 0);
  const hallucinationRate = forbiddenTotal ? scores.reduce((n, s) => n + s.hallucinated, 0) / forbiddenTotal : 0;
  return { version, model, fieldScores, hallucinationRate, cost };
});

console.info("\n| metric | " + rows.map((r) => `${r.version} (${r.model})`).join(" | ") + " |");
console.info("|---|" + rows.map(() => "---").join("|") + "|");
for (const key of Object.keys(rows[0]?.fieldScores ?? {})) {
  console.info(`| ${key} | ${rows.map((r) => pct(r.fieldScores[key as keyof typeof r.fieldScores])).join(" | ")} |`);
}
console.info(`| hallucinated claims (forbidden terms published) | ${rows.map((r) => pct(r.hallucinationRate)).join(" | ")} |`);
console.info(`| cost (USD) | ${rows.map((r) => `$${(r.cost / 1e6).toFixed(4)}`).join(" | ")} |`);

if (save) {
  const { db, close } = createDb("script");
  try {
    for (const r of rows) {
      await db.insert(evalRuns).values({
        promptVersion: r.version,
        model: r.model,
        provider: provider.name,
        sampleSize: items.length,
        fieldScores: Object.fromEntries(Object.entries(r.fieldScores).map(([k, v]) => [k, Math.round(v * 1000) / 10])),
        hallucinationRate: Math.round(r.hallucinationRate * 10_000),
        costMicros: Math.round(r.cost),
      });
    }
    console.info("\nSaved to eval_runs.");
  } finally {
    await close();
  }
}
