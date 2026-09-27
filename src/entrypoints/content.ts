import { createShadowRootUi } from "wxt/utils/content-script-ui/shadow-root";
import { mountTranslationLauncher } from "../components/translation-launcher";
import "../components/translation-launcher.css";

export default defineContentScript({
  matches: ["http://*/*", "https://*/*"],
  cssInjectionMode: "ui",
  async main(ctx) {
    const ui = await createShadowRootUi(ctx, {
      name: "open-browser-translate",
      position: "overlay",
      zIndex: 2147483647,
      isolateEvents: [
        "keydown",
        "keyup",
        "keypress",
        "click",
        "pointerdown",
        "pointermove",
        "pointerup",
        "pointercancel",
      ],
      onMount: mountTranslationLauncher,
      onRemove: (cleanup) => cleanup?.(),
    });
    ui.autoMount();
  },
});
