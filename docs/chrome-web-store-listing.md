# Chrome Web Store 首次上传清单

第一版必须在 [Chrome 开发者后台](https://chrome.google.com/webstore/devconsole) 手动创建条目：Chrome Web Store API v2 不能创建新条目。之后的版本由 CI 通过 `wxt submit` 提交。

这份清单按后台的页签顺序排列，写明每个字段填什么。`<<尖括号>>` 是要你自己填的占位符。素材都在 `store/chrome/`。

## 0. 上传前

- [ ] **填好占位符。** `docs/privacy-policy.md` 中有 `<<开发者名称>>`、`<<联系邮箱>>`、`<<支持网址>>`（英文部分对应 `<<Developer name>>`、`<<Contact email>>`、`<<Support URL>>`）。
- [ ] **拿到隐私政策的公开 URL**（见第 7 节）。仓库目前是私有的，GitHub 上的文件链接和 Issues 页外人都打不开。支持网址也要能公开访问。
- [ ] **准备安装包。** 这个分支合并到 `main` 后，semantic-release 会发布新版本，并把 `open-browser-translate-<版本>-chrome.zip` 附在 GitHub Release 上。上传这个 zip，商店里的版本号就和 tag 一致。本地也可以用 `bun run zip` 打包，产物在 `.output/`。
  - 包里应当带有：中英 `_locales`、新图标、去掉 `api.typesafe.ai` 之后的权限。
  - 以后每次上传的版本号都必须比上一次高。semantic-release 会自动递增，不要手动改版本号。
- [ ] **准备开发者账号。** 首次注册要付一次性注册费。账号设置在 **Account（帐号）** 页签：
  - **Publisher name（发布者名称）**：`<<开发者名称>>`，会显示在商店里每个条目的标题下方。
  - **Contact email（联系邮箱）**：`<<联系邮箱>>`。后台会发一封验证邮件，必须点链接完成验证，否则不能提交。
  - **Trader / non-trader（是否为经营者，EU DSA 要求）**：个人开发、不收费的开源项目通常选 **non-trader（非经营者）**。选 trader 需要公开法定名称、电话和地址。这项由你判断。

## 1. 新建条目

后台点 **New item（新增内容）**，上传第 0 步的 zip。创建完成后先不要提交，把下面几个页签填完。

## 2. Store listing（商品详情）页签

### 2.1 标题和摘要（来自安装包，后台不能改）

商店按浏览器语言显示 `_locales` 里的 `extName` 和 `extDescription`（`public/_locales/*/messages.json`）。摘要最多 132 个字符。

| 语言 | 标题 | 摘要 |
| --- | --- | --- |
| English (`en`，默认) | Open Browser Translate | Translate the page you're reading in place, on-screen text first, with AI models you choose: an API key, a local server or ChatGPT.（131 字符） |
| 中文（简体）(`zh_CN`) | Open Browser Translate - 网页翻译 | 用你自己选的大模型就地翻译正在读的网页，先译眼前的内容。支持 OpenAI、Vercel AI Gateway、OpenAI 兼容接口和 ChatGPT 登录。（80 字符） |

要改标题或摘要，就改 `messages.json`，然后发一个新版本。

### 2.2 详细说明

安装包里有 `en` 和 `zh_CN` 两个语言，后台页面顶部的语言下拉框里会出现这两项，切换后分别填写。说明只能是纯文本，不支持 HTML 或 Markdown，`•` 这样的符号可以正常显示。

**English**

```text
Open Browser Translate translates the web page you're reading right where it is. Each translation appears beneath its original paragraph, so you can read both side by side. Text on screen is translated first, and the rest follows as you scroll.

It runs on AI models you choose and pay for yourself: no account with us, no subscription, and no server of ours in between.

HOW IT WORKS
• Click the floating button on any page to translate it. Click it again to return to the original.
• A quick first pass works out what kind of page it is. On articles and documentation, it translates the main text and leaves menus, buttons and ads alone.
• Translations stream in as the model writes them, nearest the viewport first.
• Terms stay consistent across a site: the extension remembers how names and terms were translated and reuses them on later pages.
• Translated paragraphs are cached on your device for 7 days, so going back to a page is instant and costs nothing.

CONNECT YOUR OWN MODEL
• OpenAI, with an API key
• Sign in with ChatGPT, to translate on your ChatGPT plan (OpenAI's sign-in for open-source apps)
• Vercel AI Gateway, for models from many providers with one key
• Any OpenAI-compatible API, including a model running on your own computer
Content analysis and translation can each use their own connection and model.

LANGUAGES
Translates into Simplified Chinese by default, and into Traditional Chinese, English, Japanese, Korean, French, German, Spanish, Portuguese or Russian. Switch languages from the button's quick settings. The extension's own interface is in Simplified Chinese.

PRIVACY
Before your first translation, the extension tells you where page text will go and asks for your consent. After that, page text is sent only when you click translate, and only to the model service you configured. API keys and sign-in details stay in your browser; they are never synced or sent anywhere else. No analytics, no ads. Private windows leave no cache or history behind.
Privacy policy: <<隐私政策 URL>>

You need an API key for one of the services above, or a ChatGPT plan. Your provider bills you for usage.
```

**中文（简体）**

```text
Open Browser Translate 在你正在阅读的网页上就地翻译：每段译文显示在原文下方，原文和译文可以对照着读。屏幕上看得到的内容先翻译，其余部分随着你往下滚动陆续译出。

翻译用的是你自己选择、自己付费的大模型：不用注册我们的账号，没有订阅费，中间也不经过我们的服务器。

怎么用
• 在任意网页上点击悬浮按钮开始翻译，再点一次恢复原文。
• 先快速判断页面类型：文章和文档只翻译正文，不翻译菜单、按钮和广告。
• 译文边生成边显示，离视口近的内容先出来。
• 同一站点的术语保持一致：扩展会记住人名和术语之前的译法，在后续页面里继续沿用。
• 翻译过的段落在本机缓存 7 天，再次打开同一页面时直接显示，不再消耗额度。

连接你自己的模型
• OpenAI：使用 API key
• 用 ChatGPT 登录：用你的 ChatGPT 订阅额度翻译（OpenAI 为开源应用提供的登录方式）
• Vercel AI Gateway：一个 key 即可使用多家厂商的模型
• 任何 OpenAI 兼容接口，包括在你自己电脑上运行的模型
内容分析和翻译可以分别使用不同的连接和模型。

语言
默认翻译成简体中文，也可以翻译成繁体中文、英语、日语、韩语、法语、德语、西班牙语、葡萄牙语或俄语，在悬浮按钮的快捷设置里切换。扩展自身的界面是简体中文。

隐私
第一次翻译前，扩展会说明网页文字将发往哪里，并征得你的同意。此后只有你点击翻译时，网页文字才会发送出去，而且只发给你设置的模型服务。API key 和登录信息只保存在你的浏览器里，不会同步，也不会发到其他任何地方。没有统计代码，没有广告。无痕窗口里翻译不留下缓存和记录。
隐私政策：<<隐私政策 URL>>

使用前需要上面任一服务的 API key，或者一个 ChatGPT 订阅。用量费用由对应的服务商收取。
```

### 2.3 其他字段

| 字段 | 填什么 |
| --- | --- |
| Category（类别） | **Productivity → Tools**（生产力 → 工具）。备选：Make Chrome Yours → Accessibility。 |
| Language（语言） | 默认语言是 English（与 manifest 的 `default_locale: "en"` 一致）。中文（简体）的说明在页面顶部的语言下拉框里切换后填写。 |
| Homepage URL（首页网址） | `<<首页网址>>`，可选。仓库公开后可以填仓库地址。 |
| Support URL（支持网址） | `<<支持网址>>`。必须能公开访问。 |
| Official URL（官方网址） | 留空。只有在 Search Console 验证过所有权的网站才能填。 |
| Mature content（成人内容） | 否。 |
| YouTube video（宣传视频） | 留空，可选。 |

### 2.4 图片素材

| 字段 | 文件 | 规格 |
| --- | --- | --- |
| Store icon（商店图标） | `store/chrome/icon-128.png` | 128×128 PNG，96×96 主体，四周各留 16px 透明边距。与 `public/icon/128.png` 是同一张图。 |
| Screenshots（屏幕截图），按顺序上传 | `store/chrome/screenshot-1-inline-translation.png` | 1280×800。网页内联翻译：译文在原文下方，导航和署名不翻译。 |
| | `store/chrome/screenshot-2-quick-settings.png` | 1280×800。悬浮启动器和快捷设置面板（目标语言、模型）。 |
| | `store/chrome/screenshot-3-data-consent.png` | 1280×800。第一次翻译前的告知和同意面板。 |
| | `store/chrome/screenshot-4-settings-connections.png` | 1280×800。设置页"连接"：ChatGPT 登录和 API 连接。 |
| | `store/chrome/screenshot-5-settings-cache-dark.png` | 1280×800。设置页"翻译缓存"，深色主题。 |
| Small promo tile（小型宣传图，必填） | `store/chrome/promo-small-440x280.png` | 440×280，不透明。 |
| Marquee promo tile（大型宣传图，可选） | `store/chrome/promo-marquee-1400x560.png` | 1400×560，不透明。只有想被商店首页推荐时才需要。 |

截图是中文界面，英文条目也可以用同一组（截图可以按语言分别上传，不传就共用）。宣传图不能按语言区分。

截图来自真实运行的扩展：Chromium 加载 `.output/chrome-mv3`，翻译一篇虚构的英文文章。模型请求由本地模拟的 `api.openai.com` 应答，返回预先写好的译文（`store/chrome/source/screenshots/translations.json`）。重新生成的方法：

```sh
bun run build
npm i -g playwright && npx playwright install chromium
sudo NODE_PATH="$(npm root -g)" node store/chrome/source/screenshots/capture-screenshots.cjs   # 截图，需要 443 端口
NODE_PATH="$(npm root -g)" node store/chrome/source/render.cjs                                  # 图标和宣传图
```

图标的源文件是 `store/chrome/source/icon.svg`，宣传图的源文件是 `store/chrome/source/promo-*.html`。

## 3. Privacy practices（隐私权）页签

审核人员主要读英文，建议粘贴英文版。中文版只是给你对照用的。

### 3.1 Single purpose（单一用途）

```text
Translate the web page the user is reading, in place, into a language the user chooses, using an AI model service the user configures (an OpenAI or Vercel AI Gateway API key, Sign in with ChatGPT, or an OpenAI-compatible server).
```

> 中文对照：用用户自己配置的大模型服务（OpenAI 或 Vercel AI Gateway 的 API key、ChatGPT 登录，或 OpenAI 兼容接口），把用户正在阅读的网页就地翻译成用户选择的语言。

### 3.2 Permission justification（权限理由）

**`storage`**

```text
Keeps the user's settings (target language, model connections with their API keys, chosen models), the ChatGPT sign-in tokens, the floating button's position, whether the user agreed to send page text, per-site translation context (recent page titles and term translations) and a local debug log in chrome.storage.local on the user's device. Nothing is synced or sent to the developer.
```

> 中文对照：在用户设备的 chrome.storage.local 中保存设置（目标语言、模型连接及其 API key、所选模型）、ChatGPT 登录令牌、悬浮按钮位置、用户是否同意发送网页文字、每个站点的翻译上下文（最近的页面标题和术语译法）以及本地调试日志。不同步，也不发送给开发者。

**Host permission justification（主机权限理由）**

这一个字段同时覆盖 `host_permissions`、`optional_host_permissions` 和内容脚本的 `matches`（`http://*/*`、`https://*/*`）。上限约 1000 字符，下面这段 880 字符。

```text
Content script on http/https pages: shows the translate button; only after the user clicks it, reads the page's text and writes translations beneath it. It matches all sites because users translate whatever page they read.
ai-gateway.vercel.sh, api.openai.com: the background sends the page text to the model service the user configured (Vercel AI Gateway or OpenAI) and lists its models. Keys never reach the page.
auth.openai.com: Sign in with ChatGPT (OAuth token exchange and ID token keys).
http://127.0.0.1/*: OpenAI's sign-in redirects to the loopback address http://127.0.0.1:45173/callback, which OpenAI requires; the extension reads the code from that tab's URL and closes it. Nothing listens there.
Optional https://*/* and http://*/*: requested at runtime, only for the origin of a custom OpenAI-compatible server the user adds (e.g. a local model), when they save it.
```

> 中文对照：
> - **内容脚本（所有 http/https 页面）**：显示翻译按钮。用户点击之后才读取页面文字，并把译文写在原文下方。用户可能翻译任何网站，所以匹配所有站点。
> - **ai-gateway.vercel.sh、api.openai.com**：后台把页面文字发给用户配置的模型服务（Vercel AI Gateway 或 OpenAI），并读取可用模型列表。API key 不会进入网页。
> - **auth.openai.com**：用 ChatGPT 登录（OAuth 换取令牌、获取 ID 令牌的验签公钥）。
> - **http://127.0.0.1/\***：OpenAI 登录只接受回环地址作为回调，会跳转到 `http://127.0.0.1:45173/callback`。扩展从该标签页的网址读出授权码后关闭标签页，这个端口上没有任何服务在监听。
> - **可选的 https://\*/\*、http://\*/\***：只在用户保存自定义 OpenAI 兼容接口（例如本地模型）时，在运行时请求该接口所在源的权限。

内容脚本匹配所有站点，可选权限又是 `<all_urls>` 级别，预计会进入人工深度审核，耗时比普通审核长。

### 3.3 Remote code（远程代码）

选择 **No, I am not using remote code（否，我没有使用远程代码）**。如果后台要求填理由：

```text
All JavaScript ships in the package, bundled at build time with WXT/Vite. The extension uses no eval, new Function, remotely hosted scripts or Wasm. Model API responses are JSON data; translations are inserted into the page with textContent only, never as HTML or code.
```

> 中文对照：全部 JavaScript 在构建时由 WXT/Vite 打包进安装包。不使用 eval、new Function、远程脚本或 Wasm。模型接口返回的是 JSON 数据，译文只通过 textContent 写入页面，从不作为 HTML 或代码执行。

已核对：构建产物 `.output/chrome-mv3` 中没有 `eval(`、`new Function(`、`importScripts(`，也没有远程 `import()`。

### 3.4 Data usage（数据使用）

勾选以下类别。这里勾选的内容必须与隐私政策和扩展的实际行为一致，宁可多报，不要少报。

| 类别 | 勾选 | 依据 |
| --- | --- | --- |
| Personally identifiable information（个人身份信息） | ✅ | 用 ChatGPT 登录时，从 ID 令牌读出账号邮箱，保存在本机，只用于在设置页显示。 |
| Health information（健康信息） | ☐ | |
| Financial and payment information（财务和付款信息） | ☐ | |
| Authentication information（身份验证信息） | ✅ | API key、ChatGPT 的访问/刷新/ID 令牌。保存在本机，只发给对应的服务用于鉴权。 |
| Personal communications（个人通讯） | ☐ | 翻译邮件页面时，邮件文字属于"网站内容"。 |
| Location（位置） | ☐ | |
| Web history（网络浏览记录） | ✅ | 同一站点最近翻译过的页面标题保存在本机（最多 5 个），并作为上下文随后续翻译请求发给模型；调试追踪在本机记录页面的站点和路径。 |
| User activity（用户活动） | ☐ | 不记录点击、键盘输入或滚动行为。滚动只用来决定先翻译哪些段落，不保存。 |
| Website content（网站内容） | ✅ | 用户点击翻译后，页面文字和页面标题、描述等上下文发给用户配置的模型服务。 |

三项声明全部勾选：

- [x] I do not sell or transfer user data to third parties, outside of the approved use cases（不向第三方出售或转让用户数据，已获批准的用途除外）
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose（不将用户数据用于与本条目单一用途无关的目的）
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes（不将用户数据用于判断信用或贷款）

页面文字发给用户自己选择的模型服务，属于实现单一用途所必需、并且是用户主动发起的数据传输，不算第一条所说的出售或转让。

### 3.5 Privacy policy（隐私权政策）

填第 7 节得到的公开 URL。

## 4. Distribution（分发）页签

| 字段 | 建议 |
| --- | --- |
| Payments（付款） | 不含应用内购买。 |
| Visibility（公开范围） | **Public（公开）**。想先自己装来验证，可以先选 **Unlisted（不公开）**，审核标准一样。 |
| Regions（地区） | All regions（所有地区）。 |

## 5. 提交审核

1. 所有页签都没有红色提示后，点 **Submit for review（提交审核）**。
2. 弹窗里可以取消勾选 **Publish automatically after approval（审核通过后自动发布）**，改为延迟发布：审核通过后有 30 天时间手动点发布，超时会退回草稿。
3. 审核结果会发到联系邮箱。被拒时邮件会写明违反了哪条政策（例如 Purple Potassium 表示请求了多余的权限）。

## 6. 首次上传之后：为 CI 准备 ID 和服务账号

CI 用 `wxt submit`（底层是 `publish-browser-extension`）调用 Chrome Web Store API v2。需要以下 GitHub secrets（仓库 Settings → Secrets and variables → Actions）：

| Secret | 从哪里拿 |
| --- | --- |
| `CHROME_EXTENSION_ID` | 条目创建后，后台条目名称下方显示的 32 位小写字母 ID。它也出现在商店链接 `chromewebstore.google.com/detail/<slug>/<ID>` 里。 |
| `CHROME_PUBLISHER_ID` | 后台网址 `chrome.google.com/webstore/devconsole/<publisher-id>/...` 中的那一段，也可以在 Account 页签的发布者信息里找到。 |
| `CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL` | 服务账号 JSON 密钥里的 `client_email`。 |
| `CHROME_SERVICE_ACCOUNT_PRIVATE_KEY` | 服务账号 JSON 密钥里的 `private_key`，完整的 PEM 文本，包括 `-----BEGIN PRIVATE KEY-----` 和 `-----END PRIVATE KEY-----` 两行。 |

服务账号的设置步骤：

1. 在 [Google Cloud Console](https://console.cloud.google.com/) 新建或选择一个项目，启用 **Chrome Web Store API**。
2. 在 IAM → Service Accounts 中创建一个服务账号，不需要授予任何 IAM 角色。在 Keys 页签新建一个 JSON 密钥，下载到本地。
3. 回到 Chrome 开发者后台的 **Account（帐号）** 页签，在服务账号一栏添加第 2 步得到的 `client_email`，让它有权管理这个发布者的条目。
4. 把四个值填进 GitHub secrets。私钥要保留真实换行：把 JSON 里 `private_key` 的 `\n` 换成真正的换行再粘贴。GitHub secret 支持多行文本。
5. 填完后从本地删除 JSON 密钥文件，不要提交进仓库。

`wxt submit` 默认仍使用旧的 v1.1 接口，而 v1.1 将于 **2026-10-15 停止服务**。所以 CI 里必须设置环境变量 `CHROME_API_VERSION=v2`（它不是机密，可以直接写在 workflow 的 `env:` 里）。

CI 的提交步骤大致如下：

```yaml
- name: Submit to Chrome Web Store
  run: bunx wxt submit --chrome-zip .output/*-chrome.zip
  env:
    CHROME_API_VERSION: v2
    CHROME_EXTENSION_ID: ${{ secrets.CHROME_EXTENSION_ID }}
    CHROME_PUBLISHER_ID: ${{ secrets.CHROME_PUBLISHER_ID }}
    CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL: ${{ secrets.CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL }}
    CHROME_SERVICE_ACCOUNT_PRIVATE_KEY: ${{ secrets.CHROME_SERVICE_ACCOUNT_PRIVATE_KEY }}
```

可以先加 `--dry-run` 验证凭据，再正式提交。

## 7. 隐私政策的公开 URL

商店要求隐私政策和支持网址能被任何人打开。仓库目前是私有的，所以 GitHub 上的文件链接（`github.com/.../blob/...`）和 Issues 页外人都打不开。可选的做法：

| 方案 | 得到的 URL | 说明 |
| --- | --- | --- |
| A. 把仓库设为公开，再开 GitHub Pages | `https://zhangchi0104.github.io/open-browser-translate/privacy-policy/` | 仓库 Settings → Pages，Source 选 "Deploy from a branch"，分支选 `main`（或 `dev`），目录选 `/docs`。`docs/privacy-policy.md` 开头的 front matter 已经设好 `permalink: /privacy-policy/`，Jekyll 会把它渲染成网页。注意 `docs/` 下的 ADR 等文档也会一起发布。仓库公开后，Issues 也可以直接当支持网址。 |
| B. 只把仓库设为公开，不开 Pages | `https://github.com/zhangchi0104/open-browser-translate/blob/main/docs/privacy-policy.md` | 最省事，商店接受这样的链接。 |
| C. 仓库保持私有，开 GitHub Pages | 同方案 A | 私有仓库使用 Pages 需要 GitHub Pro。发布出来的站点仍然公开，只有仓库保持私有。 |
| D. 仓库保持私有，另建一个公开仓库或公开 Gist 存放政策 | `https://gist.github.com/<用户名>/<id>` 或新仓库的 Pages 地址 | 改政策时要记得两边同步。 |

拿到 URL 之后，把它填进三个地方：后台 Privacy 页签的隐私政策字段，以及两份详细说明里的 `<<隐私政策 URL>>`。

## 8. 已知风险和待办

- **界面内的数据披露和同意（已实现）。** Chrome Web Store 2026 年的政策更新（2026-08-01 起执行）要求：数据收集要在扩展界面里显著披露，并在收集之前取得用户的明确同意。这条是根据政策公告的检索摘要整理的，确切条文以 [官方政策页面](https://developer.chrome.com/docs/webstore/program-policies) 为准。
  - 扩展的做法：第一次点击启动器时不翻译，先在旁边弹出"翻译前请确认"面板，说明本页的文字和标题会发给哪个模型服务（显示设置里所选连接的名称）。用户点"同意并翻译"之后才发送。
  - 同意记录在 `local:dataConsent`，带有 `DATA_CONSENT_VERSION`（`src/modules/shared/settings/model.ts`）。以后发送的内容或去向有变化时，把版本号加一，用户会被重新询问。
  - 截图 3 展示的就是这个面板。如果审核人员问起，可以引用它。
- **Firefox 的数据披露。** `wxt.config.ts` 中 Firefox 的 `data_collection_permissions` 只声明了 `websiteContent`。如果要与这里的 Chrome 披露保持一致，可以考虑补上 `authenticationInfo` 和 `personallyIdentifyingInfo`，并改为可选或必需。
- **扩展界面只有中文。** 英文条目的说明里已经写明"界面是简体中文"，避免用户看到界面后给差评。
