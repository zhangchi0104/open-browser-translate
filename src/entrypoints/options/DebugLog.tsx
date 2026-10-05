import { useEffect, useState } from "react";
import { background } from "@/lib/background";
import { debugLogEntries, formatEntries, type LogEntry, type LogLevel } from "@/modules/shared/debug-log";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { TraceView } from "./TraceView";

type Filter = "all" | "problems" | "error";
const filters: Record<Filter, { label: string; keep: (level: LogLevel) => boolean }> = {
  all: { label: "全部", keep: () => true },
  problems: { label: "警告和错误", keep: (level) => level !== "info" },
  error: { label: "仅错误", keep: (level) => level === "error" },
};
const levelStyles: Record<LogLevel, { label: string; className: string }> = {
  info: { label: "信息", className: "bg-muted text-muted-foreground" },
  warn: { label: "警告", className: "bg-warning-soft text-warning-foreground" },
  error: { label: "错误", className: "bg-destructive/10 text-destructive" },
};
const sourceLabels: Record<LogEntry["source"], string> = { background: "后台", page: "网页" };
const timeFormat = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});

type View = "traces" | "log";
const views: Record<View, string> = { traces: "请求追踪", log: "其他日志" };

/** Translation requests as local OpenTelemetry traces, and the plain log for everything else. */
export function DebugLog() {
  const [view, setView] = useState<View>("traces");
  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="调试数据" className="inline-flex rounded-lg bg-muted p-1">
        {(Object.keys(views) as View[]).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={view === key}
            className={cn("rounded-md px-3 py-1 text-sm", view === key ? "bg-card font-medium shadow-sm" : "text-muted-foreground hover:text-foreground")}
            onClick={() => setView(key)}
          >
            {views[key]}
          </button>
        ))}
      </div>
      {view === "traces" ? <TraceView /> : <LogView />}
      <p className="px-1 text-[12px] leading-relaxed text-muted-foreground">
        数据只保存在本机，保留最近 100 次请求，可导出为 OTLP JSON 交给开发者排查。翻译请求会记录发给模型的提示词、上下文，以及原文和译文；不记录 API key。导出前请留意其中的网页内容。
      </p>
    </div>
  );
}

function LogView() {
  const [entries, setEntries] = useState<LogEntry[]>();
  const [filter, setFilter] = useState<Filter>("all");
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });
  useEffect(() => {
    const apply = (value: LogEntry[] | null) => setEntries(value ?? []);
    debugLogEntries.getValue().then(apply, () => setStatus({ text: "无法读取日志，请刷新页面重试。", error: true }));
    return debugLogEntries.watch(apply);
  }, []);

  const visible = (entries ?? []).filter((entry) => filters[filter].keep(entry.level));
  async function copy() {
    try {
      await navigator.clipboard.writeText(formatEntries(visible));
      setStatus({ text: `已复制 ${visible.length} 条日志` });
    } catch {
      setStatus({ text: "复制失败，请重试。", error: true });
    }
  }
  async function clear() {
    try {
      await background.request({ type: "debug-log-clear" });
      setStatus({ text: "日志已清空" });
    } catch {
      setStatus({ text: "清空失败，请重试。", error: true });
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={filter} onValueChange={(value) => setFilter(value as Filter)}>
          <SelectTrigger className="w-36" aria-label="筛选日志级别">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(filters) as Filter[]).map((key) => <SelectItem key={key} value={key}>{filters[key].label}</SelectItem>)}
          </SelectContent>
        </Select>
        <span className="text-[13px] text-muted-foreground">{entries ? `${visible.length} / ${entries.length} 条` : "正在读取…"}</span>
        <span role="status" aria-live="polite" className={cn("text-[13px]", status.error ? "text-destructive" : "text-success")}>{status.text}</span>
        <div className="ml-auto flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={copy} disabled={!visible.length}>复制</Button>
          <Button type="button" variant="outline" size="sm" className="text-muted-foreground" onClick={clear} disabled={!entries?.length}>清空</Button>
        </div>
      </div>
      <div className="overflow-hidden rounded-xl border bg-card">
          {entries && !visible.length ? (
            <p className="px-5 py-8 text-center text-sm text-muted-foreground">
              {entries.length ? "没有符合筛选条件的日志。" : "暂无日志。登录、读取模型列表和网页端的错误会记在这里；翻译请求见「请求追踪」。"}
            </p>
          ) : (
            <ol className="divide-y">
              {visible.slice().reverse().map((entry, index) => <Row key={`${entry.at}-${index}`} entry={entry} />)}
            </ol>
          )}
      </div>
    </div>
  );
}

function Row({ entry }: { entry: LogEntry }) {
  const level = levelStyles[entry.level];
  const heading = (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
      <time dateTime={new Date(entry.at).toISOString()} className="font-mono text-xs text-muted-foreground tabular-nums">{timeFormat.format(entry.at)}</time>
      <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium", level.className)}>{level.label}</span>
      <span className="text-xs text-muted-foreground">{sourceLabels[entry.source]}</span>
      <span className="min-w-0 text-sm break-words">{entry.event}</span>
    </div>
  );
  const page = entry.page && <p className="mt-1 truncate font-mono text-xs text-muted-foreground" title={entry.page}>{entry.page}</p>;
  if (!entry.detail) return <li className="px-5 py-3">{heading}{page}</li>;
  return (
    <li className="px-5 py-3">
      <details open={entry.level !== "info"}>
        <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">{heading}{page}</summary>
        <pre className="mt-2 max-h-80 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">{entry.detail}</pre>
      </details>
    </li>
  );
}
