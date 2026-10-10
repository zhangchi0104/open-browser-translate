import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { ChatGPTModel } from "../modules/shared/protocol";
import { filterModels, sortModels } from "./model-search";

type Option = { slug: string; label: string; description?: string; custom?: boolean };

/**
 * A connection's models to pick from, A–Z, with a search field that filters them as you type.
 * The saved model shows even when the list doesn't have it, and with `allowCustom` a search that
 * matches no model's ID can be used as the ID itself.
 */
export function ModelPicker({ id, ref, value, models, allowCustom, disabled, size = "default", className, onChange, ...aria }: {
  id: string;
  ref?: Ref<HTMLButtonElement>;
  value: string;
  models: readonly ChatGPTModel[];
  /** False when only the listed models will do (analysis on a provider's decision models). */
  allowCustom: boolean;
  disabled?: boolean;
  size?: "sm" | "default";
  className?: string;
  onChange: (model: string) => void;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const sorted = useMemo(() => sortModels(models), [models]);
  const selected = sorted.find(({ slug }) => slug === value);
  const typed = query.trim();
  const options: Option[] = [
    ...(value && !selected && !typed ? [{ slug: value, label: `${value}（不在列表中）` }] : []),
    ...filterModels(sorted, query).map(({ slug, displayName }) => ({ slug, label: displayName, description: displayName !== slug ? slug : undefined })),
    ...(allowCustom && typed && !sorted.some(({ slug }) => slug === typed) ? [{ slug: typed, label: `使用「${typed}」`, custom: true }] : []),
  ];
  const activeIndex = Math.min(active, options.length - 1);
  const current = options[activeIndex];
  const optionId = (index: number) => `${listId}-${index}`;

  // Each search starts on its first match; opening without one starts on the saved model.
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    if (!open || query) return;
    const index = options.findIndex(({ slug, custom }) => !custom && slug === value);
    setActive(Math.max(index, 0));
  }, [open]);
  useEffect(() => {
    if (open && current) list.current?.querySelector(`#${CSS.escape(optionId(activeIndex))}`)?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  function choose(option: Option) {
    setOpen(false);
    setQuery("");
    if (option.slug !== value) onChange(option.slug);
  }
  function onSearchKey(event: KeyboardEvent<HTMLInputElement>) {
    const last = options.length - 1;
    const moves: Record<string, () => number> = {
      ArrowDown: () => Math.min(active + 1, last),
      ArrowUp: () => Math.max(active - 1, 0),
      Home: () => 0,
      End: () => last,
      PageDown: () => Math.min(active + 8, last),
      PageUp: () => Math.max(active - 8, 0),
    };
    // With text in the search, Home and End move the caret instead.
    const caretKey = (event.key === "Home" || event.key === "End") && query;
    const move = moves[event.key];
    if (move && options.length && !caretKey) {
      event.preventDefault();
      setActive(move());
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (current) choose(current);
    }
  }
  // Typing on the closed picker opens it with what was typed as the search.
  function onTriggerKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
    } else if (event.key.length === 1 && event.key !== " " && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      setQuery(event.key);
      setOpen(true);
    }
  }

  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setQuery(""); }}>
      <PopoverTrigger asChild>
        <button
          ref={ref}
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          disabled={disabled}
          data-size={size}
          className={cn(
            "flex items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-2 text-left text-sm whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 data-[size=default]:h-9 data-[size=sm]:h-8 dark:bg-input/30 dark:hover:bg-input/50 dark:aria-invalid:ring-destructive/40",
            size === "sm" && "text-[13px]",
            className,
          )}
          onKeyDown={onTriggerKey}
          {...aria}
        >
          <span className={cn("min-w-0 truncate", !value && "text-muted-foreground")}>
            {selected?.displayName ?? (value || "选择模型")}
          </span>
          <ChevronDownIcon className="size-4 shrink-0 opacity-50" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="flex w-(--radix-popover-trigger-width) min-w-64 flex-col p-0"
        // Radix would select the search text, so the next key would replace what was typed to open it.
        onOpenAutoFocus={(event) => { event.preventDefault(); search.current?.focus(); }}
      >
        <div className="flex items-center gap-2 border-b px-3">
          <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            ref={search}
            className="h-9 w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            role="combobox"
            aria-label="搜索模型"
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={current ? optionId(activeIndex) : undefined}
            autoComplete="off"
            spellCheck={false}
            placeholder={allowCustom ? "搜索模型，或输入模型 ID" : "搜索模型"}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onSearchKey}
          />
        </div>
        <div ref={list} id={listId} role="listbox" aria-label="模型" className="max-h-72 overflow-y-auto p-1">
          {options.map((option, index) => (
            <div
              key={`${option.custom ? "custom" : "model"}:${option.slug}`}
              id={optionId(index)}
              role="option"
              aria-selected={index === activeIndex}
              className={cn(
                "relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm select-none",
                index === activeIndex && "bg-accent text-accent-foreground",
              )}
              // Keep focus in the search field; a click picks without blurring it.
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => index !== active && setActive(index)}
              onClick={() => choose(option)}
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="break-all">{option.label}</span>
                {option.description && <span className="font-mono text-xs break-all text-muted-foreground">{option.description}</span>}
              </div>
              {!option.custom && option.slug === value && (
                <CheckIcon className="absolute right-2 size-4 text-muted-foreground" aria-hidden="true" />
              )}
            </div>
          ))}
          {!options.length && <p className="px-2 py-6 text-center text-sm text-muted-foreground">没有匹配的模型</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}
