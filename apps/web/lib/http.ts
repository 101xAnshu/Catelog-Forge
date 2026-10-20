import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { getStoreContext, type StoreContext } from "./auth";

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export function errorResponse(status: number, code: string, message: string, details?: unknown) {
  return NextResponse.json({ error: { code, message, details } }, { status });
}

type Handler<P> = (req: Request, ctx: StoreContext, params: P) => Promise<Response>;

/** Wraps a route handler with store resolution and uniform JSON errors. */
export function withStore<P = Record<string, string>>(handler: Handler<P>, opts: { allowApiKey?: boolean } = {}) {
  return async (req: Request, route: { params: Promise<P> }): Promise<Response> => {
    try {
      const ctx = await getStoreContext(opts);
      if (!ctx) return errorResponse(401, "UNAUTHORIZED", "Sign in or pass a valid API key.");
      return await handler(req, ctx, await route.params);
    } catch (err) {
      if (err instanceof HttpError) return errorResponse(err.status, err.code, err.message, err.details);
      if (err instanceof ZodError) return errorResponse(400, "INVALID_INPUT", "Invalid request", err.flatten());
      console.error("[api]", err);
      return errorResponse(500, "INTERNAL", "Something went wrong. Please retry.");
    }
  };
}
