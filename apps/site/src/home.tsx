import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Layout } from "./Layout";
import { PRIVACY_PATH, RELEASES_URL, REPO_URL, STORE_URL } from "./links";
import inline from "../../../store/chrome/screenshot-1-inline-translation.png";
import quickSettings from "../../../store/chrome/screenshot-2-quick-settings.png";
import consent from "../../../store/chrome/screenshot-3-data-consent.png";
import "./style.css";

const FEATURES = [
  { title: "就地对照", text: "译文显示在原文下方，两种语言对照着读，页面排版不变。" },
  { title: "先译眼前的内容", text: "屏幕上看得到的段落先翻译，其余的随着滚动陆续译出。" },
  { title: "只译值得译的", text: "先判断页面类型：文章和文档只译正文，跳过菜单、按钮和广告。" },
  { title: "术语前后一致", text: "记住同一站点里人名和术语的译法，后面的页面继续沿用。" },
] as const;

const CONNECTIONS = [
  { name: "OpenAI", text: "使用你的 API key" },
  { name: "ChatGPT 登录", text: "用你的 ChatGPT 订阅额度翻译" },
  { name: "Vercel AI Gateway", text: "一个 key 使用多家厂商的模型" },
  { name: "OpenAI 兼容接口", text: "包括在你自己电脑上运行的模型" },
] as const;

function Screenshot({ src, alt, className }: { src: string; alt: string; className?: string }) {
  return <img src={src} alt={alt} width={1280} height={800} className={`w-full rounded-xl border bg-card shadow-sm ${className ?? ""}`} />;
}

function Home() {
  return (
    <Layout>
      <section className="mx-auto max-w-[960px] px-4 pt-16 pb-12 sm:px-8 sm:pt-24">
        <h1 className="max-w-[640px] text-[32px] leading-tight font-semibold sm:text-[40px]">就地翻译你正在读的网页，用你自己选择的大模型。</h1>
        <p className="mt-4 max-w-[640px] text-base leading-relaxed text-muted-foreground">
          Translate the page you're reading in place, on-screen text first, with AI models you choose. The extension's interface is in Simplified Chinese.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          {STORE_URL
            ? <a href={STORE_URL} className="inline-flex h-10 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90">添加到 Chrome</a>
            : <span className="inline-flex h-10 items-center rounded-md border bg-card px-5 text-sm text-muted-foreground">Chrome 应用商店 · 即将上线</span>}
          <a href={RELEASES_URL} className="inline-flex h-10 items-center rounded-md border bg-card px-5 text-sm font-medium hover:bg-accent">下载安装包</a>
          <a href={REPO_URL} className="inline-flex h-10 items-center rounded-md px-3 text-sm font-medium text-muted-foreground hover:text-foreground">查看源码 →</a>
        </div>
        <Screenshot src={inline} alt="一篇英文文章，每段下方显示中文译文" className="mt-12" />
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
          <h2 className="text-xl font-semibold">连接你自己的模型</h2>
          <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">不用注册我们的账号，没有订阅费，中间也不经过我们的服务器。内容分析和翻译可以分别用不同的模型。</p>
          <ul className="mt-5 divide-y rounded-xl border bg-card">
            {CONNECTIONS.map(({ name, text }) => (
              <li key={name} className="flex items-baseline justify-between gap-4 px-4 py-3 text-sm">
                <span className="font-medium">{name}</span>
                <span className="text-right text-muted-foreground">{text}</span>
              </li>
            ))}
          </ul>
        </div>
        <Screenshot src={quickSettings} alt="启动器的快捷设置面板，可以切换目标语言、连接和模型" />
      </section>

      <section className="mx-auto grid max-w-[960px] items-center gap-10 px-4 py-12 sm:px-8 md:grid-cols-[1fr_1.4fr]">
        <div>
          <h2 className="text-xl font-semibold">你的文字，只发给你选的服务</h2>
          <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">
            第一次翻译前会先说明网页文字将发往哪里，你同意后才发送。API key 和登录信息只保存在本机浏览器里，没有统计代码，也没有广告。
          </p>
          <a href={PRIVACY_PATH} className="mt-4 inline-block text-sm font-medium text-primary underline-offset-4 hover:underline">阅读隐私政策 →</a>
        </div>
        <Screenshot src={consent} alt="第一次翻译前弹出的确认面板" />
      </section>

      <section className="mx-auto max-w-[960px] px-4 pt-12 pb-20 sm:px-8">
        <h2 className="text-xl font-semibold">Languages</h2>
        <p className="mt-2 max-w-[640px] text-[15px] leading-relaxed text-muted-foreground">
          默认翻译成简体中文，也支持繁体中文、英语、日语、韩语、法语、德语、西班牙语、葡萄牙语和俄语。
          Translates into Simplified Chinese by default, and into nine other languages from the launcher's quick settings.
        </p>
      </section>
    </Layout>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Home /></StrictMode>);
