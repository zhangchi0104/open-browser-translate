import { useEffect, useId, useRef, useState, type FormEvent, type RefObject } from "react";
import { browser } from "wxt/browser";
import { background } from "@/lib/background";
import { PURPOSE_NAMES, type Purpose } from "@/modules/shared/protocol";
import { Bug, ChevronDown, Database, ExternalLink, KeyRound, Languages, Plus } from "lucide-react";
import {
  AiProviders, aiSettings, CHATGPT_CONNECTION, CONNECTION_KIND_NAMES, CONNECTION_KINDS,
  CHATGPT_CONNECTION_NAME, connectionName, defaultModel, findConnection, normalizeApiUrl, providerOf, purposeError, REASONING_EFFORTS,
  TARGET_LANGUAGES, targetLanguageOf, validateApiUrl,
  type AISettings, type Connection, type ConnectionKind, type ReasoningEffort, type SettingsProvider,
} from "@/modules/shared/settings";
import { GATEWAY_DECISION_MODELS } from "@/modules/background/ai/gateway-models";
import { chatgptAuth, chatgptSignInResult } from "@/modules/background/ai/chatgpt-session";
import type { SignInResult } from "@/modules/background/ai/chatgpt-session";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { useCatalog, type LoadedCatalog } from "@/components/use-catalog";

type Status = { text: string; tone?: "error" | "success" };
const statusTones = { error: "text-destructive", success: "text-success" } as const;

const kindDescriptions: Record<ConnectionKind, string> = {
  [AiProviders.VercelAIGateway]: "一个 key 用多家公司的模型，按用量付费。",
  [AiProviders.OpenAIApi]: "OpenAI 开发者平台的 key，按用量付费。",
  [AiProviders.Custom]: "任何 OpenAI 兼容的接口，如 OpenRouter 或本机运行的模型。",
};
const kindLinks: Partial<Record<ConnectionKind, string>> = {
  [AiProviders.VercelAIGateway]: "https://vercel.com/dashboard",
  [AiProviders.OpenAIApi]: "https://platform.openai.com/api-keys",
};
const purposes = {
  analysis: {
    title: "内容分析",
    description: "先判断页面上哪些内容值得翻译。",
    // The gateway runs evaluation models built for decisions; OpenAI's Decisions API isn't open
    // yet, so other connections answer decisions with an ordinary model.
    placeholder: (p: SettingsProvider | undefined) => defaultModel("analysis", p) || "模型 ID",
  },
  translation: {
    title: "翻译",
    description: "再把选出的内容译成目标语言。",
    placeholder: (p: SettingsProvider | undefined) => p === AiProviders.VercelAIGateway ? "provider/model" : "模型 ID",
  },
} as const;
type Section = "models" | "keys" | "cache" | "debug";
const sections = {
  models: { title: "语言与模型", description: "", icon: Languages },
  keys: { title: "连接", description: "至少连接一个服务，翻译才能工作。", icon: KeyRound },
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

const gatewayDecisionCatalog: LoadedCatalog = { catalog: { status: "ok", models: GATEWAY_DECISION_MODELS }, reload: () => {} };

function useChatGPTEmail() {
  const [email, setEmail] = useState<string | null>();
  useEffect(() => {
    const apply = (auth: Awaited<ReturnType<typeof chatgptAuth.getValue>>) => setEmail(auth?.account ? auth.account.email : null);
    chatgptAuth.getValue().then(apply, () => setEmail(null));
    return chatgptAuth.watch(apply);
  }, []);
  return email;
}

/** A name for a new connection of `kind` that no other connection has yet. */
function freshName(connections: readonly Connection[], kind: ConnectionKind) {
  const base = CONNECTION_KIND_NAMES[kind];
  const taken = new Set(connections.map((connection) => connection.name));
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base} ${n}`;
    if (!taken.has(name)) return name;
  }
}
/** Host permission patterns custom connections need; requested when the settings are saved. */
function customOrigins(connections: readonly Connection[]) {
  return [...new Set(connections.flatMap((connection) =>
    connection.kind === AiProviders.Custom && !validateApiUrl(connection.apiUrl ?? "") ? [`${new URL(normalizeApiUrl(connection.apiUrl)).origin}/*`] : []))];
}

export function App() {
  const [draft, setDraft] = useState<AISettings>();
  const [busy, setBusy] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<Purpose, string>>>({});
  const [connectionErrors, setConnectionErrors] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<string>();
  const [section, setSection] = useState<Section>("models");
  const [status, setStatus] = useState<Status>({ text: "正在读取设置…" });
  const modelInputs = { analysis: useRef<HTMLInputElement>(null), translation: useRef<HTMLInputElement>(null) };
  const email = useChatGPTEmail();

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
    setConnectionErrors({});
    setDirty(true);
    setStatus({ text: "有未保存的更改" });
  }
  function addConnection(kind: ConnectionKind) {
    const id = crypto.randomUUID();
    edit((next) => { next.connections.push({ id, kind, name: freshName(next.connections, kind), apiKey: "", ...(kind === AiProviders.Custom && { apiUrl: "" }) }); });
    setExpanded(id);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    const next = structuredClone(draft);
    for (const connection of next.connections) {
      connection.apiKey = connection.apiKey.trim();
      connection.name = connectionName(connection);
      if (connection.kind !== AiProviders.Custom) continue;
      connection.apiUrl = normalizeApiUrl(connection.apiUrl);
      const error = validateApiUrl(connection.apiUrl);
      if (error) {
        setConnectionErrors({ [connection.id]: error });
        setExpanded(connection.id);
        setStatus({ text: `${connection.name}：${error}`, tone: "error" });
        setSection("keys");
        return;
      }
    }
    for (const purpose of ["analysis", "translation"] as const) {
      const { connection } = next[purpose];
      next[purpose].models[connection] = (next[purpose].models[connection] ?? defaultModel(purpose, providerOf(next, connection))).trim();
      const error = purposeError(next, purpose);
      if (error) {
        setErrors({ [purpose]: error });
        setStatus({ text: `${PURPOSE_NAMES[purpose]}：${error}`, tone: "error" });
        setSection("models");
        // The models section may be hidden until this render commits.
        requestAnimationFrame(() => modelInputs[purpose].current?.focus());
        return;
      }
    }
    // Asked before anything is awaited, while the click still counts as the user's: the background
    // can only reach a custom connection's server with permission for its origin.
    const origins = customOrigins(next.connections);
    const permitted = origins.length ? browser.permissions.request({ origins }).catch(() => false) : Promise.resolve(true);
    setDraft(next);
    setBusy(true);
    setStatus({ text: "正在保存…" });
    try {
      await aiSettings.setValue(structuredClone(next));
      setDirty(false);
      setStatus(await permitted
        ? { text: "设置已保存", tone: "success" }
        : { text: "设置已保存，但没有获得访问自定义接口的权限，使用时会连接失败。", tone: "error" });
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

  /** The purposes that use connection `id`. */
  const usesOf = (id: string) => draft ? (["analysis", "translation"] as const).filter((p) => draft[p].connection === id).map((p) => PURPOSE_NAMES[p]) : [];

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
        <main className={cn("mx-auto w-full px-4 pt-8 sm:px-10", section === "debug" ? "max-w-[880px]" : "max-w-[640px]", (section === "debug" || section === "cache") && "pb-12")}>
          {section === "debug" && <DebugLog />}
          {section === "cache" && <CacheSettings />}
          <form onSubmit={save} noValidate hidden={section === "debug" || section === "cache"}>
            <fieldset disabled={busy || !draft} className="min-w-0">
              <div hidden={section !== "models"} className="space-y-8">
                <SettingsGroup>
                  <SettingsRow label="目标语言" htmlFor="target-language">
                    <Select value={draft ? targetLanguageOf(draft).code : ""} onValueChange={(value) => edit((next) => { next.targetLanguage = value; })}>
                      <SelectTrigger id="target-language" className="w-full sm:w-60">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {TARGET_LANGUAGES.map(({ code, name }) => <SelectItem key={code} value={code}>{name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </SettingsRow>
                </SettingsGroup>
                {(["analysis", "translation"] as const).map((purpose) => (
                  <ModelSection
                    key={purpose}
                    purpose={purpose}
                    draft={draft}
                    email={email}
                    error={errors[purpose]}
                    inputRef={modelInputs[purpose]}
                    onConnectionChange={(connection) => edit((next) => { next[purpose].connection = connection; })}
                    onModelChange={(model) => edit((next) => { next[purpose].models[next[purpose].connection] = model; })}
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

              {/* The ChatGPT sign-in stands apart: there is only ever one, and it can't be edited or removed. */}
              <div hidden={section !== "keys"} className="space-y-8">
                <SettingsGroup title="账号">
                  <ChatGPTRow email={email} onSignIn={signIn} onSignOut={signOut} />
                </SettingsGroup>
                <SettingsGroup title="API 连接" footer="API key 和登录信息只保存在这台设备的浏览器中，不会同步到其他设备。">
                  {draft?.connections.map((connection) => (
                    <ConnectionRow
                      key={connection.id}
                      connection={connection}
                      uses={usesOf(connection.id)}
                      error={connectionErrors[connection.id]}
                      open={expanded === connection.id}
                      onToggle={() => setExpanded(expanded === connection.id ? undefined : connection.id)}
                      onChange={(change) => edit((next) => { change(findConnection(next, connection.id)!); })}
                      onRemove={() => edit((next) => {
                        next.connections = next.connections.filter((entry) => entry.id !== connection.id);
                        for (const purpose of ["analysis", "translation"] as const) delete next[purpose].models[connection.id];
                      })}
                    />
                  ))}
                  <AddConnection onAdd={addConnection} />
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

/** The ChatGPT sign-in: the signed-in account at the end of the row, beside signing out. */
function ChatGPTRow({ email, onSignIn, onSignOut }: {
  email: string | null | undefined;
  onSignIn: () => void;
  onSignOut: () => void;
}) {
  return (
    <SettingsRow label={CHATGPT_CONNECTION_NAME}>
      {email === undefined && <span className="text-sm text-muted-foreground">正在读取…</span>}
      {email && <span className="min-w-0 truncate text-sm text-muted-foreground" title={email}>{email}</span>}
      {email
        ? <Button type="button" variant="outline" size="sm" onClick={onSignOut}>退出登录</Button>
        : email === null && <Button type="button" size="sm" onClick={onSignIn}>登录</Button>}
    </SettingsRow>
  );
}

/** A connection in the list: its name and state, opening in place to edit. */
function ConnectionRow({ connection, uses, error, open, onToggle, onChange, onRemove }: {
  connection: Connection;
  uses: string[];
  error: string | undefined;
  open: boolean;
  onToggle: () => void;
  onChange: (change: (connection: Connection) => void) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const [shown, setShown] = useState(false);
  const custom = connection.kind === AiProviders.Custom;
  const link = kindLinks[connection.kind];
  return (
    <div>
      <SettingsRow label={connectionName(connection)}>
        <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" aria-expanded={open} aria-controls={`${id}-editor`} onClick={onToggle}>
          {open ? "收起" : "编辑"}
        </Button>
      </SettingsRow>
      {open && (
        <div id={`${id}-editor`} className="space-y-4 px-4 pb-4">
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-name`} className="text-[13px] font-normal text-muted-foreground">名称</Label>
            <Input id={`${id}-name`} value={connection.name} placeholder={CONNECTION_KIND_NAMES[connection.kind]} onChange={(event) => onChange((c) => { c.name = event.target.value; })} />
          </div>
          {custom && (
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-url`} className="text-[13px] font-normal text-muted-foreground">接口地址</Label>
              <Input
                id={`${id}-url`}
                type="url"
                spellCheck={false}
                autoCapitalize="off"
                placeholder="https://openrouter.ai/api/v1"
                aria-invalid={!!error}
                aria-describedby={`${id}-url-help`}
                value={connection.apiUrl ?? ""}
                onChange={(event) => onChange((c) => { c.apiUrl = event.target.value; })}
              />
              <p id={`${id}-url-help`} className={cn("text-[12px]", error ? "text-destructive" : "text-muted-foreground")}>
                {error ?? "OpenAI 兼容接口的地址，通常以 /v1 结尾。保存时会请求访问这个网站的权限。"}
              </p>
            </div>
          )}
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <Label htmlFor={`${id}-key`} className="text-[13px] font-normal text-muted-foreground">API key{custom && "（可选）"}</Label>
              {link && (
                <a href={link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-[12px] text-primary underline-offset-3 hover:underline">
                  获取 key<ExternalLink className="size-3" aria-hidden="true" />
                </a>
              )}
            </div>
            <div className="relative">
              <Input
                id={`${id}-key`}
                type={shown ? "text" : "password"}
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="off"
                placeholder={custom ? "本机运行的模型通常不需要" : "粘贴 API key"}
                className="pr-12"
                value={connection.apiKey}
                onChange={(event) => onChange((c) => { c.apiKey = event.target.value; })}
              />
              {connection.apiKey && (
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
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Button type="button" variant="ghost" size="sm" className="-ml-3 text-destructive hover:text-destructive" disabled={uses.length > 0} onClick={onRemove}>
              删除这个连接
            </Button>
            {uses.length > 0 && <span className="text-[12px] text-muted-foreground">正在用于{uses.join("和")}，先在「语言与模型」中换成其他连接</span>}
          </div>
        </div>
      )}
    </div>
  );
}

/** The last row of the list: adds a connection of the chosen kind, which then opens to fill in. */
function AddConnection({ onAdd }: { onAdd: (kind: ConnectionKind) => void }) {
  const [choosing, setChoosing] = useState(false);
  if (!choosing) {
    return (
      <button
        type="button"
        className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm text-primary outline-none hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50"
        onClick={() => setChoosing(true)}
      >
        <Plus className="size-4" aria-hidden="true" />
        添加连接
      </button>
    );
  }
  return (
    <div role="group" aria-label="选择连接类型" className="space-y-1 px-2 py-2">
      {CONNECTION_KINDS.map((kind, index) => (
        <button
          key={kind}
          type="button"
          autoFocus={index === 0}
          className="flex w-full flex-col items-start rounded-md px-2 py-2 text-left outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
          onClick={() => { setChoosing(false); onAdd(kind); }}
        >
          <span className="text-sm">{kind === AiProviders.Custom ? "自定义（OpenAI 兼容）" : CONNECTION_KIND_NAMES[kind]}</span>
          <span className="text-[12px] text-muted-foreground">{kindDescriptions[kind]}</span>
        </button>
      ))}
      <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setChoosing(false)}>取消</Button>
    </div>
  );
}

// Shown under a model only when there's something to act on; a loaded list speaks for itself.
const catalogHelp: Record<SettingsProvider, { unavailable: string; source: string }> = {
  [AiProviders.VercelAIGateway]: { unavailable: "", source: "Vercel AI Gateway " },
  [AiProviders.OpenAISubscription]: {
    unavailable: "在「连接」中登录 ChatGPT 后可从列表选择模型，也可以直接填写模型 ID。",
    source: "当前 ChatGPT 账号",
  },
  [AiProviders.OpenAIApi]: {
    unavailable: "在「连接」中给这个连接填写 API key 后可从列表选择模型，也可以直接填写模型 ID。",
    source: "这个 API key",
  },
  [AiProviders.Custom]: {
    unavailable: "在「连接」中填写接口地址后可从列表选择模型，也可以直接填写模型 ID。",
    source: "这个接口",
  },
};

const effortLabels: Record<ReasoningEffort, string> = {
  none: "关闭", minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "最高",
};
const DEFAULT_EFFORT = "default";

/** Where the model list for a purpose on `connection` comes from, if it can be asked for yet. */
function catalogRequest(purpose: Purpose, provider: SettingsProvider | undefined, connection: Connection | undefined, email: string | null | undefined) {
  switch (provider) {
    case AiProviders.OpenAISubscription: return email ? { type: "chatgpt-models" } as const : undefined;
    // The gateway's language catalog is public; analysis there uses the fixed evaluation models.
    case AiProviders.VercelAIGateway: return purpose === "translation" ? { type: "gateway-models" } as const : undefined;
    case AiProviders.OpenAIApi: {
      const apiKey = connection?.apiKey.trim();
      return apiKey ? { type: "openai-models", apiKey } as const : undefined;
    }
    case AiProviders.Custom: {
      const apiUrl = normalizeApiUrl(connection?.apiUrl);
      return validateApiUrl(apiUrl) ? undefined : { type: "openai-models", apiKey: connection?.apiKey.trim() ?? "", apiUrl } as const;
    }
  }
}

function ModelSection({ purpose, draft, email, error, inputRef, onConnectionChange, onModelChange, onEffortChange, onFastChange }: {
  purpose: Purpose;
  draft: AISettings | undefined;
  email: string | null | undefined;
  error: string | undefined;
  inputRef: RefObject<HTMLInputElement | null>;
  onConnectionChange: (connection: string) => void;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: ReasoningEffort | undefined) => void;
  onFastChange: (fast: boolean) => void;
}) {
  const id = useId();
  const config = purposes[purpose];
  const connectionId = draft?.[purpose].connection ?? "";
  const connection = draft && findConnection(draft, connectionId);
  const provider = draft && providerOf(draft, connectionId);
  // A purpose can still point at a connection removed in this draft; it must be changed before saving.
  const removed = !!draft && !provider;
  const model = draft?.[purpose].models[connectionId] ?? defaultModel(purpose, provider);
  // Gateway analysis offers the fixed evaluation models (Jev and similar) instead of a loaded catalog.
  const evaluation = purpose === "analysis" && provider === AiProviders.VercelAIGateway;
  const request = catalogRequest(purpose, provider, connection, email);
  const keyed = provider === AiProviders.OpenAIApi || provider === AiProviders.Custom;
  const loaded = useCatalog(request, keyed ? 600 : 0);
  const { catalog, reload } = evaluation ? gatewayDecisionCatalog : loaded;
  const text = provider && catalogHelp[provider];
  // A list to pick from replaces the free-text field once the connection's catalog has loaded.
  const choices = catalog.status === "ok" && catalog.models.length ? catalog.models : undefined;
  const unlisted = choices && model && !choices.some((m) => m.slug === model);
  // Empty text (the gateway needs nothing to list its models) shows no footnote.
  const help = (error ?? (removed ? "这个连接已被删除，请选择其他连接。"
    : !text || (choices && !unlisted) ? undefined
    : unlisted ? (evaluation ? `模型 ${model} 不是可选的评估模型，请重新选择。` : `模型 ${model} 不在${text.source}的模型列表中，请重新选择。`)
    : catalog.status === "ok" ? `${text.source}没有返回可用模型，可直接填写模型 ID。`
    : catalog.status === "loading" ? "正在读取可用模型…"
    : catalog.status === "failed" ? "无法读取模型列表，可直接填写模型 ID，或稍后重试。"
    : text.unavailable)) || undefined;
  // The gateway's evaluation models answer decisions without reasoning, so there is nothing to tune.
  const reasons = !evaluation && !removed;
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
        <p id={`${id}-help`} className={cn(error || unlisted || removed ? "text-destructive" : undefined)}>
          {help}
          {catalog.status === "failed" && (
            <Button type="button" variant="link" size="sm" className="ml-1 h-auto p-0 text-[12px]" onClick={reload}>重试</Button>
          )}
        </p>
      )}
    >
      <SettingsRow label="连接" htmlFor={`${id}-connection`}>
        <Select value={connectionId} onValueChange={onConnectionChange}>
          <SelectTrigger id={`${id}-connection`} className={field} aria-invalid={removed}>
            <SelectValue placeholder="选择连接" />
          </SelectTrigger>
          <SelectContent>
            {removed && <SelectItem value={connectionId}>（已删除的连接）</SelectItem>}
            <SelectItem value={CHATGPT_CONNECTION}>{CHATGPT_CONNECTION_NAME}</SelectItem>
            {draft?.connections.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {connectionName(c)}
                {c.name !== CONNECTION_KIND_NAMES[c.kind] && <span className="ml-2 text-xs text-muted-foreground">{CONNECTION_KIND_NAMES[c.kind]}</span>}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>
      {!removed && (
        <SettingsRow label="模型" htmlFor={`${id}-model`}>
          {choices ? (
            <Select value={model} onValueChange={onModelChange}>
              <SelectTrigger id={`${id}-model`} className={field} aria-invalid={!!error || !!unlisted} aria-describedby={help ? `${id}-help` : undefined}>
                <SelectValue placeholder="选择模型" />
              </SelectTrigger>
              <SelectContent>
                {unlisted && <SelectItem value={model}>{model}（不在列表中）</SelectItem>}
                {choices.map((m) => (
                  <SelectItem key={m.slug} value={m.slug} description={m.displayName !== m.slug && m.slug}>
                    {m.displayName}
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
      )}
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
