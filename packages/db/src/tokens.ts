import { createHash, randomBytes } from "node:crypto";

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");
export const newToken = (prefix = ""): string => `${prefix}${randomBytes(24).toString("hex")}`;
export const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
