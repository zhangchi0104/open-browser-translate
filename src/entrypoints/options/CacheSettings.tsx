import { useEffect, useState } from "react";
import { background } from "@/lib/background";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** The caches live in the background's IndexedDB, so their size and clearing go through messages; clearing empties translations and analysis. */
export function CacheSettings() {
  const [count, setCount] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });
  const refresh = () => background.request({ type: "cache-stats" }).then(
    (response) => response.status === "ok" ? setCount(response.count) : setStatus({ text: "无法读取缓存。", error: true }),
    () => setStatus({ text: "无法读取缓存。", error: true }),
  );
  useEffect(() => { void refresh(); }, []);

  async function clear() {
    setBusy(true);
    try {
      const response = await background.request({ type: "cache-clear" });
      if (response.status !== "ok") throw new Error(response.status);
      setStatus({ text: "缓存已清空" });
      await refresh();
    } catch {
      setStatus({ text: "清空失败，请重试。", error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardContent className="space-y-4">
        <div>
          <p className="text-[28px] leading-tight font-semibold tabular-nums">{count ?? "—"}</p>
          <p className="mt-1 text-[13px] text-muted-foreground">段已缓存的译文</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" size="sm" onClick={clear} disabled={busy || !count}>清空缓存</Button>
          <span role="status" aria-live="polite" className={cn("text-[13px]", status.error ? "text-destructive" : "text-success")}>{status.text}</span>
        </div>
      </CardContent>
    </Card>
  );
}
