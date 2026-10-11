import { useEffect, useState } from "react";
import { background } from "@/lib/background";
import type { ChatGPTModel, Request } from "../modules/shared/protocol";

/** A connection's model catalog; `unavailable` until there is an account, key or address to ask with. */
export type Catalog = { status: "unavailable" | "loading" | "failed" } | { status: "ok"; models: readonly ChatGPTModel[] };
export interface LoadedCatalog { catalog: Catalog; reload: () => void }

/**
 * Asks the background for a model catalog with `request` (nothing to ask with when undefined),
 * waiting `delay` ms so typing a key doesn't fire a request per keystroke.
 */
export function useCatalog(request: Request<"chatgpt-models" | "openai-models" | "gateway-models" | "anthropic-models" | "openrouter-models" | "connection-models"> | undefined, delay = 0): LoadedCatalog {
  const [catalog, setCatalog] = useState<Catalog>({ status: "unavailable" });
  const [attempt, setAttempt] = useState(0);
  // The request is a new object each render; its JSON says when it actually changed.
  const key = request && JSON.stringify(request);
  useEffect(() => {
    if (!request) return setCatalog({ status: "unavailable" });
    let current = true;
    setCatalog({ status: "loading" });
    const timer = setTimeout(() => background.request(request).then(
      (response) => {
        if (!current) return;
        setCatalog(response.status === "ok" ? { status: "ok", models: response.models }
          : response.status === "no-key" ? { status: "unavailable" } : { status: "failed" });
      },
      () => { if (current) setCatalog({ status: "failed" }); },
    ), delay);
    return () => { current = false; clearTimeout(timer); };
  }, [key, attempt, delay]);
  return { catalog, reload: () => setAttempt((n) => n + 1) };
}
