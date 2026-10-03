import { useEffect, useState } from "react";
import { background } from "@/lib/background";
import { groupTraces, toOtlpExport, traceSpans, type OtlpSpan, type OtlpValue, type TraceView as Trace } from "@/modules/debug-log";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

type Filter = "all" | "error";
const filters: Record<Filter, string> = { all: "全部请求", error: "仅出错的请求" };
// Readable names for the spans this extension and Effect create; anything else shows its own name.
const spanLabels: Record<string, string> = {
  "prepare-translation": "准备翻译",
  "translate-content": "翻译批次",
  "analyze-content": "内容分析请求",
  "content-analysis": "内容分析",
  translation: "翻译",
  "DecisionModel.decide": "决策模型",
  "LanguageModel.generateObject": "语言模型（结构化输出）",
  "LanguageModel.generateText": "语言模型",
  "http.response.stream": "模型生成（响应流）",
};
const timeFormat = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});

const ms = (nanos: bigint) => Number(nanos / 1000n) / 1000;
function formatDuration(milliseconds: number) {
  if (milliseconds >= 10_000) return `${(milliseconds / 1000).toFixed(1)} s`;
  return milliseconds >= 10 ? `${Math.round(milliseconds)} ms` : `${milliseconds.toFixed(1)} ms`;
}
function display(value: OtlpValue): string {
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.intValue !== undefined) return value.intValue;
  if (value.doubleValue !== undefined) return String(value.doubleValue);
  if (value.boolValue !== undefined) return String(value.boolValue);
  return (value.arrayValue?.values ?? []).map(display).join(", ");
}
const attribute = (span: OtlpSpan, key: string) => {
  const value = span.attributes.find((entry) => entry.key === key)?.value;
  return value && display(value);
};
function spanLabel(span: OtlpSpan) {
  if (span.name.startsWith("http.client")) {
    const host = attribute(span, "server.address")?.replace(/^https?:\/\//, "");
    return `${attribute(span, "http.request.method") ?? "HTTP"} ${host ?? ""}${attribute(span, "url.path") ?? ""}`;
  }
  return spanLabels[span.name] ?? span.name;
}
/** A one-line summary of what a request did, from its root span's attributes. */
function summaryOf(root: OtlpSpan) {
  const parts = [
    attribute(root, "obt.blocks") && `${attribute(root, "obt.blocks")} 段`,
    attribute(root, "obt.translated") && `译出 ${attribute(root, "obt.translated")} 段`,
    attribute(root, "obt.plan.mode") && `模式 ${attribute(root, "obt.plan.mode")}`,
    attribute(root, "gen_ai.request.model"),
  ];
  return parts.filter(Boolean).join(" · ");
}
function tokensOf(span: OtlpSpan) {
  const input = attribute(span, "gen_ai.usage.input_tokens");
  const output = attribute(span, "gen_ai.usage.output_tokens");
  const reasoning = attribute(span, "obt.usage.reasoning_tokens");
  if (!input && !output) return undefined;
  return `${input ?? "?"} → ${output ?? "?"} tokens` + (reasoning ? `（其中推理 ${reasoning}）` : "");
}
/** For a response stream: the share of the span spent before the first output text arrived. */
function waitingShare(span: OtlpSpan) {
  const firstOutput = Number(attribute(span, "obt.stream.first_output_ms"));
  const duration = ms(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano));
  return firstOutput > 0 && duration > 0 ? Math.min(firstOutput / duration, 1) : undefined;
}

export function TraceView() {
  const [spans, setSpans] = useState<OtlpSpan[]>();
  const [filter, setFilter] = useState<Filter>("all");
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });
  useEffect(() => {
    const apply = (value: OtlpSpan[] | null) => setSpans(value ?? []);
    traceSpans.getValue().then(apply, () => setStatus({ text: "无法读取追踪数据，请刷新页面重试。", error: true }));
    return traceSpans.watch(apply);
  }, []);

  const traces = groupTraces(spans ?? []);
  const visible = filter === "error" ? traces.filter((trace) => trace.error) : traces;
  function exportOtlp() {
    const chosen = new Set(visible.map((trace) => trace.traceId));
    const body = toOtlpExport((spans ?? []).filter((span) => chosen.has(span.traceId)), browser.runtime.getManifest().version);
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: "application/json" }));
    link.download = `open-browser-translate-traces-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
    setStatus({ text: `已导出 ${visible.length} 次请求` });
  }
  async function clear() {
    try {
      await background.request({ type: "traces-clear" });
      setStatus({ text: "追踪数据已清空" });
    } catch {
      setStatus({ text: "清空失败，请重试。", error: true });
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={filter} onValueChange={(value) => setFilter(value as Filter)}>
          <SelectTrigger className="w-40" aria-label="筛选请求">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(filters) as Filter[]).map((key) => <SelectItem key={key} value={key}>{filters[key]}</SelectItem>)}
          </SelectContent>
        </Select>
        <span className="text-[13px] text-muted-foreground">{spans ? `${visible.length} / ${traces.length} 次请求` : "正在读取…"}</span>
        <span role="status" aria-live="polite" className={cn("text-[13px]", status.error ? "text-destructive" : "text-success")}>{status.text}</span>
        <div className="ml-auto flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={exportOtlp} disabled={!visible.length}>导出 OTLP JSON</Button>
          <Button type="button" variant="outline" size="sm" className="text-muted-foreground" onClick={clear} disabled={!spans?.length}>清空</Button>
        </div>
      </div>
      <Card className="py-0">
        <CardContent className="px-0">
          {spans && !visible.length ? (
            <p className="px-5 py-8 text-center text-sm text-muted-foreground">
              {traces.length ? "没有出错的请求。" : "暂无追踪数据。点击网页上的翻译按钮后，每次请求的步骤和耗时会显示在这里。"}
            </p>
          ) : (
            <ol className="divide-y">
              {visible.map((trace) => <TraceRow key={trace.traceId} trace={trace} />)}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function TraceRow({ trace }: { trace: Trace }) {
  const [selected, setSelected] = useState<string>();
  const total = trace.end - trace.start;
  const page = attribute(trace.root, "obt.page");
  const summary = summaryOf(trace.root);
  return (
    <li className="px-5 py-3">
      <details open={trace.error}>
        <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            <time className="font-mono text-xs text-muted-foreground tabular-nums">{timeFormat.format(Number(trace.start / 1_000_000n))}</time>
            <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium", trace.error ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground")}>
              {trace.error ? "出错" : "成功"}
            </span>
            <span className="text-sm">{spanLabel(trace.root)}</span>
            <span className="font-mono text-xs text-muted-foreground tabular-nums">{formatDuration(ms(total))}</span>
            {summary && <span className="text-xs text-muted-foreground">{summary}</span>}
          </div>
          {page && <p className="mt-1 truncate font-mono text-xs text-muted-foreground" title={page}>{page}</p>}
        </summary>
        <div className="mt-3 space-y-1" role="list" aria-label="请求步骤">
          {trace.spans.map(({ span, depth }) => {
            const offset = total ? Number(BigInt(span.startTimeUnixNano) - trace.start) / Number(total) : 0;
            const width = total ? Number(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)) / Number(total) : 1;
            const failed = span.status.code === 2;
            const open = selected === span.spanId;
            const tokens = tokensOf(span);
            const waiting = waitingShare(span);
            const firstOutput = attribute(span, "obt.stream.first_output_ms");
            return (
              <div key={span.spanId} role="listitem">
                <button
                  type="button"
                  className="grid w-full grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-3 rounded px-1 py-0.5 text-left hover:bg-muted sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"
                  aria-expanded={open}
                  onClick={() => setSelected(open ? undefined : span.spanId)}
                >
                  <span className="flex min-w-0 flex-col" style={{ paddingInlineStart: `${depth * 14}px` }}>
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className={cn("truncate text-[13px]", failed && "text-destructive")} title={span.name}>{spanLabel(span)}</span>
                      <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
                        {formatDuration(ms(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)))}
                      </span>
                    </span>
                    {firstOutput && (
                      <span className="truncate text-[11px] text-muted-foreground">
                        <span className="text-amber-700">等待 {formatDuration(Number(firstOutput))}</span>
                        {" → 输出 "}{formatDuration(ms(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)) - Number(firstOutput))}
                        {attribute(span, "obt.usage.reasoning_tokens") && ` · 推理 ${attribute(span, "obt.usage.reasoning_tokens")} tokens`}
                      </span>
                    )}
                  </span>
                  <span className="relative h-2.5 rounded-sm bg-muted" aria-hidden="true">
                    <span
                      className={cn("absolute inset-y-0 flex overflow-hidden rounded-sm", failed ? "bg-destructive" : "bg-primary/70")}
                      style={{ left: `${offset * 100}%`, width: `max(${width * 100}%, 2px)` }}
                    >
                      {/* Before the first output text the model is queued or thinking. */}
                      {waiting !== undefined && !failed && <span className="h-full bg-amber-400" style={{ width: `${waiting * 100}%` }} />}
                    </span>
                  </span>
                </button>
                {open && <SpanDetail span={span} tokens={tokens} />}
              </div>
            );
          })}
        </div>
      </details>
    </li>
  );
}

function SpanDetail({ span, tokens }: { span: OtlpSpan; tokens?: string }) {
  return (
    <div className="my-2 space-y-2 rounded-md bg-muted px-3 py-2 text-xs">
      <p className="font-mono text-muted-foreground">{span.name}{tokens && ` · ${tokens}`}</p>
      {span.status.message && <p className="whitespace-pre-wrap break-words text-destructive">{span.status.message}</p>}
      {span.attributes.length > 0 && (
        <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-0.5 font-mono">
          {span.attributes.map(({ key, value }) => (
            <div key={key} className="contents">
              <dt className="text-muted-foreground">{key}</dt>
              <dd className="break-all">{display(value)}</dd>
            </div>
          ))}
        </dl>
      )}
      {span.events.map((event, index) => (
        <div key={index}>
          <p className="font-medium">{event.name}</p>
          <pre className="mt-1 max-h-60 overflow-auto font-mono leading-relaxed whitespace-pre-wrap break-words">
            {event.attributes.map(({ key, value }) => `${key}: ${display(value)}`).join("\n")}
          </pre>
        </div>
      ))}
    </div>
  );
}
