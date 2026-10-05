import type { ReactNode } from "react";
import icon from "../../../store/chrome/icon-128.png";
import { HOME_PATH, ISSUES_URL, PRIVACY_PATH, REPO_URL } from "./links";

/** Header, page and footer shared by every page of the site. */
export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-14 max-w-[960px] items-center gap-4 px-4 sm:gap-6 sm:px-8">
          <a href={HOME_PATH} className="flex min-w-0 items-center gap-2.5 font-semibold">
            {/* The icon keeps its 16/128 transparent margin; the negative margin trims it. */}
            <img src={icon} alt="" className="-m-1 size-8 shrink-0" />
            <span className="truncate">Open Browser Translate</span>
          </a>
          <nav className="ml-auto flex shrink-0 items-center gap-5 text-sm whitespace-nowrap text-muted-foreground">
            <a href={PRIVACY_PATH} className="hover:text-foreground">Privacy</a>
            <a href={REPO_URL} className="hover:text-foreground">GitHub</a>
          </nav>
        </div>
      </header>
      <main className="flex-1">{children}</main>
      <footer className="border-t">
        <div className="mx-auto flex max-w-[960px] flex-wrap gap-x-5 gap-y-2 px-4 py-6 text-[13px] text-muted-foreground sm:px-8">
          <span className="truncate">Open Browser Translate</span>
          <a href={PRIVACY_PATH} className="hover:text-foreground">Privacy policy</a>
          <a href={ISSUES_URL} className="hover:text-foreground">Support</a>
          <a href={REPO_URL} className="hover:text-foreground">Source</a>
        </div>
      </footer>
    </div>
  );
}
