import { permanentRedirect } from "next/navigation";
import { legacyStoreUrl } from "@/lib/storefront/legacy";

export default async function LegacyCollection({ params, searchParams }: {
  params: Promise<{ country: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ country }, sp] = await Promise.all([params, searchParams]);
  permanentRedirect(legacyStoreUrl("/store", country, sp));
}
