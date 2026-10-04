import { useEffect, useState } from "react";
import { background } from "@/lib/background";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SettingsGroup, SettingsRow } from "./SettingsList";

/** The caches live in the background's IndexedDB, so their size and clearing go through messages; clearing empties translations and analysis. */
export function CacheSettings() {
  const [count, setCount] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; tone?: "error" | "success" }>({ text: "" });
  const refresh = () => background.request({ type: "cache-stats" }).then(
    (response) => response.status === "ok" ? setCount(response.count) : setStatus({ text: "无法读取缓存。", tone: "error" }),
    () => setStatus({ text: "无法读取缓存。", tone: "error" }),
  );
  useEffect(() => { void refresh(); }, []);

  async function clear() {
    setBusy(true);
    try {
      const response = await background.request({ type: "cache-clear" });
      if (response.status !== "ok") throw new Error(response.status);
      setStatus({ text: "缓存已清空", tone: "success" });
      await refresh();
    } catch {
      setStatus({ text: "清空失败，请重试。", tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsGroup footer={<>
      <p>缓存按站点、模型和原文区分，换了模型会重新翻译。原文只存哈希，译文保存在本机；无痕窗口不使用缓存。</p>
      <p role="status" aria-live="polite" className={cn("mt-2", status.tone === "error" ? "text-destructive" : "text-success")}>{status.text}</p>
    </>}>
      <SettingsRow label="已缓存的译文" description={count === undefined ? "正在读取…" : count ? `共 ${count.toLocaleString("zh-CN")} 段` : "还没有缓存"}>
        <Button type="button" variant="outline" size="sm" onClick={clear} disabled={busy || !count}>清空缓存</Button>
      </SettingsRow>
    </SettingsGroup>
  );
}
