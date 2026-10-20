import type { NextConfig } from "next";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Load the monorepo-root .env so `bun run dev` works without duplicating secrets into apps/web.
const rootEnv = resolve(__dirname, "../../.env");
if (existsSync(rootEnv)) {
  for (const line of readFileSync(rootEnv, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] && process.env[m[1]] === undefined) process.env[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
  }
}
if (process.env.STORAGE_DIR && !process.env.STORAGE_DIR.startsWith("/")) {
  process.env.STORAGE_DIR = resolve(__dirname, "../..", process.env.STORAGE_DIR);
}

const config: NextConfig = {
  transpilePackages: ["@cf/core", "@cf/db", "@cf/queue", "@cf/ai"],
  serverExternalPackages: ["postgres", "bullmq", "ioredis", "sharp"],
  experimental: { serverActions: { bodySizeLimit: "50mb" } },
  typedRoutes: false,
  devIndicators: false,
  webpack(cfg, { isServer }) {
    // bullmq lazily requires this optional Valkey client; we only use ioredis, so never resolve it.
    if (isServer) cfg.externals = [...(Array.isArray(cfg.externals) ? cfg.externals : [cfg.externals]), { "@valkey/valkey-glide": "commonjs @valkey/valkey-glide" }];
    return cfg;
  },
};

export default config;
