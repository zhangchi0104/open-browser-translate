---
title: Open Browser Translate 隐私政策 / Privacy Policy
permalink: /privacy-policy/
---

# Open Browser Translate 隐私政策

最后更新：2026-10-05

Open Browser Translate（下称"本扩展"）是一个浏览器扩展。它在你阅读网页时，把网页文字就地翻译成你选择的语言，翻译由你自己配置的大模型服务完成。本扩展由 <<开发者名称>> 开发和维护。

**简短版本：** 本扩展没有自己的服务器，开发者收不到你的任何数据。只有在你点击翻译之后，网页文字才会发送出去，而且只发给你在设置里选择的模型服务。API key、登录信息、缓存和日志都只保存在你这台设备的浏览器里。

## 1. 本扩展处理哪些数据

### 1.1 网页内容

在一个网页上点击悬浮启动器开始翻译之后，本扩展会把以下内容发送给你在设置中为"内容分析"和"翻译"选择的模型服务：

- 待翻译的文字块，以及它们的 HTML 标签名（例如 `p`、`h2`）。
- 帮助模型理解上下文的内容：页面标题、页面的 meta 描述、第一个主标题、正文开头的一小段样本、分页链接的文字，以及当前文字块前面的一段原文。
- 同一站点之前翻译留下的上下文：最近翻译过的几个页面的标题、模型选定的术语译法，以及最近的几段原文和译文。

本扩展不会把网页的网址、Cookie、表单输入、密码框内容或浏览历史发送给模型服务。你不点击翻译，本扩展就不发送任何网页内容。

### 1.2 凭据和账号信息

- 你在设置中填写的 API key 和自定义接口地址。
- 如果你使用"用 ChatGPT 登录"：OpenAI 签发的访问令牌、刷新令牌、ID 令牌，以及你的 ChatGPT 账号邮箱。邮箱只用来在设置页显示你登录的是哪个账号。

这些信息保存在浏览器的扩展本地存储（`chrome.storage.local`）中，不会同步到其他设备。它们只会发给对应的服务用于身份验证：API key 发给它所属的服务，ChatGPT 令牌只发给 OpenAI（`auth.openai.com` 和 `api.openai.com`）。

### 1.3 只保存在本机的数据

以下数据只保存在你的浏览器里，任何时候都不会离开你的设备：

- **翻译缓存**：保存译文，原文只以 SHA-256 哈希的形式保存。缓存按站点和模型区分，保留 7 天，最多 20,000 段。
- **内容分析缓存**：保存每个文字块属于哪类内容（正文、导航等），保留期限和数量上限与翻译缓存相同。
- **站点上下文**：每个站点最近翻译过的页面标题、术语表和最近几段译文。一周没有再翻译的站点会被清除，最多保留 50 个站点。
- **调试日志和请求追踪**：最近 500 条日志和 100 次请求的记录。请求追踪包含发给模型的提示词、上下文、原文和译文，以及页面地址（只记录站点和路径，不记录查询参数），不记录 API key。你可以在设置页的"调试日志"中查看、导出或清空这些记录。导出由你手动操作，本扩展不会自动上传。
- 你的设置，以及悬浮启动器在页面上的位置。

在无痕窗口中翻译时，本扩展不写入缓存，不保存站点上下文，也不在日志中记录页面地址。

## 2. 数据会发给谁

网页内容只会发给你自己选择的模型服务，可能是以下几种：

- **OpenAI**（`api.openai.com`），使用你的 API key，或者通过"用 ChatGPT 登录"使用你的 ChatGPT 订阅。登录流程经过 `auth.openai.com`。参见 [OpenAI 隐私政策](https://openai.com/policies/privacy-policy/)。
- **Vercel AI Gateway**（`ai-gateway.vercel.sh`），使用你的 Vercel API key。网关会把请求转给你选择的模型提供方。参见 [Vercel 隐私政策](https://vercel.com/legal/privacy-policy)。
- **你自己填写的 OpenAI 兼容接口**，例如本地运行的模型服务或第三方平台。只有在你保存这个连接、并在浏览器弹出的权限请求中同意之后，本扩展才能访问该地址。

这些服务如何处理你发送的内容，受它们各自的条款和隐私政策约束，与本扩展无关。如果你填写的自定义接口使用 `http://` 而不是 `https://`，数据在传输途中不会被加密，请只在可信的网络中这样使用（例如本机）。

开发者不运营任何服务器，不接收、不存储、也看不到你的网页内容、API key 或账号信息。

## 3. 我们不做的事

- 不出售或转让用户数据。
- 不把用户数据用于翻译以外的目的，包括广告、用户画像和信用评估。
- 不包含分析、统计或追踪代码，不展示广告。
- 不加载或执行远程代码。扩展的全部代码都在安装包内，模型返回的译文只作为纯文本显示在页面上。

本扩展对用户数据的使用遵守 [Chrome 应用商店用户数据政策](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)，包括其中的"有限使用"（Limited Use）要求。

## 4. 你的控制权

- **停止翻译**：再次点击悬浮启动器，页面恢复原文，翻译停止。
- **清空缓存**：在设置页的"翻译缓存"中清空翻译缓存和内容分析缓存。
- **清空日志**：在设置页的"调试日志"中清空日志和请求追踪。
- **退出登录、删除连接**：在设置页的"连接"中退出 ChatGPT 登录，或删除 API 连接和其中的 key。
- **全部删除**：卸载本扩展后，浏览器会删除它保存的全部数据。

## 5. 儿童

本扩展不面向 13 岁以下的儿童，也不会有意收集他们的个人信息。

## 6. 政策变更

如果本扩展处理数据的方式发生变化，我们会更新本页面和页首的"最后更新"日期，并在扩展的更新说明中写明。

## 7. 联系方式

如有疑问，请联系：<<联系邮箱>>，或访问 <<支持网址>>。

---

# Open Browser Translate Privacy Policy

Last updated: 2026-10-05

Open Browser Translate ("the extension") is a browser extension. It translates the web page you are reading in place, into a language you choose, using an AI model service you set up yourself. It is developed and maintained by <<Developer name>>.

**In short:** the extension has no servers of its own, and its developer receives none of your data. Page text is sent only after you start a translation, and only to the model service you chose in the settings. API keys, sign-in details, caches and logs stay in the browser on your device.

## 1. Data the extension handles

### 1.1 Website content

After you click the floating launcher on a page to translate it, the extension sends the following to the model service you chose for "content analysis" and "translation" in the settings:

- The blocks of text to translate, with the name of each block's HTML tag (such as `p` or `h2`).
- Context that helps the model understand the page: the page title, its meta description, its first main heading, a short sample of its opening text, the labels of its pagination links, and the original text just before the blocks being translated.
- Context left by earlier translations on the same site: the titles of a few recently translated pages, the renderings the model chose for terms, and a few recent passages with their translations.

The extension does not send the page's URL, cookies, form input, password fields or browsing history to model services. Until you click translate, it sends no page content at all.

### 1.2 Credentials and account information

- The API keys and custom API addresses you enter in the settings.
- If you use "Sign in with ChatGPT": the access, refresh and ID tokens OpenAI issues, and your ChatGPT account's email address. The email is used only to show in the settings which account is signed in.

These are kept in the extension's local storage (`chrome.storage.local`) and are not synced to your other devices. They are sent only to the matching service, to authenticate: an API key goes to the service it belongs to, and ChatGPT tokens go only to OpenAI (`auth.openai.com` and `api.openai.com`).

### 1.3 Data kept only on your device

The following data stays in your browser and never leaves your device:

- **Translation cache**: translations, with the original text stored only as a SHA-256 hash. Entries are kept per site and model for 7 days, at most 20,000 of them.
- **Content analysis cache**: which kind of content each block is (main text, navigation and so on). It has the same retention and limit as the translation cache.
- **Site context**: for each site, the titles of recently translated pages, the glossary and the latest translated passages. A site not translated for a week is cleared, and at most 50 sites are kept.
- **Debug log and request traces**: the newest 500 log entries and 100 requests. Traces include the prompts, context, original text and translations sent to and returned by the model, and the page address (site and path only, without the query string). They do not include API keys. You can view, export or clear them under "Debug log" (调试日志) in the settings. Exporting is something you do by hand; the extension never uploads them.
- Your settings, and where the floating launcher sits on the page.

In private (incognito) windows, the extension writes no cache, keeps no site context, and records no page address in its logs.

## 2. Where data goes

Page content goes only to the model service you choose, which can be:

- **OpenAI** (`api.openai.com`), with your API key or through "Sign in with ChatGPT" on your ChatGPT plan. Signing in goes through `auth.openai.com`. See [OpenAI's privacy policy](https://openai.com/policies/privacy-policy/).
- **Vercel AI Gateway** (`ai-gateway.vercel.sh`), with your Vercel API key. The gateway passes requests on to the model provider you pick. See [Vercel's privacy policy](https://vercel.com/legal/privacy-policy).
- **An OpenAI-compatible server you enter yourself**, such as a model running on your own computer or a third-party platform. The extension can reach that address only after you save the connection and accept the browser's permission prompt for it.

How these services handle what you send is governed by their own terms and privacy policies. If a custom server's address starts with `http://` rather than `https://`, data travels to it unencrypted; use that only on networks you trust, such as your own computer.

The developer runs no servers, and does not receive, store or see your page content, API keys or account information.

## 3. What we don't do

- We don't sell or transfer user data.
- We don't use user data for anything other than translation, including advertising, profiling or determining creditworthiness.
- The extension contains no analytics or tracking code and shows no ads.
- The extension loads and runs no remote code. All of its code ships in the package, and translations returned by the model are shown on the page only as plain text.

The extension's use of user data complies with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including the Limited Use requirements.

## 4. Your choices

- **Stop translating**: click the launcher again. The page returns to its original text and translation stops.
- **Clear caches**: clear the translation and content analysis caches under "Translation cache" (翻译缓存) in the settings.
- **Clear logs**: clear the log and request traces under "Debug log" (调试日志).
- **Sign out or remove connections**: sign out of ChatGPT, or remove an API connection and its key, under "Connections" (连接).
- **Delete everything**: uninstall the extension, and the browser deletes everything it stored.

## 5. Children

The extension is not directed at children under 13, and does not knowingly collect their personal information.

## 6. Changes

If the way the extension handles data changes, this page and the "Last updated" date at the top will be updated, and the change will be described in the extension's release notes.

## 7. Contact

Questions: <<Contact email>>, or visit <<Support URL>>.
