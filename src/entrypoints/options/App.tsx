import { useEffect, useId, useRef, useState, type FormEvent, type RefObject } from "react";
import { background } from "@/lib/background";
import { PURPOSE_NAMES, type Request } from "@/modules/protocol";
import { Bug, Database, ExternalLink, KeyRound, Sparkles } from "lucide-react";
import {
  aiSettings, REASONING_EFFORTS, validateModel,
  type AISettings, type SettingsProvider, type AnalysisProvider, type TranslationProvider, type KeyProvider, type ReasoningEffort,
} from "@/modules/settings";
import { AiProviders, DEFAULT_DECISION_MODEL, DEFAULT_GATEWAY_DECISION_MODEL, GATEWAY_DECISION_MODELS } from "@/modules/ai/providers";
import { chatgptAuth, chatgptSignInResult } from "@/modules/ai/chatgpt-session";
import type { SignInResult } from "@/modules/ai/chatgpt-session";
import type { ChatGPTModel } from "@/modules/ai/chatgpt-auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader,
  SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger, useSidebar,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { DebugLog } from "./DebugLog";
import { CacheSettings } from "./CacheSettings";
import type { Purpose } from "@/modules/ai/models";

type Status = { text: string; error?: boolean };

const providerLabels: Record<SettingsProvider, string> = {
  [AiProviders.VercelAIGateway]: "Vercel AI Gateway",
  [AiProviders.OpenAIApi]: "OpenAI 直连",
  [AiProviders.OpenAISubscription]: "ChatGPT 账号",
};
const keyLinks: Record<KeyProvider, string> = {
  [AiProviders.VercelAIGateway]: "https://vercel.com/dashboard",
  [AiProviders.OpenAIApi]: "https://platform.openai.com/api-keys",
};
const purposes = {
  analysis: {
    title: "内容分析",
    description: "判断哪些内容需要翻译。",
    modelLabel: "分析模型",
    // The gateway runs evaluation models built for decisions; OpenAI's Decisions API isn't open
    // yet, so the OpenAI providers answer decisions with an ordinary model.
    providers: [AiProviders.VercelAIGateway, AiProviders.OpenAIApi, AiProviders.OpenAISubscription],
    placeholder: (p: SettingsProvider) => p === AiProviders.VercelAIGateway ? DEFAULT_GATEWAY_DECISION_MODEL
      : p === AiProviders.OpenAIApi ? DEFAULT_DECISION_MODEL : "模型 ID",
    help: (p: SettingsProvider) => p === AiProviders.VercelAIGateway
      ? `使用网关上 Jev 这类专门做判断的评估模型，默认为 ${DEFAULT_GATEWAY_DECISION_MODEL}。`
      : `使用 OpenAI API key，默认模型为 ${DEFAULT_DECISION_MODEL}。`,
  },
  translation: {
    title: "翻译",
    description: "将筛选后的内容生成译文。模型可留空，稍后再配置。",
    modelLabel: "翻译模型",
    providers: [AiProviders.VercelAIGateway, AiProviders.OpenAIApi, AiProviders.OpenAISubscription],
    placeholder: (p: SettingsProvider) => p === AiProviders.VercelAIGateway ? "provider/model" : "模型 ID",
    // Providers with a model catalog add to or replace this; see ModelSection.
    help: (p: SettingsProvider) => p === AiProviders.VercelAIGateway ? "通过 Vercel AI Gateway 运行。" : "使用 OpenAI API key。",
  },
} as const;
type Section = "models" | "keys" | "cache" | "debug";
const sections = {
  models: { title: "模型用途", description: "分别配置内容分析和翻译使用的服务商与模型。", icon: Sparkles },
  keys: { title: "服务商连接", description: "同一服务商的连接可同时用于内容分析和翻译。", icon: KeyRound },
  cache: {
    title: "翻译缓存",
    description: "译文按段缓存在本机 7 天：再次打开同一页面，或同一网站上重复出现的文字，会直接显示缓存的译文，不再请求模型。缓存按站点、模型、模式和原文区分，原文只存哈希，但会保存译文内容；无痕窗口不使用缓存。换模型或模式后会重新翻译。",
    icon: Database,
  },
  debug: {
    title: "调试日志",
    description: "每次翻译请求按 OpenTelemetry 格式记录为一条追踪：每一步的模型、耗时和错误。数据只保存在本机、不会上传，保留最近 100 次请求，可导出为 OTLP JSON。会记录网址路径，不记录网页正文和 API key（服务商返回的错误信息可能引用模型输出）。",
    icon: Bug,
  },
} as const;
const signInErrors: Record<Exclude<SignInResult, { status: "ok" }>["reason"], string> = {
  cancelled: "登录已取消。",
  denied: "你拒绝了授权，未登录。",
  "no-plan": "这个账号没有授权使用 ChatGPT 套餐额度。",
  expired: "登录已过期，请重试。",
  invalid: "登录失败，请重试。",
};

/** Waits for the background to record how the sign-in attempt identified by `state` ended. */
function signInOutcome(state: string): Promise<SignInResult> {
  return new Promise((resolve) => {
    const done = (value: Awaited<ReturnType<typeof chatgptSignInResult.getValue>>) => {
      if (value?.state !== state) return;
      unwatch();
      resolve(value);
    };
    const unwatch = chatgptSignInResult.watch(done);
    chatgptSignInResult.getValue().then(done, () => {});
  });
}

/** A provider's model catalog; `unavailable` until there is an account or key to ask with. */
type Catalog = { status: "unavailable" | "loading" | "failed" } | { status: "ok"; models: ChatGPTModel[] };
type CatalogProvider = AiProviders.VercelAIGateway | AiProviders.OpenAIApi | AiProviders.OpenAISubscription;
interface LoadedCatalog { catalog: Catalog; reload: () => void }

const gatewayDecisionCatalog: LoadedCatalog = { catalog: { status: "ok", models: GATEWAY_DECISION_MODELS }, reload: () => {} };

/** Asks the background for a model catalog with `request`, waiting `delay` ms so typing a key doesn't fire a request per keystroke. */
function useCatalog(request: Request<"chatgpt-models" | "openai-models" | "gateway-models"> | undefined, delay = 0): LoadedCatalog {
  const [catalog, setCatalog] = useState<Catalog>({ status: "unavailable" });
  const [attempt, setAttempt] = useState(0);
  const key = request && JSON.stringify(request);
  useEffect(() => {
    if (!key) return setCatalog({ status: "unavailable" });
    let current = true;
    setCatalog({ status: "loading" });
    const timer = setTimeout(() => background.request(JSON.parse(key) as NonNullable<typeof request>).then(
      (response) => {
        if (!current) return;
        setCatalog(response?.status === "ok" ? { status: "ok", models: response.models }
          : response?.status === "no-key" ? { status: "unavailable" } : { status: "failed" });
      },
      () => { if (current) setCatalog({ status: "failed" }); },
    ), delay);
    return () => { current = false; clearTimeout(timer); };
  }, [key, attempt, delay]);
  return { catalog, reload: () => setAttempt((n) => n + 1) };
}

function useChatGPT() {
  const [email, setEmail] = useState<string | null>();
  useEffect(() => {
    const apply = (auth: Awaited<ReturnType<typeof chatgptAuth.getValue>>) => setEmail(auth?.account ? auth.account.email : null);
    chatgptAuth.getValue().then(apply, () => setEmail(null));
    return chatgptAuth.watch(apply);
  }, []);
  return { email, models: useCatalog(email ? { type: "chatgpt-models" } : undefined) };
}

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
  const [section, setSection] = useState<Section>("models");
  const [status, setStatus] = useState<Status>({ text: "正在读取设置…" });
  const modelInputs = { analysis: useRef<HTMLInputElement>(null), translation: useRef<HTMLInputElement>(null) };
  const chatgpt = useChatGPT();
  const openaiKey = draft?.providers[AiProviders.OpenAIApi].apiKey.trim();
  const shared = {
    [AiProviders.OpenAISubscription]: chatgpt.models,
    [AiProviders.OpenAIApi]: useCatalog(openaiKey ? { type: "openai-models", apiKey: openaiKey } : undefined, 600),
  };
  // Gateway analysis picks from the fixed evaluation models; translation loads the public language catalog.
  const catalogs: Record<Purpose, Record<CatalogProvider, LoadedCatalog>> = {
    analysis: { ...shared, [AiProviders.VercelAIGateway]: gatewayDecisionCatalog },
    translation: { ...shared, [AiProviders.VercelAIGateway]: useCatalog({ type: "gateway-models" }) },
  };

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
        setStatus({ text: `${PURPOSE_NAMES[purpose]}：${error}`, error: true });
        setSection("models");
        // The models card may be hidden until this render commits.
        requestAnimationFrame(() => modelInputs[purpose].current?.focus());
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

  async function signIn() {
    setBusy(true);
    setStatus({ text: "请在新打开的页面中登录 ChatGPT…" });
    try {
      const started = await background.request({ type: "chatgpt-sign-in" });
      if (started.status !== "started") throw new Error(started.error ?? "后台无法开始登录");
      const result = await signInOutcome(started.state);
      setStatus(result.status === "ok"
        ? { text: `已登录 ${result.email}` + (dirty ? "；其他更改尚未保存" : "") }
        : { text: signInErrors[result.reason] + (result.detail ? `（${result.detail}）` : ""), error: true });
    } catch (error) {
      setStatus({ text: `登录失败，请重试。（${error instanceof Error ? error.message : String(error)}）`, error: true });
    } finally {
      setBusy(false);
    }
  }
  async function signOut() {
    setBusy(true);
    try {
      await background.request({ type: "chatgpt-sign-out" });
      setStatus({ text: "已退出 ChatGPT" + (dirty ? "；其他更改尚未保存" : "") });
    } catch {
      setStatus({ text: "退出失败，请重试。", error: true });
    } finally {
      setBusy(false);
    }
  }

  async function removeKey() {
    if (active === AiProviders.OpenAISubscription) return;
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
    ? (["analysis", "translation"] as const).filter((p) => draft[p].provider === active).map((p) => PURPOSE_NAMES[p])
    : [];

  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader>
          <div className="flex items-center gap-3 px-2 py-3 text-sm font-semibold">
            <span aria-hidden="true" className="grid size-8 place-items-center rounded-full bg-primary text-base text-primary-foreground">译</span>
            Open Browser Translate
          </div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>设置</SidebarGroupLabel>
            <SidebarGroupContent>
              <SectionMenu section={section} onSelect={setSection} />
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <p className="px-2 pb-2 text-xs leading-relaxed text-muted-foreground">每个服务商的配置单独保存。保存配置不会发起 AI 请求。</p>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset>
        <header className="flex h-14 items-center gap-2 border-b px-4 md:hidden">
          <SidebarTrigger aria-label="打开导航" />
          <span className="text-sm font-semibold">{sections[section].title}</span>
        </header>
        <main className="w-full max-w-[680px] px-5 py-7 sm:px-10 sm:pt-12 sm:pb-10">
          <h1 className="mb-3 text-[28px] leading-tight font-bold tracking-tight">{sections[section].title}</h1>
          <p className="mb-8 leading-relaxed text-muted-foreground">{sections[section].description}</p>

          {section === "debug" && <DebugLog />}
          {section === "cache" && <CacheSettings />}
          <form onSubmit={save} noValidate hidden={section === "debug" || section === "cache"}>
            <fieldset disabled={busy || !draft} className="min-w-0 space-y-6">
              <Card hidden={section !== "models"}>
                <CardContent className="space-y-8">
                  {(["analysis", "translation"] as const).map((purpose) => (
                    <ModelSection
                      key={purpose}
                      purpose={purpose}
                      draft={draft}
                      catalogs={catalogs[purpose]}
                      error={errors[purpose]}
                      inputRef={modelInputs[purpose]}
                      onProviderChange={(provider) => edit((next) => setProvider(next, purpose, provider))}
                      onModelChange={(model) => edit((next) => { modelsOf(next, purpose)[next[purpose].provider] = model; })}
                      onEffortChange={(effort) => edit((next) => {
                        if (effort) next[purpose].reasoningEffort = effort;
                        else delete next[purpose].reasoningEffort;
                      })}
                      onFastChange={(fast) => edit((next) => {
                        if (fast) next[purpose].fast = true;
                        else delete next[purpose].fast;
                      })}
                    />
                  ))}
                </CardContent>
              </Card>

              <Card hidden={section !== "keys"}>
                <CardContent className="space-y-6">
                  <div className="space-y-2">
                    <Label htmlFor="provider">管理服务商连接</Label>
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
                  {active === AiProviders.OpenAISubscription ? (
                    <ChatGPTConnection email={chatgpt.email} onSignIn={signIn} onSignOut={signOut} />
                  ) : (<>
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
                  <Button type="button" variant="outline" size="sm" className="text-muted-foreground" onClick={removeKey}>移除已保存的 key</Button>
                  </>)}
                </CardContent>
              </Card>

              <Button type="submit" size="lg">保存设置</Button>
            </fieldset>
            <p role="status" aria-live="polite" className={cn("mt-4 min-h-6 text-[13px]", status.error ? "text-destructive" : "text-success")}>
              {status.text}
            </p>
          </form>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}

function SectionMenu({ section, onSelect }: { section: Section; onSelect: (section: Section) => void }) {
  const { setOpenMobile } = useSidebar();
  return (
    <SidebarMenu>
      {(Object.keys(sections) as Section[]).map((key) => {
        const Icon = sections[key].icon;
        return (
          <SidebarMenuItem key={key}>
            <SidebarMenuButton isActive={section === key} onClick={() => { onSelect(key); setOpenMobile(false); }}>
              <Icon aria-hidden="true" />
              <span>{sections[key].title}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}

function ChatGPTConnection({ email, onSignIn, onSignOut }: { email: string | null | undefined; onSignIn: () => void; onSignOut: () => void }) {
  return (
    <div className="space-y-3">
      <p className="text-sm">{email === undefined ? "正在读取登录状态…" : email ? `已登录：${email}` : "尚未登录"}</p>
      <p className="text-[13px] text-muted-foreground">
        使用 OpenAI 官方的 Sign in with ChatGPT 登录，翻译和内容分析消耗你 ChatGPT 套餐的额度，无需 API key。登录凭据仅保存在当前浏览器的扩展本地存储中。
      </p>
      {email
        ? <Button type="button" variant="outline" size="sm" className="text-muted-foreground" onClick={onSignOut}>退出登录</Button>
        : <Button type="button" size="sm" onClick={onSignIn} disabled={email === undefined}>使用 ChatGPT 登录</Button>}
    </div>
  );
}

const catalogHelp: Record<CatalogProvider, { unavailable: string; listed: (purposeHelp: string) => string; source: string }> = {
  [AiProviders.VercelAIGateway]: {
    unavailable: "",
    listed: (purposeHelp) => `${purposeHelp}列表来自 Vercel AI Gateway。`,
    source: "Vercel AI Gateway ",
  },
  [AiProviders.OpenAISubscription]: {
    unavailable: "请先在「服务商连接」中登录 ChatGPT，登录后可从列表选择模型；也可以直接填写模型 ID。",
    listed: () => "使用 ChatGPT 套餐的额度，无需 API key。列表来自你的 ChatGPT 账号。",
    source: "当前 ChatGPT 账号",
  },
  [AiProviders.OpenAIApi]: {
    unavailable: "在「服务商连接」中填写 OpenAI API key 后可从列表选择模型；也可以直接填写模型 ID。",
    listed: (purposeHelp) => `${purposeHelp}列表来自这个 API key 可用的模型。`,
    source: "这个 API key",
  },
};

const effortLabels: Record<ReasoningEffort, string> = {
  none: "不推理（none）", minimal: "最低（minimal）", low: "低（low）", medium: "中（medium）", high: "高（high）", xhigh: "最高（xhigh）",
};
const DEFAULT_EFFORT = "default";

function ModelSection({ purpose, draft, catalogs, error, inputRef, onProviderChange, onModelChange, onEffortChange, onFastChange }: {
  purpose: Purpose;
  draft: AISettings | undefined;
  catalogs: Record<CatalogProvider, LoadedCatalog>;
  error: string | undefined;
  inputRef: RefObject<HTMLInputElement | null>;
  onProviderChange: (provider: SettingsProvider) => void;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: ReasoningEffort | undefined) => void;
  onFastChange: (fast: boolean) => void;
}) {
  const id = useId();
  const config = purposes[purpose];
  const provider = draft?.[purpose].provider ?? config.providers[0];
  const model = (draft && modelsOf(draft, purpose)[provider]) ?? "";
  const { catalog, reload } = catalogs[provider as CatalogProvider] ?? {};
  const text = catalogHelp[provider as CatalogProvider];
  // A list to pick from replaces the free-text field once the provider's catalog has loaded.
  const choices = catalog?.status === "ok" && catalog.models.length ? catalog.models : undefined;
  const unlisted = choices && model && !choices.some((m) => m.slug === model);
  // Gateway analysis offers the fixed evaluation models (Jev and similar) instead of a loaded catalog.
  const evaluation = purpose === "analysis" && provider === AiProviders.VercelAIGateway;
  const help = error ?? (!catalog ? config.help(provider)
    : choices && unlisted ? (evaluation ? `模型 ${model} 不是可选的评估模型，请重新选择。` : `模型 ${model} 不在${text.source}的模型列表中，请重新选择。`)
    : choices ? (evaluation ? config.help(provider) : text.listed(config.help(provider)))
    : catalog.status === "ok" ? `${text.source}没有返回可用模型，可直接填写模型 ID。`
    : catalog.status === "loading" ? "正在读取可用模型…"
    : catalog.status === "failed" ? "无法读取模型列表，可直接填写模型 ID，或稍后重试。"
    : text.unavailable);
  // The gateway's evaluation models answer decisions without reasoning, so there is nothing to tune.
  const reasons = !evaluation;
  const effort = draft?.[purpose].reasoningEffort;
  // Fast mode is a ChatGPT plan option (the service tier Codex uses when signed in with ChatGPT).
  const offersFast = provider === AiProviders.OpenAISubscription;
  const fast = !!draft?.[purpose].fast;
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
          {choices ? (
            <Select value={model} onValueChange={onModelChange}>
              <SelectTrigger id={`${id}-model`} className="w-full" aria-invalid={!!error || !!unlisted} aria-describedby={`${id}-help`}>
                <SelectValue placeholder="选择模型" />
              </SelectTrigger>
              <SelectContent>
                {unlisted && <SelectItem value={model}>{model}（不在列表中）</SelectItem>}
                {choices.map((m) => (
                  <SelectItem key={m.slug} value={m.slug}>
                    {m.displayName}
                    {m.displayName !== m.slug && <span className="ml-2 font-mono text-xs text-muted-foreground">{m.slug}</span>}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
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
          )}
        </div>
        {reasons && (
          <div className="space-y-2">
            <Label htmlFor={`${id}-effort`}>推理强度</Label>
            <Select value={effort ?? DEFAULT_EFFORT} onValueChange={(value) => onEffortChange(value === DEFAULT_EFFORT ? undefined : value as ReasoningEffort)}>
              <SelectTrigger id={`${id}-effort`} className="w-full" aria-describedby={`${id}-effort-help`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_EFFORT}>由模型决定</SelectItem>
                {REASONING_EFFORTS.map((level) => <SelectItem key={level} value={level}>{effortLabels[level]}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        )}
        {offersFast && (
          <div className="space-y-2">
            <Label htmlFor={`${id}-speed`}>处理速度</Label>
            <Select value={fast ? "fast" : "standard"} onValueChange={(value) => onFastChange(value === "fast")}>
              <SelectTrigger id={`${id}-speed`} className="w-full" aria-describedby={`${id}-speed-help`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="standard">标准</SelectItem>
                <SelectItem value="fast">快速（Fast 模式）</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
      </div>
      <p id={`${id}-help`} className={cn("text-[13px]", error || unlisted ? "text-destructive" : "text-muted-foreground")}>
        {help}
        {catalog?.status === "failed" && (
          <Button type="button" variant="link" size="sm" className="ml-1 h-auto p-0 text-[13px]" onClick={reload}>重试</Button>
        )}
      </p>
      {reasons && (
        <p id={`${id}-effort-help`} className="text-[13px] text-muted-foreground">
          推理越强越慢、越费额度。不是每个模型都支持所有档位，不支持时请求会失败，原因记在「调试日志」。
        </p>
      )}
      {offersFast && (
        <p id={`${id}-speed-help`} className="text-[13px] text-muted-foreground">
          Fast 模式生成更快，但按标准的 2.5 倍消耗 ChatGPT 套餐额度。支持的模型和可用性取决于你的套餐。
        </p>
      )}
    </section>
  );
}
