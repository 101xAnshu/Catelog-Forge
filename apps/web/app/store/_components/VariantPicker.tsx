"use client";

import { useMemo, useState } from "react";

export interface PickerVariant {
  sku: string | null;
  options: Record<string, string>;
  price: string | null;
}

export function VariantPicker({
  optionNames,
  optionLabels,
  variants,
  labels,
}: {
  optionNames: string[];
  optionLabels: Record<string, string>;
  variants: PickerVariant[];
  labels: { addToCart: string; unavailable: string };
}) {
  const [selected, setSelected] = useState<Record<string, string>>(() => ({ ...(variants[0]?.options ?? {}) }));
  const values = useMemo(
    () => Object.fromEntries(optionNames.map((n) => [n, [...new Set(variants.map((v) => v.options[n]).filter((x): x is string => !!x))]])),
    [optionNames, variants],
  );
  const current = variants.find((v) => optionNames.every((n) => (v.options[n] ?? "") === (selected[n] ?? ""))) ?? null;

  return (
    <div className="space-y-5">
      <p className="text-2xl font-semibold tracking-tight">{current?.price ?? <span className="text-muted">{labels.unavailable}</span>}</p>
      {optionNames.map((name) => (
        <fieldset key={name}>
          <legend className="mb-2 text-sm font-medium text-muted">{optionLabels[name] ?? name}</legend>
          <div className="flex flex-wrap gap-2">
            {(values[name] ?? []).map((value) => {
              const active = selected[name] === value;
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setSelected((s) => ({ ...s, [name]: value }))}
                  className={`min-h-11 rounded-full border px-4 text-sm capitalize transition ${
                    active ? "border-text bg-text text-bg" : "border-border bg-surface hover:border-text"
                  }`}
                >
                  {value}
                </button>
              );
            })}
          </div>
        </fieldset>
      ))}
      <button
        type="button"
        disabled={!current?.price}
        className="min-h-12 w-full rounded-full bg-accent px-6 text-base font-medium text-accent-fg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {current?.price ? labels.addToCart : labels.unavailable}
      </button>
      {current?.sku && <p className="text-xs text-muted">SKU {current.sku}</p>}
    </div>
  );
}
