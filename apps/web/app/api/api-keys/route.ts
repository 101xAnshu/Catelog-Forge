import { NextResponse } from "next/server";
import { z } from "zod";
import { apiKeys, hashToken, newToken } from "@cf/db";
import { web } from "@/lib/db";
import { HttpError, withStore } from "@/lib/http";

export const runtime = "nodejs";

/** Creates an API key; the plaintext is returned exactly once and only its hash is stored. */
export const POST = withStore(async (req, ctx) => {
  if (ctx.via !== "session") throw new HttpError(403, "FORBIDDEN", "API keys can only be created from the dashboard.");
  const { name } = z.object({ name: z.string().min(1).max(60) }).parse(await req.json());
  const key = newToken("cf_");
  const [row] = await web()
    .db.insert(apiKeys)
    .values({ storeId: ctx.storeId, name, keyHash: hashToken(key), prefix: key.slice(0, 8) })
    .returning({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, createdAt: apiKeys.createdAt });
  return NextResponse.json({ ...row, key }, { status: 201 });
});
