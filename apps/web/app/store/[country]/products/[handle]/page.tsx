import { permanentRedirect } from "next/navigation";
import { legacyStoreUrl } from "@/lib/storefront/legacy";

export default async function LegacyProduct({ params, searchParams }: {
  params: Promise<{ country: string; handle: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ country, handle }, sp] = await Promise.all([params, searchParams]);
  permanentRedirect(legacyStoreUrl(`/store/products/${encodeURIComponent(handle)}`, country, sp));
}
