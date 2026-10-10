import { useEffect, useId, useState } from "react";
import { X } from "lucide-react";
import { background } from "@/lib/background";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { ModelPicker } from "../model-picker";
import { PURPOSE_NAMES, type Purpose, type QuickSettings as View, type Request } from "../../modules/shared/protocol";
import { useCatalog, type Catalog } from "../use-catalog";
import { TARGET_LANGUAGES } from "../../modules/shared/settings/model";

const PURPOSES = ["analysis", "translation"] as const satisfies readonly Purpose[];
type Change = Request<"update-quick-settings">["change"];

/**
 * The launcher's settings panel: target language, and the connection and model for analysis and
 * translation, with a way to the full settings page. It runs in the page, so it never reads the
 * settings itself: the background hands it names and choices (no keys or addresses), lists a
 * connection's models with the key it holds, and applies each change as it's made.
 */
export function QuickSettings({ onClose }: { onClose: () => void }) {
  const id = useId();
  const [view, setView] = useState<View>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });

  useEffect(() => {
    let current = true;
    background.request({ type: "quick-settings" }).then(
      (reply) => { if (current) reply.status === "ok" ? setView(reply.settings) : setStatus({ text: "无法读取设置，请刷新页面后重试。", error: true }); },
      () => { if (current) setStatus({ text: "无法读取设置，请刷新页面后重试。", error: true }); },
    );
    return () => { current = false; };
  }, []);
  // Each purpose's models, listed by the background for the connection it's on.
  const catalogs: Record<Purpose, Catalog> = {
    analysis: useCatalog(view && { type: "connection-models", purpose: "analysis", connection: view.analysis.connection }).catalog,
    translation: useCatalog(view && { type: "connection-models", purpose: "translation", connection: view.translation.connection }).catalog,
  };

  async function update(change: Change) {
    setBusy(true);
    setStatus({ text: "正在保存…" });
    const reply = await background.request({ type: "update-quick-settings", change }).catch(() => undefined);
    setBusy(false);
    if (reply?.status === "ok") {
      setView(reply.settings);
      setStatus({ text: "已保存，之后翻译的内容会用新的设置。" });
    } else {
      setStatus({ text: reply?.status === "invalid" ? reply.error : "保存失败，请重试。", error: true });
    }
  }
  async function openSettings() {
    try {
      await background.request({ type: "open-settings" });
      onClose();
    } catch {
      setStatus({ text: "无法打开设置页，请刷新页面后重试。", error: true });
    }
  }

  // Controls stay enabled while a change saves: disabling the one in use would drop its focus.
  const disabled = !view;
  return (
    <div className="flex flex-col gap-4 p-4" translate="no" aria-busy={busy || undefined}>
      <div className="-mt-1 -mr-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">翻译设置</h2>
        <Button type="button" variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="关闭" onClick={onClose}>
          <X />
        </Button>
      </div>

      <Field label="目标语言" htmlFor={`${id}-language`}>
        <Select value={view?.language ?? ""} disabled={disabled} onValueChange={(value) => update({ language: value })}>
          <SelectTrigger id={`${id}-language`} size="sm" className="w-full">
            <SelectValue placeholder="正在读取…" />
          </SelectTrigger>
          <SelectContent>
            {TARGET_LANGUAGES.map(({ code, name }) => <SelectItem key={code} value={code}>{name}</SelectItem>)}
          </SelectContent>
        </Select>
      </Field>

      {PURPOSES.map((purpose) => {
        const choice = view?.[purpose];
        const known = choice && view.connections.some((c) => c.id === choice.connection);
        return (
          <section key={purpose} className="flex flex-col gap-2" aria-labelledby={`${id}-${purpose}`}>
            <h3 id={`${id}-${purpose}`} className="text-xs font-medium text-muted-foreground">{PURPOSE_NAMES[purpose]}</h3>
            <Field label="连接" htmlFor={`${id}-${purpose}-connection`}>
              <Select value={choice?.connection ?? ""} disabled={disabled} onValueChange={(value) => update({ [purpose]: { connection: value } })}>
                <SelectTrigger id={`${id}-${purpose}-connection`} size="sm" className="w-full" aria-invalid={!!choice && !known}>
                  <SelectValue placeholder="正在读取…" />
                </SelectTrigger>
                <SelectContent>
                  {choice && !known && <SelectItem value={choice.connection}>（已删除的连接）</SelectItem>}
                  {view?.connections.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label="模型" htmlFor={`${id}-${purpose}-model`}>
              <ModelControl
                id={`${id}-${purpose}-model`}
                model={choice?.model ?? ""}
                catalog={catalogs[purpose]}
                disabled={disabled}
                onChange={(model) => choice && update({ [purpose]: { connection: choice.connection, model } })}
              />
            </Field>
          </section>
        );
      })}

      {status.text && (
        <p role="status" aria-live="polite" className={cn("text-xs", status.error ? "text-destructive" : "text-muted-foreground")}>{status.text}</p>
      )}
      <Button type="button" variant="link" size="sm" className="h-auto self-start p-0" onClick={openSettings}>
        更多设置 →
      </Button>
    </div>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[56px_minmax(0,1fr)] items-center gap-2">
      <Label htmlFor={htmlFor} className="text-[13px] font-normal text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

/** A searchable list of the connection's models once it loads; otherwise a field to type a model ID. */
function ModelControl({ id, model, catalog, disabled, onChange }: {
  id: string;
  model: string;
  catalog: Catalog;
  disabled: boolean;
  onChange: (model: string) => void;
}) {
  const [typed, setTyped] = useState(model);
  useEffect(() => setTyped(model), [model]);
  if (catalog.status === "ok" && catalog.models.length) {
    // A model the list doesn't have is still offered: the background says if the purpose can't use it.
    return <ModelPicker id={id} value={model} models={catalog.models} allowCustom disabled={disabled} size="sm" className="w-full" onChange={onChange} />;
  }
  // No list to pick from (still loading, signed out, no key, or the list failed): type an ID.
  return (
    <Input
      id={id}
      className="h-8 text-[13px] md:text-[13px]"
      autoComplete="off"
      spellCheck={false}
      placeholder={catalog.status === "loading" ? "正在读取模型…" : "模型 ID"}
      disabled={disabled}
      value={typed}
      onChange={(event) => setTyped(event.target.value)}
      onBlur={() => typed !== model && onChange(typed)}
      onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
    />
  );
}
