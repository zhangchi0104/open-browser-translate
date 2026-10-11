# Open Browser Translate Privacy Policy

Last updated: 2026-10-11 · [中文版](https://github.com/zhangchi0104/open-browser-translate/blob/dev/docs/privacy-policy.zh-CN.md)

Open Browser Translate ("the extension") is a browser extension. It translates the web page you are reading in place, into a language you choose, using an AI model service you set up yourself. It is developed and maintained by Alex Zhang.

**In short:** the extension has no servers of its own, and its developer receives none of your data. Page text is sent only after you start a translation, and only to the model service you chose in the settings. API keys, sign-in details, caches and logs stay in the browser on your device.

## 1. Data the extension handles

### 1.1 Website content

After you click the floating launcher on a page to translate it, the extension sends the following to the model service you chose for "content analysis" and "translation" in the settings:

- The blocks of text to translate, with the name of each block's HTML tag (such as `p` or `h2`).
- Context that helps the model understand the page: the page title, its meta description, its first main heading, a short sample of its opening text, the labels of its pagination links, and the original text just before the blocks being translated.
- Context left by earlier translations on the same site: the renderings the model chose for terms, and a few recent passages from the same page with their translations. On pixiv novels, this context is kept per novel series instead of per site.

Before the first translation, the extension shows a notice on the page saying which model service the page text will go to, and sends nothing until you choose "同意并翻译" (agree and translate). After that, page text is still sent only when you click translate; until you do, the extension sends no page content at all.

The extension does not send the page's URL, cookies, form input, password fields or browsing history to model services.

### 1.2 Credentials and account information

- The API keys and custom API addresses you enter in the settings.
- If you use "Sign in with ChatGPT": the access, refresh and ID tokens OpenAI issues, and your ChatGPT account's email address. The email is used only to show in the settings which account is signed in.

These are kept in the extension's local storage (`chrome.storage.local`) and are not synced to your other devices. They are sent only to the matching service, to authenticate: an API key goes to the service it belongs to, and ChatGPT tokens go only to OpenAI (`auth.openai.com` and `api.openai.com`).

### 1.3 Data kept only on your device

The following data stays in your browser and never leaves your device:

- **Translation cache**: translations, with the original text stored only as a SHA-256 hash. Entries are kept per site and model for 7 days, at most 20,000 of them.
- **Content analysis cache**: which kind of content each block is (main text, navigation and so on). It has the same retention and limit as the translation cache.
- **Site context**: for each site (or pixiv novel series), the glossary and the latest translated passages, with a hash that tells which page the passages came from, not the page's address. Context not used for a week is cleared, and at most 50 are kept.
- **Debug log and request traces**: the newest 500 log entries and 100 requests. Traces include the prompts, context, original text and translations sent to and returned by the model, and the page address (site and path only, without the query string). Traces also record each connection test: the address tested, whether a key was entered, and the server's response. They do not include API keys. You can view, export or clear them under "Debug log" (调试日志) in the settings. Exporting is something you do by hand; the extension never uploads them.
- Your settings, where the floating launcher sits on the page, and whether you agreed to send page text.

In private (incognito) windows, the extension writes no cache, keeps no site context, and records no page address in its logs.

## 2. Where data goes

Page content goes only to the model service you choose, which can be:

- **OpenAI** (`api.openai.com`), with your API key or through "Sign in with ChatGPT" on your ChatGPT plan. Signing in goes through `auth.openai.com`. See [OpenAI's privacy policy](https://openai.com/policies/privacy-policy/).
- **Anthropic** (`api.anthropic.com`), with your Anthropic API key. See [Anthropic's privacy policy](https://www.anthropic.com/legal/privacy).
- **OpenRouter** (`openrouter.ai`), with your OpenRouter API key. OpenRouter passes requests on to the model provider that serves the model you pick. See [OpenRouter's privacy policy](https://openrouter.ai/privacy).
- **Vercel AI Gateway** (`ai-gateway.vercel.sh`), with your Vercel API key. The gateway passes requests on to the model provider you pick. See [Vercel's privacy policy](https://vercel.com/legal/privacy-policy).
- **An OpenAI-compatible server you enter yourself**, such as a model running on your own computer or a third-party platform. The extension can reach that address only after you accept the browser's permission prompt for it, which appears when you save or test the connection. Testing a connection ("测试连接") asks the server once for its model list with the key you entered; it sends no page content.

When you translate a pixiv novel, the extension also asks pixiv itself (the same `www.pixiv.net` page you are on, with your pixiv sign-in) which series the novel belongs to. It sends pixiv nothing but the novel's ID, which is already in the page address.

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

Questions: support@otakuma.dev, or visit https://github.com/zhangchi0104/open-browser-translate/issues.
