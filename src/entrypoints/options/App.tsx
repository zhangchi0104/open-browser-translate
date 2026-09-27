import { useEffect, useId, useRef, useState, type FormEvent, type RefObject } from "react";
import { ExternalLink } from "lucide-react";
import { aiSettings, validateModel, type AISettings, type SettingsProvider, type AnalysisProvider, type TranslationProvider } from "@/modules/settings";
import { AiProviders } from "@/modules/ai/providers";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

type Purpose = "analysis" | "translation";
type Status = { text: string; error?: boolean };

const providerLabels: Record<SettingsProvider, string> = {
  [AiProviders.VercelAIGateway]: "Vercel AI Gateway",
  [AiProviders.TypeSafe]: "TypeSafe 直连",
  [AiProviders.OpenAIApi]: "OpenAI 直连",
};
const keyLinks: Record<SettingsProvider, string> = {
  [AiProviders.VercelAIGateway]: "https://vercel.com/dashboard",
  [AiProviders.TypeSafe]: "https://console.typesafe.ai",
  [AiProviders.OpenAIApi]: "https://platform.openai.com/api-keys",
};
const purposes = {
  analysis: {
    title: "内容分析 · Jev",
    description: "判断哪些内容需要翻译。",
    modelLabel: "Jev 模型",
    providers: [AiProviders.VercelAIGateway, AiProviders.TypeSafe],
    placeholder: (p: SettingsProvider) => p === AiProviders.VercelAIGateway ? "typesafe-ai/jev" : "jev-latest",
    help: (p: SettingsProvider) => p === AiProviders.VercelAIGateway
      ? "通过 Vercel 调用 Jev，默认模型为 typesafe-ai/jev。"
      : "通过 TypeSafe 调用 Jev，默认模型为 jev-latest。",
  },
  translation: {
    title: "翻译",
    description: "将筛选后的内容生成译文。模型可留空，稍后再配置。",
    modelLabel: "翻译模型",
    providers: [AiProviders.VercelAIGateway, AiProviders.OpenAIApi],
    placeholder: (p: SettingsProvider) => p === AiProviders.VercelAIGateway ? "provider/model" : "模型 ID",
    help: (p: SettingsProvider) => p === AiProviders.VercelAIGateway
      ? "填写网关中的翻译模型 ID，格式为 provider/model。"
      : "填写 OpenAI 的文本生成模型 ID。",
  },
} as const;
const purposeNames: Record<Purpose, string> = { analysis: "内容分析", translation: "翻译" };

// Each purpose keys its models by its own provider subset; this widens them for shared editing code.
function modelsOf(settings: AISettings, purpose: Purpose) {
  return settings[purpose].models as Partial<Record<SettingsProvider, string>>;
}
function setProvider(settings: AISettings, purpose: Purpose, provider: SettingsProvider) {
  if (purpose === "analysis") settings.analysis.provider = provider as AnalysisProvider;
  else settings.translation.provider = provider as TranslationProvider;
}

export function App() {
  const [draft, setDraft] = useState<AISettings>();
  const [active, setActive] = useState<SettingsProvider>(AiProviders.VercelAIGateway);
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<Purpose, string>>>({});
  const [status, setStatus] = useState<Status>({ text: "正在读取设置…" });
  const modelInputs = { analysis: useRef<HTMLInputElement>(null), translation: useRef<HTMLInputElement>(null) };

  useEffect(() => {
    aiSettings.getValue().then((saved) => {
      setDraft(structuredClone(saved));
      setBusy(false);
      setStatus({ text: "" });
    }, () => setStatus({ text: "无法读取设置，请刷新页面重试。", error: true }));
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);

  function edit(change: (next: AISettings) => void) {
    setDraft((current) => {
      const next = structuredClone(current!);
      change(next);
      return next;
    });
    setErrors({});
    setDirty(true);
    setStatus({ text: "有未保存的更改" });
  }
  function selectKeyProvider(provider: SettingsProvider) {
    setActive(provider);
    setShowKey(false);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    const next = structuredClone(draft);
    for (const entry of Object.values(next.providers)) entry.apiKey = entry.apiKey.trim();
    for (const purpose of ["analysis", "translation"] as const) {
      const provider = next[purpose].provider;
      const model = (modelsOf(next, purpose)[provider] ?? "").trim();
      modelsOf(next, purpose)[provider] = model;
      const error = validateModel(provider, model);
      if (error) {
        setErrors({ [purpose]: error });
        setStatus({ text: `${purposeNames[purpose]}：${error}`, error: true });
        modelInputs[purpose].current?.focus();
        return;
      }
    }
    setDraft(next);
    setBusy(true);
    setStatus({ text: "正在保存…" });
    try {
      await aiSettings.setValue(structuredClone(next));
      setDirty(false);
      setStatus({ text: "设置已保存" });
    } catch {
      setStatus({ text: "保存失败，请重试。", error: true });
    } finally {
      setBusy(false);
    }
  }

  async function removeKey() {
    setBusy(true);
    try {
      const saved = await aiSettings.getValue();
      saved.providers[active].apiKey = "";
      await aiSettings.setValue(saved);
      setDraft((current) => {
        const next = structuredClone(current!);
        next.providers[active].apiKey = "";
        return next;
      });
      setStatus({ text: "已移除该服务商保存的 key" + (dirty ? "；其他更改尚未保存" : "") });
    } catch {
      setStatus({ text: "移除失败，请重试。", error: true });
    } finally {
      setBusy(false);
    }
  }

  const uses = draft
    ? (["analysis", "translation"] as const).filter((p) => draft[p].provider === active).map((p) => purposeNames[p])
    : [];

  return (
    <main className="mx-auto max-w-[640px] px-5 py-7 sm:px-8 sm:pt-14 sm:pb-10">
      <header className="mb-9 flex items-center gap-3 text-sm font-semibold sm:mb-12">
        <span aria-hidden="true" className="grid size-8 place-items-center rounded-full bg-primary text-base text-primary-foreground">译</span>
        Open Browser Translate
      </header>
      <h1 className="mb-3 text-[28px] leading-tight font-bold tracking-tight sm:text-[32px]">设置你的 AI</h1>
      <p className="mb-9 leading-relaxed text-muted-foreground">分别配置内容分析和翻译，共用服务商连接。</p>

      <form onSubmit={save} noValidate>
        <fieldset disabled={busy || !draft} className="min-w-0 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">模型用途</CardTitle>
            </CardHeader>
            <CardContent className="space-y-8">
              {(["analysis", "translation"] as const).map((purpose) => (
                <ModelSection
                  key={purpose}
                  purpose={purpose}
                  draft={draft}
                  error={errors[purpose]}
                  inputRef={modelInputs[purpose]}
                  onProviderChange={(provider) => edit((next) => setProvider(next, purpose, provider))}
                  onModelChange={(model) => edit((next) => { modelsOf(next, purpose)[next[purpose].provider] = model; })}
                />
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">服务商连接</CardTitle>
              <CardDescription>同一服务商的 API key 可同时用于内容分析和翻译。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <Label htmlFor="provider">管理服务商的 API key</Label>
                <Select value={active} onValueChange={(value) => selectKeyProvider(value as SettingsProvider)}>
                  <SelectTrigger id="provider" className="w-full" aria-describedby="provider-help">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(providerLabels) as SettingsProvider[]).map((provider) => (
                      <SelectItem key={provider} value={provider}>{providerLabels[provider]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p id="provider-help" className="text-[13px] text-muted-foreground">
                  {uses.length ? `当前用于：${uses.join("、")}` : "此服务商暂未被选用，可先保存 key。"}
                </p>
              </div>
              <div className="space-y-2">
                <div className="flex items-baseline justify-between gap-3">
                  <Label htmlFor="api-key">API key</Label>
                  <a href={keyLinks[active]} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[13px] text-primary underline-offset-3 hover:underline">
                    获取 API key <ExternalLink className="size-3" aria-hidden="true" />
                  </a>
                </div>
                <div className="relative">
                  <Input
                    id="api-key"
                    type={showKey ? "text" : "password"}
                    autoComplete="off"
                    spellCheck={false}
                    autoCapitalize="off"
                    aria-describedby="key-help"
                    className="pr-16"
                    value={draft?.providers[active].apiKey ?? ""}
                    onChange={(event) => edit((next) => { next.providers[active].apiKey = event.target.value; })}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="absolute top-1/2 right-1 h-7 -translate-y-1/2 text-[13px] text-primary"
                    aria-pressed={showKey}
                    aria-label={showKey ? "隐藏 API key" : "显示 API key"}
                    onClick={() => setShowKey(!showKey)}
                  >
                    {showKey ? "隐藏" : "显示"}
                  </Button>
                </div>
                <p id="key-help" className="text-[13px] text-muted-foreground">仅保存在当前浏览器的扩展本地存储中，不同步到其他设备。</p>
              </div>
            </CardContent>
          </Card>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" size="lg">保存设置</Button>
            <Button type="button" variant="ghost" className="text-muted-foreground" onClick={removeKey}>移除已保存的 key</Button>
          </div>
        </fieldset>
        <p role="status" aria-live="polite" className={cn("mt-4 min-h-6 text-[13px]", status.error ? "text-destructive" : "text-success")}>
          {status.text}
        </p>
      </form>
      <footer className="mt-8 border-t pt-5 text-xs leading-loose text-muted-foreground">每个服务商的配置单独保存。保存配置不会发起 AI 请求。</footer>
    </main>
  );
}

function ModelSection({ purpose, draft, error, inputRef, onProviderChange, onModelChange }: {
  purpose: Purpose;
  draft: AISettings | undefined;
  error: string | undefined;
  inputRef: RefObject<HTMLInputElement | null>;
  onProviderChange: (provider: SettingsProvider) => void;
  onModelChange: (model: string) => void;
}) {
  const id = useId();
  const config = purposes[purpose];
  const provider = draft?.[purpose].provider ?? config.providers[0];
  const model = (draft && modelsOf(draft, purpose)[provider]) ?? "";
  return (
    <section aria-labelledby={`${id}-heading`} className="space-y-4">
      <div>
        <h2 id={`${id}-heading`} className="font-semibold">{config.title}</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">{config.description}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`${id}-provider`}>服务商</Label>
          <Select value={provider} onValueChange={(value) => onProviderChange(value as SettingsProvider)}>
            <SelectTrigger id={`${id}-provider`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {config.providers.map((p) => <SelectItem key={p} value={p}>{providerLabels[p]}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${id}-model`}>{config.modelLabel}</Label>
          <Input
            ref={inputRef}
            id={`${id}-model`}
            autoComplete="off"
            spellCheck={false}
            placeholder={config.placeholder(provider)}
            aria-invalid={!!error}
            aria-describedby={`${id}-help`}
            value={model}
            onChange={(event) => onModelChange(event.target.value)}
          />
        </div>
      </div>
      <p id={`${id}-help`} className={cn("text-[13px]", error ? "text-destructive" : "text-muted-foreground")}>
        {error ?? config.help(provider)}
      </p>
    </section>
  );
}
