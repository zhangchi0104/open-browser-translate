import { useEffect, useId, useRef, useState, type FormEvent, type RefObject } from "react";
import { background } from "@/lib/background";
import { PURPOSE_NAMES, type ChatGPTModel, type Purpose, type Request } from "@/modules/shared/protocol";
import { Bug, ChevronDown, Database, ExternalLink, KeyRound, Sparkles } from "lucide-react";
import {
  AiProviders, aiSettings, DEFAULT_DECISION_MODEL, DEFAULT_GATEWAY_DECISION_MODEL, REASONING_EFFORTS, validateModel,
  type AISettings, type SettingsProvider, type AnalysisProvider, type TranslationProvider, type KeyProvider, type ReasoningEffort,
} from "@/modules/shared/settings";
import { GATEWAY_DECISION_MODELS } from "@/modules/background/ai/gateway-models";
import { chatgptAuth, chatgptSignInResult } from "@/modules/background/ai/chatgpt-session";
import type { SignInResult } from "@/modules/background/ai/chatgpt-session";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader,
  SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger, useSidebar,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { DebugLog } from "./DebugLog";
import { CacheSettings } from "./CacheSettings";
import { SettingsGroup, SettingsRow } from "./SettingsList";

type Status = { text: string; tone?: "error" | "success" };
const statusTones = { error: "text-destructive", success: "text-success" } as const;

const providerLabels: Record<SettingsProvider, string> = {
  [AiProviders.VercelAIGateway]: "Vercel AI Gateway",
  [AiProviders.OpenAIApi]: "OpenAI 直连",
  [AiProviders.OpenAISubscription]: "ChatGPT 账号",
};
const keyLinks: Record<KeyProvider, string> = {
  [AiProviders.VercelAIGateway]: "https://vercel.com/dashboard",
  [AiProviders.OpenAIApi]: "https://platform.openai.com/api-keys",
};
const keyProviderDescriptions: Record<KeyProvider, string> = {
  [AiProviders.VercelAIGateway]: "一个 key 用多家公司的模型，按用量付费。",
  [AiProviders.OpenAIApi]: "OpenAI 开发者平台的 key，按用量付费。",
};
const purposes = {
  analysis: {
    title: "内容分析",
    description: "先判断页面上哪些内容值得翻译。",
    // The gateway runs evaluation models built for decisions; OpenAI's Decisions API isn't open
    // yet, so the OpenAI providers answer decisions with an ordinary model.
    providers: [AiProviders.VercelAIGateway, AiProviders.OpenAIApi, AiProviders.OpenAISubscription],
    placeholder: (p: SettingsProvider) => p === AiProviders.VercelAIGateway ? DEFAULT_GATEWAY_DECISION_MODEL
      : p === AiProviders.OpenAIApi ? DEFAULT_DECISION_MODEL : "模型 ID",
  },
  translation: {
    title: "翻译",
    description: "再把选出的内容译成中文。",
    providers: [AiProviders.VercelAIGateway, AiProviders.OpenAIApi, AiProviders.OpenAISubscription],
    placeholder: (p: SettingsProvider) => p === AiProviders.VercelAIGateway ? "provider/model" : "模型 ID",
  },
} as const;
type Section = "models" | "keys" | "cache" | "debug";
const sections = {
  models: { title: "模型", description: "", icon: Sparkles },
  keys: { title: "账号与密钥", description: "至少连接一个服务，翻译才能工作。", icon: KeyRound },
  cache: { title: "翻译缓存", description: "翻译过的段落在本机保留 7 天，再次遇到时直接显示，不再消耗额度。", icon: Database },
  debug: { title: "调试日志", description: "翻译出问题时，在这里查看每次请求的步骤、耗时和错误。", icon: Bug },
} as const;
// Everyday settings first; the debug log is for when something goes wrong.
const navigation: { label?: string; sections: Section[] }[] = [
  { sections: ["models", "keys", "cache"] },
  { label: "排查问题", sections: ["debug"] },
];
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
type Catalog = { status: "unavailable" | "loading" | "failed" } | { status: "ok"; models: readonly ChatGPTModel[] };
type CatalogProvider = AiProviders.VercelAIGateway | AiProviders.OpenAIApi | AiProviders.OpenAISubscription;
interface LoadedCatalog { catalog: Catalog; reload: () => void }

const gatewayDecisionCatalog: LoadedCatalog = { catalog: { status: "ok", models: GATEWAY_DECISION_MODELS }, reload: () => {} };

/** Asks the background for a model catalog with `request`, waiting `delay` ms so typing a key doesn't fire a request per keystroke. */
function useCatalog(request: Request<"chatgpt-models" | "openai-models" | "gateway-models"> | undefined, delay = 0): LoadedCatalog {
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

const keyProviders = [AiProviders.VercelAIGateway, AiProviders.OpenAIApi] as const satisfies readonly KeyProvider[];

export function App() {
  const [draft, setDraft] = useState<AISettings>();
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
    }, () => setStatus({ text: "无法读取设置，请刷新页面重试。", tone: "error" }));
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
        setStatus({ text: `${PURPOSE_NAMES[purpose]}：${error}`, tone: "error" });
        setSection("models");
        // The models section may be hidden until this render commits.
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
      setStatus({ text: "设置已保存", tone: "success" });
    } catch {
      setStatus({ text: "保存失败，请重试。", tone: "error" });
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
        ? { text: `已登录 ${result.email}` + (dirty ? "；其他更改尚未保存" : ""), tone: "success" }
        : { text: signInErrors[result.reason] + (result.detail ? `（${result.detail}）` : ""), tone: "error" });
    } catch (error) {
      setStatus({ text: `登录失败，请重试。（${error instanceof Error ? error.message : String(error)}）`, tone: "error" });
    } finally {
      setBusy(false);
    }
  }
  async function signOut() {
    setBusy(true);
    try {
      await background.request({ type: "chatgpt-sign-out" });
      setStatus({ text: "已退出 ChatGPT" + (dirty ? "；其他更改尚未保存" : ""), tone: "success" });
    } catch {
      setStatus({ text: "退出失败，请重试。", tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  /** Which purposes use `provider`, in a phrase for its row. */
  function usage(provider: SettingsProvider) {
    const uses = draft ? (["analysis", "translation"] as const).filter((p) => draft[p].provider === provider).map((p) => PURPOSE_NAMES[p]) : [];
    return uses.length ? `正在用于${uses.join("和")}` : "暂未使用";
  }

  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader>
          <div className="flex items-center gap-2.5 px-2 pt-3 pb-1">
            <span aria-hidden="true" className="grid size-7 place-items-center rounded-lg bg-primary text-[13px] font-semibold text-primary-foreground">译</span>
            <span className="text-sm font-semibold">Open Browser Translate</span>
          </div>
        </SidebarHeader>
        <SidebarContent>
          {navigation.map((group) => (
            <SidebarGroup key={group.sections[0]}>
              {group.label && <SidebarGroupLabel>{group.label}</SidebarGroupLabel>}
              <SidebarGroupContent>
                <SectionMenu items={group.sections} section={section} onSelect={setSection} />
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>
      </Sidebar>

      <SidebarInset>
        <header className="flex h-14 items-center gap-2 border-b px-4 md:hidden">
          <SidebarTrigger aria-label="打开导航" />
          <span className="text-sm font-semibold">{sections[section].title}</span>
        </header>
        {/* The heading sits against the sidebar; the content below is centered in the remaining space. */}
        <div className="space-y-1.5 px-5 pt-8 sm:px-11 sm:pt-12">
          <h1 className="text-[22px] leading-tight font-semibold">{sections[section].title}</h1>
          {sections[section].description && <p className="text-sm text-muted-foreground">{sections[section].description}</p>}
        </div>
        {/* The debug log's timelines get more room; settings keep a short line length. */}
        <main className={cn("mx-auto w-full px-4 pt-8 sm:px-10", section === "debug" ? "max-w-[880px]" : "max-w-[640px]")}>

          {section === "debug" && <DebugLog />}
          {section === "cache" && <CacheSettings />}
          <form onSubmit={save} noValidate hidden={section === "debug" || section === "cache"}>
            <fieldset disabled={busy || !draft} className="min-w-0">
              <div hidden={section !== "models"} className="space-y-8">
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
              </div>

              <div hidden={section !== "keys"}>
                <SettingsGroup footer="API key 和登录信息只保存在这台设备的浏览器中，不会同步到其他设备。">
                  <ChatGPTRow email={chatgpt.email} usage={usage(AiProviders.OpenAISubscription)} onSignIn={signIn} onSignOut={signOut} />
                  {keyProviders.map((provider) => (
                    <KeyRow
                      key={provider}
                      provider={provider}
                      apiKey={draft?.providers[provider].apiKey ?? ""}
                      usage={usage(provider)}
                      onChange={(value) => edit((next) => { next.providers[provider].apiKey = value; })}
                    />
                  ))}
                </SettingsGroup>
              </div>

              {/* Stays in view while scrolling, so the unsaved state and Save are never out of reach. */}
              <div className="sticky bottom-0 mt-10 flex min-h-16 items-center justify-between gap-4 border-t bg-background py-3 pl-1">
                <p role="status" aria-live="polite" className={cn("min-w-0 text-[13px]", status.tone ? statusTones[status.tone] : "text-muted-foreground")}>
                  {status.text}
                </p>
                <Button type="submit" disabled={!dirty}>保存</Button>
              </div>
            </fieldset>
          </form>
          {(section === "debug" || section === "cache") && <div className="h-12" />}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}

function SectionMenu({ items, section, onSelect }: { items: Section[]; section: Section; onSelect: (section: Section) => void }) {
  const { setOpenMobile } = useSidebar();
  return (
    <SidebarMenu>
      {items.map((key) => {
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

function ChatGPTRow({ email, usage, onSignIn, onSignOut }: {
  email: string | null | undefined;
  usage: string;
  onSignIn: () => void;
  onSignOut: () => void;
}) {
  return (
    <SettingsRow
      label={providerLabels[AiProviders.OpenAISubscription]}
      description={email === undefined ? "正在读取登录状态…" : email ? `${email} · ${usage}` : "用 ChatGPT 套餐的额度，不需要 API key。"}
    >
      {email
        ? <Button type="button" variant="outline" size="sm" onClick={onSignOut}>退出登录</Button>
        : <Button type="button" size="sm" onClick={onSignIn} disabled={email === undefined}>登录</Button>}
    </SettingsRow>
  );
}

/** A key provider: its key on the right; until there is one, what it is and where to get a key. */
function KeyRow({ provider, apiKey, usage, onChange }: {
  provider: KeyProvider;
  apiKey: string;
  usage: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const [shown, setShown] = useState(false);
  return (
    <SettingsRow
      label={providerLabels[provider]}
      htmlFor={id}
      descriptionId={`${id}-help`}
      description={apiKey.trim() ? usage : <>
        {keyProviderDescriptions[provider]}
        <a href={keyLinks[provider]} target="_blank" rel="noopener noreferrer" className="ml-1 inline-flex items-center gap-0.5 text-primary underline-offset-3 hover:underline">
          获取 key<ExternalLink className="size-3" aria-hidden="true" />
        </a>
      </>}
    >
      <div className="relative w-full sm:w-60">
        <Input
          id={id}
          type={shown ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
          placeholder="API key"
          aria-describedby={`${id}-help`}
          className="pr-12"
          value={apiKey}
          onChange={(event) => onChange(event.target.value)}
        />
        {apiKey && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="absolute top-1/2 right-1 h-7 -translate-y-1/2 px-2 text-[12px] text-muted-foreground"
            aria-pressed={shown}
            aria-label={shown ? "隐藏 API key" : "显示 API key"}
            onClick={() => setShown(!shown)}
          >
            {shown ? "隐藏" : "显示"}
          </Button>
        )}
      </div>
    </SettingsRow>
  );
}

// Shown under a model only when there's something to act on; a loaded list speaks for itself.
const catalogHelp: Record<CatalogProvider, { unavailable: string; source: string }> = {
  [AiProviders.VercelAIGateway]: { unavailable: "", source: "Vercel AI Gateway " },
  [AiProviders.OpenAISubscription]: {
    unavailable: "在「账号与密钥」中登录 ChatGPT 后可从列表选择模型，也可以直接填写模型 ID。",
    source: "当前 ChatGPT 账号",
  },
  [AiProviders.OpenAIApi]: {
    unavailable: "在「账号与密钥」中填写 OpenAI API key 后可从列表选择模型，也可以直接填写模型 ID。",
    source: "这个 API key",
  },
};

const effortLabels: Record<ReasoningEffort, string> = {
  none: "关闭", minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "最高",
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
  const help = error ?? (!catalog || (choices && !unlisted) ? undefined
    : unlisted ? (evaluation ? `模型 ${model} 不是可选的评估模型，请重新选择。` : `模型 ${model} 不在${text.source}的模型列表中，请重新选择。`)
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
  // Reasoning and speed are for people tuning cost; they stay folded until asked for or already set.
  const [showAdvanced, setShowAdvanced] = useState(false);
  const advanced = reasons || offersFast;
  const advancedOpen = showAdvanced || !!effort || fast;
  const field = "w-full sm:w-60";
  return (
    <SettingsGroup
      title={config.title}
      description={config.description}
      footer={help && (
        <p id={`${id}-help`} className={cn(error || unlisted ? "text-destructive" : undefined)}>
          {help}
          {catalog?.status === "failed" && (
            <Button type="button" variant="link" size="sm" className="ml-1 h-auto p-0 text-[12px]" onClick={reload}>重试</Button>
          )}
        </p>
      )}
    >
      <SettingsRow label="服务" htmlFor={`${id}-provider`}>
        <Select value={provider} onValueChange={(value) => onProviderChange(value as SettingsProvider)}>
          <SelectTrigger id={`${id}-provider`} className={field}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {config.providers.map((p) => <SelectItem key={p} value={p}>{providerLabels[p]}</SelectItem>)}
          </SelectContent>
        </Select>
      </SettingsRow>
      <SettingsRow label="模型" htmlFor={`${id}-model`}>
        {choices ? (
          <Select value={model} onValueChange={onModelChange}>
            <SelectTrigger id={`${id}-model`} className={field} aria-invalid={!!error || !!unlisted} aria-describedby={help ? `${id}-help` : undefined}>
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
            className={field}
            autoComplete="off"
            spellCheck={false}
            placeholder={config.placeholder(provider)}
            aria-invalid={!!error}
            aria-describedby={help ? `${id}-help` : undefined}
            value={model}
            onChange={(event) => onModelChange(event.target.value)}
          />
        )}
      </SettingsRow>
      {advanced && !advancedOpen && (
        <button
          type="button"
          className="flex w-full items-center justify-between px-4 py-3 text-left text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          aria-expanded={false}
          onClick={() => {
            setShowAdvanced(true);
            requestAnimationFrame(() => document.getElementById(reasons ? `${id}-effort` : `${id}-fast`)?.focus());
          }}
        >
          更多选项
          <ChevronDown className="size-4" aria-hidden="true" />
        </button>
      )}
      {reasons && advancedOpen && (
        <SettingsRow
          label="推理强度"
          htmlFor={`${id}-effort`}
          description="越高越慢，也越费额度。"
          descriptionId={`${id}-effort-help`}
        >
          <Select value={effort ?? DEFAULT_EFFORT} onValueChange={(value) => onEffortChange(value === DEFAULT_EFFORT ? undefined : value as ReasoningEffort)}>
            <SelectTrigger id={`${id}-effort`} className={field} aria-describedby={`${id}-effort-help`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_EFFORT}>自动</SelectItem>
              {REASONING_EFFORTS.map((level) => <SelectItem key={level} value={level}>{effortLabels[level]}</SelectItem>)}
            </SelectContent>
          </Select>
        </SettingsRow>
      )}
      {offersFast && advancedOpen && (
        <SettingsRow
          label="快速模式"
          htmlFor={`${id}-fast`}
          description="生成更快，但额度消耗是平时的 2.5 倍。"
          descriptionId={`${id}-fast-help`}
        >
          <Switch id={`${id}-fast`} checked={fast} onCheckedChange={onFastChange} aria-describedby={`${id}-fast-help`} />
        </SettingsRow>
      )}
    </SettingsGroup>
  );
}
