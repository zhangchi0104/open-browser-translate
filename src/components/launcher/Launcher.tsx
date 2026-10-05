import { useEffect, useRef, useState } from "react";
import { Check, Languages, Settings, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { QuickSettings } from "./QuickSettings";
import { createTranslationRunner, type BadgeState, type LauncherState } from "./session";
import { useLauncherPosition } from "./use-launcher-position";

const badgeLabels: Record<BadgeState, string> = { translating: "正在翻译", done: "翻译完成", failed: "翻译失败" };

/**
 * The launcher on every page: a button that turns the page's translation on and off, a badge for how that went, the
 * settings panel, and a status line. It's a guest on someone else's page, so it stays small and
 * neutral, with the brand only in its glyph.
 */
export function Launcher() {
  const [state, setState] = useState<LauncherState>({ active: false, busy: false, badge: null, status: null });
  const [panelOpen, setPanelOpen] = useState(false);
  const runner = useRef<ReturnType<typeof createTranslationRunner> | undefined>(undefined);
  const { position, onRight, handlers, consumeDrag } = useLauncherPosition(() => setPanelOpen(false));

  useEffect(() => {
    // Progress reports often repeat what's shown; those don't re-render.
    const created = createTranslationRunner((change) => setState((current) =>
      (Object.keys(change) as (keyof LauncherState)[]).every((key) => change[key] === current[key]) ? current : { ...current, ...change }));
    runner.current = created;
    return () => created.dispose();
  }, []);

  return (
    <>
      <div
        className="group pointer-events-none fixed flex w-11 flex-col items-center gap-1.5"
        style={{ left: position.x, top: position.y }}
        translate="no"
      >
        <button
          type="button"
          className="pointer-events-auto relative grid size-11 cursor-grab touch-none place-items-center rounded-full border bg-card text-primary shadow-md transition-[background-color,transform] duration-150 ease-out outline-none select-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 active:scale-95 active:cursor-grabbing aria-pressed:border-primary aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary/90 motion-reduce:transition-none"
          aria-label="翻译此页"
          aria-pressed={state.active}
          title={state.active ? "显示原文" : "翻译此页"}
          aria-busy={state.busy || undefined}
          {...handlers}
          onClick={() => {
            if (consumeDrag()) return; // The click that ends a drag isn't a click.
            if (state.active) runner.current?.stop();
            else void runner.current?.start();
          }}
        >
          <Languages className="size-[22px]" aria-hidden="true" />
        </button>
        {state.badge && <Badge state={state.badge} />}
        <Popover open={panelOpen} onOpenChange={setPanelOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="pointer-events-auto grid size-8 place-items-center rounded-full border bg-card text-muted-foreground shadow-md transition-[opacity,background-color,color] duration-150 ease-out outline-none hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:opacity-100 motion-reduce:transition-none pointer-fine:opacity-0 pointer-fine:delay-300 pointer-fine:group-hover:opacity-100 pointer-fine:group-hover:delay-0"
              aria-label="翻译设置"
              title="翻译设置"
            >
              <Settings className="size-[17px]" aria-hidden="true" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            side={onRight ? "left" : "right"}
            align="end"
            sideOffset={12}
            collisionPadding={16}
            className="w-[300px] max-w-[calc(100vw-32px)] rounded-xl p-0"
            aria-label="翻译设置"
          >
            <QuickSettings onClose={() => setPanelOpen(false)} />
          </PopoverContent>
        </Popover>
      </div>
      {state.status !== null && (
        <div
          role="status"
          translate="no"
          className="pointer-events-none fixed bottom-4 left-4 max-w-[min(420px,calc(100vw-92px))] rounded-[10px] border bg-card px-3 py-2 text-[13px] leading-relaxed text-card-foreground shadow-md [overflow-wrap:anywhere]"
        >
          {state.status}
        </div>
      )}
    </>
  );
}

function Badge({ state }: { state: BadgeState }) {
  return (
    <span
      title={badgeLabels[state]}
      className={cn(
        "pointer-events-none absolute top-[27px] -left-[3px] grid size-[18px] place-items-center rounded-full border-2 border-card bg-card",
        state === "done" && "bg-success text-background",
        state === "failed" && "bg-destructive text-background",
      )}
    >
      {state === "translating" && (
        <span className="size-3 animate-spin rounded-full border-2 border-border border-t-primary motion-reduce:[animation-duration:2.4s]" aria-hidden="true" />
      )}
      {state === "done" && <Check className="size-3" strokeWidth={3} aria-hidden="true" />}
      {state === "failed" && <X className="size-3" strokeWidth={3} aria-hidden="true" />}
      <span className="sr-only">{badgeLabels[state]}</span>
    </span>
  );
}
