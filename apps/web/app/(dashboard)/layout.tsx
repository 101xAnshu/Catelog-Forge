import { Nav } from "@/components/nav";
import { Providers } from "@/components/providers";
import { requireStore } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireStore();
  const demo = !process.env.GROQ_API_KEY || process.env.AI_PROVIDER === "fake";
  return (
    <Providers>
      <Nav stores={ctx.stores} storeId={ctx.storeId} email={ctx.email} />
      {demo && (
        <div className="border-b border-warn/30 bg-warn/10 px-4 py-2 text-center text-sm text-warn">
          Demo mode: no GROQ_API_KEY is set, so products are built by the deterministic fake AI provider. Add a key to <code>.env</code> to use real models.
        </div>
      )}
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
    </Providers>
  );
}
