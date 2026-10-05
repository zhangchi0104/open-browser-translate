import { useEffect, useState } from "react";
import { background } from "@/lib/background";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CACHE_TTL, MAX_CACHE_ENTRIES } from "@/modules/background/cache-store";
import type { Response } from "@/modules/shared/protocol";
import { SettingsGroup, SettingsRow } from "./SettingsList";

type Stats = Extract<Response<"cache-stats">, { status: "ok" }>;

/** Sites shown before "show all". */
const SITES_SHOWN = 8;

const number = (value: number) => value.toLocaleString("zh-CN");

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const relative = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });
/** `time` against now, in the largest unit that fits: "3 分钟前", "2 天后". */
function fromNow(time: number) {
  const seconds = (time - Date.now()) / 1000;
  for (const [unit, size] of [["day", 86_400], ["hour", 3600], ["minute", 60]] as const) {
    if (Math.abs(seconds) >= size) return relative.format(Math.trunc(seconds / size), unit);
  }
  return "刚刚";
}

const hostOf = (origin: string) => {
  try {
    const url = new URL(origin);
    return url.protocol === "https:" ? url.host : origin;
  } catch {
    return origin;
  }
};

/** The caches live in the background's IndexedDB, so their size and clearing go through messages; clearing empties translations and analysis. */
export function CacheSettings() {
  const [stats, setStats] = useState<Stats>();
  const [allSites, setAllSites] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; tone?: "error" | "success" }>({ text: "" });
  const refresh = () => background.request({ type: "cache-stats" }).then(
    (response) => response.status === "ok" ? setStats(response) : setStatus({ text: "无法读取缓存。", tone: "error" }),
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

  const summary = !stats ? "正在读取…" : stats.count
    ? `${number(stats.count)} 段，约 ${formatBytes(stats.bytes)} · 上限 ${number(MAX_CACHE_ENTRIES)} 段，满了先删最久没用的`
    : "还没有缓存";
  const sites = stats && (allSites ? stats.sites : stats.sites.slice(0, SITES_SHOWN));

  return (
    <div className="space-y-6">
      <SettingsGroup footer={<>
        <p>缓存按站点、模型和原文区分，换了模型会重新翻译。原文只存哈希，译文保存在本机；无痕窗口不使用缓存。</p>
        <p role="status" aria-live="polite" className={cn("mt-2", status.tone === "error" ? "text-destructive" : "text-success")}>{status.text}</p>
      </>}>
        <SettingsRow label="已缓存的译文" description={summary}>
          <Button type="button" variant="outline" size="sm" onClick={clear} disabled={busy || !(stats?.count || stats?.analyses)}>清空缓存</Button>
        </SettingsRow>
        {stats?.oldest !== undefined && (
          <SettingsRow label="最早的一段" description={`${fromNow(stats.oldest)}保存，${fromNow(stats.oldest + CACHE_TTL)}过期`} />
        )}
        {!!stats?.analyses && (
          <SettingsRow label="页面分析" description={`${number(stats.analyses)} 段的分类结果，清空缓存时一并删除`} />
        )}
      </SettingsGroup>

      {stats && sites && sites.length > 0 && (
        <SettingsGroup title="按站点" description={`${number(stats.sites.length)} 个站点，按段数排列`}>
          {sites.map((site) => (
            <SettingsRow key={site.origin} label={<span className="break-all">{hostOf(site.origin)}</span>} description={`最近使用：${fromNow(site.usedAt)}`}>
              <span className="text-[13px] text-muted-foreground tabular-nums">{number(site.count)} 段 · {formatBytes(site.bytes)}</span>
            </SettingsRow>
          ))}
          {stats.sites.length > SITES_SHOWN && (
            <div className="px-4 py-2">
              <Button type="button" variant="ghost" size="sm" className="-ml-2 text-muted-foreground" onClick={() => setAllSites(!allSites)}>
                {allSites ? "收起" : `显示全部 ${number(stats.sites.length)} 个站点`}
              </Button>
            </div>
          )}
        </SettingsGroup>
      )}
    </div>
  );
}
