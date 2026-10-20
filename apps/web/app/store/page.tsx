import { redirect } from "next/navigation";

export default async function StoreIndex({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const store = typeof sp.store === "string" ? `?store=${encodeURIComponent(sp.store)}` : "";
  redirect(`/store/auto${store}`);
}
