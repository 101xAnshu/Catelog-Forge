import { publishProduct as publishWithDb } from "@cf/db";
import { wdb } from "./db";

export const publishProduct = (productId: string) => publishWithDb(wdb().db, productId);
