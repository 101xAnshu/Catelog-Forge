"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

/** Subscribes to /api/events (SSE) and invalidates the affected queries; falls back to polling when SSE drops. */
export function useLiveProgress(): { connected: boolean } {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const es = new EventSource("/api/events");
    const flush = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void qc.invalidateQueries({ queryKey: ["imports"] });
        void qc.invalidateQueries({ queryKey: ["products"] });
      }, 400);
    };
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as { type: string; productId?: string };
        if (msg.type === "hello") return;
        if (msg.productId) void qc.invalidateQueries({ queryKey: ["product", msg.productId] });
        flush();
      } catch {
        /* ignore malformed */
      }
    };
    return () => {
      es.close();
      if (timer) clearTimeout(timer);
    };
  }, [qc]);
  return { connected };
}
