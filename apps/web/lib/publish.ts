import { publishProduct } from "@cf/db";
import { web } from "./db";

/**
 * Re-snapshots products into storefront_products (approved → published, anything else → removed).
 * Callers have already scoped `productIds` to the store; publishing is shared with the worker via @cf/db.
 */
export async function republish(_storeId: string, productIds: string[]): Promise<void> {
  for (const id of productIds) await publishProduct(web().db, id);
}
