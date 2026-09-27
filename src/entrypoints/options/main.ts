import "./style.css";
import { aiSettings, validateModel, type AISettings, type SettingsProvider, type AnalysisProvider, type TranslationProvider } from "../../modules/settings";
import { AiProviders } from "../../modules/ai/providers";

const form = document.querySelector<HTMLFormElement>("#settings-form")!;
const fields = document.querySelector<HTMLFieldSetElement>("#fields")!;
const provider = document.querySelector<HTMLSelectElement>("#provider")!;
const apiKey = document.querySelector<HTMLInputElement>("#api-key")!;
const toggle = document.querySelector<HTMLButtonElement>("#toggle-key")!;
const status = document.querySelector<HTMLParagraphElement>("#status")!;
const keyLink = document.querySelector<HTMLAnchorElement>("#key-link")!;
const analysisProvider = document.querySelector<HTMLSelectElement>("#analysis-provider")!;
const translationProvider = document.querySelector<HTMLSelectElement>("#translation-provider")!;
const analysisModel = document.querySelector<HTMLInputElement>("#analysis-model")!;
const translationModel = document.querySelector<HTMLInputElement>("#translation-model")!;
let draft: AISettings;
let active: SettingsProvider = AiProviders.VercelAIGateway;
let dirty = false;

function message(text: string, error = false) {
  status.textContent = text;
  status.dataset.error = String(error);
}
function stash() {
  draft.providers[active].apiKey = apiKey.value.trim();
  draft.analysis.models[draft.analysis.provider] = analysisModel.value.trim();
  draft.translation.models[draft.translation.provider] = translationModel.value.trim();
}
function renderModels() {
  analysisProvider.value = draft.analysis.provider;
  translationProvider.value = draft.translation.provider;
  analysisModel.value = draft.analysis.models[draft.analysis.provider];
  translationModel.value = draft.translation.models[draft.translation.provider];
  analysisModel.setCustomValidity("");
  translationModel.setCustomValidity("");
  analysisModel.placeholder = draft.analysis.provider === AiProviders.VercelAIGateway ? "typesafe-ai/jev" : "jev-latest";
  translationModel.placeholder = draft.translation.provider === AiProviders.VercelAIGateway ? "provider/model" : "模型 ID";
  document.querySelector("#analysis-help")!.textContent = draft.analysis.provider === AiProviders.VercelAIGateway
    ? "通过 Vercel 调用 Jev，默认模型为 typesafe-ai/jev。"
    : "通过 TypeSafe 调用 Jev，默认模型为 jev-latest。";
  document.querySelector("#translation-help")!.textContent = draft.translation.provider === AiProviders.VercelAIGateway
    ? "填写网关中的翻译模型 ID，格式为 provider/model。"
    : "填写 OpenAI 的文本生成模型 ID。";
}
function renderKey() {
  provider.value = active;
  apiKey.value = draft.providers[active].apiKey;
  apiKey.type = "password";
  toggle.textContent = "显示";
  toggle.setAttribute("aria-pressed", "false");
  toggle.setAttribute("aria-label", "显示 API key");
  const uses = [draft.analysis.provider === active ? "内容分析" : "", draft.translation.provider === active ? "翻译" : ""].filter(Boolean);
  document.querySelector("#provider-help")!.textContent = uses.length ? `当前用于：${uses.join("、")}` : "此服务商暂未被选用，可先保存 key。";
  keyLink.href = active === AiProviders.VercelAIGateway ? "https://vercel.com/dashboard"
    : active === AiProviders.TypeSafe ? "https://console.typesafe.ai" : "https://platform.openai.com/api-keys";
}
function markDirty() { dirty = true; message("有未保存的更改"); }
provider.addEventListener("change", () => {
  stash();
  active = provider.value as SettingsProvider;
  renderKey();
});
analysisProvider.addEventListener("change", () => {
  stash();
  draft.analysis.provider = analysisProvider.value as AnalysisProvider;
  renderModels();
  renderKey();
  markDirty();
});
translationProvider.addEventListener("change", () => {
  stash();
  draft.translation.provider = translationProvider.value as TranslationProvider;
  renderModels();
  renderKey();
  markDirty();
});
form.addEventListener("input", (event) => {
  if (event.target === provider) return;
  analysisModel.setCustomValidity("");
  translationModel.setCustomValidity("");
  markDirty();
});
toggle.addEventListener("click", () => {
  const show = apiKey.type === "password";
  apiKey.type = show ? "text" : "password";
  toggle.textContent = show ? "隐藏" : "显示";
  toggle.setAttribute("aria-pressed", String(show));
  toggle.setAttribute("aria-label", show ? "隐藏 API key" : "显示 API key");
});
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  stash();
  for (const [input, selection] of [[analysisModel, draft.analysis.provider], [translationModel, draft.translation.provider]] as const) {
    const error = validateModel(selection, input.value);
    if (error) {
      input.setCustomValidity(error);
      message(`${input === analysisModel ? "内容分析" : "翻译"}：${error}`, true);
      input.reportValidity();
      return;
    }
  }
  fields.disabled = true;
  message("正在保存…");
  try {
    await aiSettings.setValue(structuredClone(draft));
    dirty = false;
    message("设置已保存");
  } catch {
    message("保存失败，请重试。", true);
  } finally { fields.disabled = false; }
});
form.addEventListener("invalid", () => {
  message("设置尚未保存，请检查标出的模型 ID。", true);
}, true);
document.querySelector("#remove-key")!.addEventListener("click", async () => {
  fields.disabled = true;
  try {
    const saved = await aiSettings.getValue();
    saved.providers[active].apiKey = "";
    await aiSettings.setValue(saved);
    draft.providers[active].apiKey = "";
    apiKey.value = "";
    message("已移除该服务商保存的 key" + (dirty ? "；其他更改尚未保存" : ""));
  } catch { message("移除失败，请重试。", true); }
  finally { fields.disabled = false; }
});
window.addEventListener("beforeunload", (event) => { if (dirty) event.preventDefault(); });
async function load() {
  try {
    draft = structuredClone(await aiSettings.getValue());
    renderModels();
    renderKey();
    fields.disabled = false;
    message("");
  } catch { message("无法读取设置，请刷新页面重试。", true); }
}
void load();
