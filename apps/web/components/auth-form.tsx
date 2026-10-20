"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    const body = Object.fromEntries(form.entries());
    const res = await fetch(`/api/auth/${mode}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      router.replace(params.get("next") ?? "/upload");
      router.refresh();
      return;
    }
    const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    setError(data?.error?.message ?? "Something went wrong");
    setBusy(false);
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4 rounded-xl border border-border bg-surface p-6 shadow-sm">
        <div>
          <h1 className="text-xl font-semibold">CatalogForge</h1>
          <p className="text-sm text-muted">{mode === "login" ? "Sign in to your store" : "Create your store"}</p>
        </div>
        {mode === "signup" && (
          <label className="block text-sm">
            Store name
            <input name="storeName" required minLength={2} className="input mt-1" placeholder="Green Thumb Supplies" />
          </label>
        )}
        <label className="block text-sm">
          Email
          <input name="email" type="email" required autoComplete="email" className="input mt-1"
            defaultValue={mode === "login" ? "demo@catalogforge.dev" : ""} />
        </label>
        <label className="block text-sm">
          Password
          <input name="password" type="password" required minLength={mode === "signup" ? 8 : 1}
            autoComplete={mode === "login" ? "current-password" : "new-password"} className="input mt-1"
            defaultValue={mode === "login" ? "demo1234" : ""} />
        </label>
        {mode === "signup" && (
          <label className="block text-sm">
            Currency
            <select name="currency" className="input mt-1" defaultValue="EUR">
              <option>EUR</option><option>GBP</option><option>USD</option><option>CHF</option>
            </select>
          </label>
        )}
        {error && <p role="alert" className="text-sm text-bad">{error}</p>}
        <button disabled={busy} className="btn-primary w-full">{busy ? "…" : mode === "login" ? "Sign in" : "Create store"}</button>
        <p className="text-center text-sm text-muted">
          {mode === "login" ? (
            <>No account? <Link className="text-accent underline" href="/signup">Create a store</Link></>
          ) : (
            <>Have an account? <Link className="text-accent underline" href="/login">Sign in</Link></>
          )}
        </p>
        {mode === "login" && <p className="text-center text-xs text-muted">Demo: demo@catalogforge.dev / demo1234</p>}
      </form>
    </div>
  );
}
