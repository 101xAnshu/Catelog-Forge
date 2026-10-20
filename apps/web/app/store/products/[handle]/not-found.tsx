import Link from "next/link";

export default function ProductNotFound() {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-2xl font-semibold">Product not available</h1>
      <p className="text-muted">This product doesn&apos;t exist or isn&apos;t published yet.</p>
      <Link href="/store" className="rounded-full bg-accent px-5 py-2.5 text-accent-fg">Back to shop</Link>
    </main>
  );
}
