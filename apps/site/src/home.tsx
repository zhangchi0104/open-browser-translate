import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Layout } from "./Layout";
import { PRIVACY_PATH, RELEASES_URL, REPO_URL, STORE_URL } from "./links";
import inline from "../../../store/chrome/screenshot-1-inline-translation.png";
import quickSettings from "../../../store/chrome/screenshot-2-quick-settings.png";
import consent from "../../../store/chrome/screenshot-3-data-consent.png";
import "./style.css";

const FEATURES = [
  { title: "Side by side", text: "Each translation appears beneath its paragraph, so you can read both languages without the page's layout changing." },
  { title: "On screen first", text: "Paragraphs in view are translated first; the rest follow as you scroll." },
  { title: "Only what's worth reading", text: "On articles and documentation it translates the main text and leaves menus, buttons and ads alone." },
  { title: "Consistent terms", text: "It remembers how names and terms were translated on a site and keeps using them on later pages." },
] as const;

const CONNECTIONS = [
  { name: "OpenAI", text: "with your API key" },
  { name: "Sign in with ChatGPT", text: "on your ChatGPT plan" },
  { name: "Vercel AI Gateway", text: "many providers' models, one key" },
  { name: "OpenAI-compatible API", text: "including a model on your own computer" },
] as const;

function Screenshot({ src, alt, className }: { src: string; alt: string; className?: string }) {
  return <img src={src} alt={alt} width={1280} height={800} className={`w-full rounded-xl border bg-card shadow-sm ${className ?? ""}`} />;
}

function Home() {
  return (
    <Layout>
      <section className="mx-auto max-w-[960px] px-4 pt-16 pb-12 sm:px-8 sm:pt-24">
        <h1 className="max-w-[640px] text-[32px] leading-tight font-semibold sm:text-[40px]">Translate the page you're reading, in place, with models you choose.</h1>
        <p className="mt-4 max-w-[640px] text-base leading-relaxed text-muted-foreground">
          A browser extension that puts translations beneath the original text, on-screen text first, using your own API key, a local server or your ChatGPT plan. Its interface is in Simplified Chinese.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          {STORE_URL
            ? <a href={STORE_URL} className="inline-flex h-10 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90">Add to Chrome</a>
            : <span className="inline-flex h-10 items-center rounded-md border bg-card px-5 text-sm text-muted-foreground">Chrome Web Store · coming soon</span>}
          <a href={RELEASES_URL} className="inline-flex h-10 items-center rounded-md border bg-card px-5 text-sm font-medium hover:bg-accent">Download</a>
          <a href={REPO_URL} className="inline-flex h-10 items-center rounded-md px-3 text-sm font-medium text-muted-foreground hover:text-foreground">View source →</a>
        </div>
        <Screenshot src={inline} alt="An English article with a Chinese translation beneath each paragraph" className="mt-12" />
      </section>

      <section className="mx-auto max-w-[960px] px-4 py-12 sm:px-8">
        <div className="grid gap-x-10 gap-y-8 sm:grid-cols-2">
          {FEATURES.map(({ title, text }) => (
            <div key={title}>
              <h2 className="font-semibold">{title}</h2>
              <p className="mt-1.5 text-[15px] leading-relaxed text-muted-foreground">{text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto grid max-w-[960px] items-center gap-10 px-4 py-12 sm:px-8 md:grid-cols-[1fr_1.4fr]">
        <div>
          <h2 className="text-xl font-semibold">Bring your own model</h2>
          <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">No account with us, no subscription, and no server of ours in between. Content analysis and translation can each use their own model.</p>
          <ul className="mt-5 divide-y rounded-xl border bg-card">
            {CONNECTIONS.map(({ name, text }) => (
              <li key={name} className="flex items-baseline justify-between gap-4 px-4 py-3 text-sm">
                <span className="font-medium whitespace-nowrap">{name}</span>
                <span className="text-right text-muted-foreground">{text}</span>
              </li>
            ))}
          </ul>
        </div>
        <Screenshot src={quickSettings} alt="The launcher's quick settings: target language, connections and models" />
      </section>

      <section className="mx-auto grid max-w-[960px] items-center gap-10 px-4 py-12 sm:px-8 md:grid-cols-[1fr_1.4fr]">
        <div>
          <h2 className="text-xl font-semibold">Your text goes only where you send it</h2>
          <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">
            Before the first translation, the extension tells you where page text will go and waits for your consent. API keys and sign-in details stay in your browser. No analytics, no ads.
          </p>
          <a href={PRIVACY_PATH} className="mt-4 inline-block text-sm font-medium text-primary underline-offset-4 hover:underline">Read the privacy policy →</a>
        </div>
        <Screenshot src={consent} alt="The prompt shown before the first translation" />
      </section>

      <section className="mx-auto max-w-[960px] px-4 pt-12 pb-20 sm:px-8">
        <h2 className="text-xl font-semibold">Languages</h2>
        <p className="mt-2 max-w-[640px] text-[15px] leading-relaxed text-muted-foreground">
          Translates into Simplified Chinese by default, or into Traditional Chinese, English, Japanese, Korean, French, German, Spanish, Portuguese or Russian, chosen from the launcher's quick settings.
        </p>
      </section>
    </Layout>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Home /></StrictMode>);
