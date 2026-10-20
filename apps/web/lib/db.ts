import { getDb } from "@cf/db";

/** Dashboard/API pool; the storefront uses its own `storefront` pool. */
export const web = () => getDb("web");
