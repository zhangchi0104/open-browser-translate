import { useId, type ReactNode } from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * A titled group of rows, as system settings lay them out: one rounded surface, rows divided by
 * hairlines, and an optional footnote below for whatever a reader may want to know but rarely needs.
 */
export function SettingsGroup({ title, description, footer, children, className }: {
  title?: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <section aria-labelledby={title ? id : undefined} className={cn("space-y-2", className)}>
      {title && (
        <header className="px-1">
          <h2 id={id} className="text-[15px] font-semibold">{title}</h2>
          {description && <p className="text-[13px] text-muted-foreground">{description}</p>}
        </header>
      )}
      <div className="divide-y rounded-xl border bg-card">{children}</div>
      {footer && <div className="px-1 text-[12px] leading-relaxed text-muted-foreground">{footer}</div>}
    </section>
  );
}

/** A label (and a line of help) on the left, its control on the right; stacked on narrow screens. */
export function SettingsRow({ label, htmlFor, description, descriptionId, children, className }: {
  label: ReactNode;
  htmlFor?: string;
  description?: ReactNode;
  descriptionId?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2 px-4 py-3 sm:min-h-14 sm:flex-row sm:items-center sm:justify-between sm:gap-6", className)}>
      <div className="min-w-0 space-y-0.5">
        {htmlFor ? <Label htmlFor={htmlFor} className="text-sm font-normal">{label}</Label> : <p className="text-sm">{label}</p>}
        {description && <p id={descriptionId} className="text-[12px] leading-snug text-muted-foreground">{description}</p>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2 sm:justify-end">{children}</div>}
    </div>
  );
}
