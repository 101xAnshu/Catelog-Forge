import { NextResponse, type NextRequest } from "next/server";

const PUBLIC = [/^\/login/, /^\/signup/, /^\/store/, /^\/api\//, /^\/_next/, /^\/favicon/, /^\/docs/];

/** Cheap gate on cookie presence; the real session check happens server-side. */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC.some((re) => re.test(pathname))) return NextResponse.next();
  if (!req.cookies.get("cf_session")) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

// API routes authenticate themselves; keeping them out of middleware also avoids Next's 10 MB
// middleware body cap, which truncated photo ZIP uploads ("expected boundary after body").
export const config = { matcher: ["/((?!api/|_next/static|_next/image|favicon.ico).*)"] };
