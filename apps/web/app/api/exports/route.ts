import { exportStream, type ExportFormat } from "@/lib/export";
import { parseProductQuery } from "@/lib/products";
import { withStore } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withStore(async (req, ctx) => {
  const url = new URL(req.url);
  const format = (["csv", "json", "shopify"] as const).find((f) => f === url.searchParams.get("format")) ?? ("csv" as ExportFormat);
  const filters = parseProductQuery(url);
  const appUrl = process.env.APP_URL ?? url.origin;
  const stamp = new Date().toISOString().slice(0, 10);
  const name = format === "json" ? `catalog-${stamp}.json` : format === "shopify" ? `shopify-products-${stamp}.csv` : `catalog-${stamp}.csv`;
  return new Response(exportStream(ctx.storeId, format, filters, appUrl), {
    headers: {
      "content-type": format === "json" ? "application/json; charset=utf-8" : "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "no-store",
    },
  });
}, { allowApiKey: true });
