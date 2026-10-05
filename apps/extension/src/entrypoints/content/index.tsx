import { createRoot, type Root } from "react-dom/client";
import { createShadowRootUi } from "wxt/utils/content-script-ui/shadow-root";
import { PortalContainerProvider } from "@/components/ui/portal-container";
import { Launcher } from "@/components/launcher/Launcher";
import "./style.css";

export default defineContentScript({
  matches: ["http://*/*", "https://*/*"],
  cssInjectionMode: "ui",
  async main(ctx) {
    const ui = await createShadowRootUi<Root>(ctx, {
      name: "open-browser-translate",
      position: "overlay",
      zIndex: 2147483647,
      // Kept inside the shadow root: the page's handlers never see keys, presses or focus in the
      // launcher, and overlays' outside-press checks only see presses on the page. Overlays still
      // close on Escape: they listen on the document in the capture phase, before this stops it.
      isolateEvents: [
        "keydown", "keyup", "keypress", "click",
        "pointerdown", "pointermove", "pointerup", "pointercancel",
        "focusin", "focusout",
      ],
      onMount: (container) => {
        const root = createRoot(container);
        // Menus and the settings panel portal into the shadow root, not the page's body.
        root.render(
          <PortalContainerProvider value={container}>
            <Launcher />
          </PortalContainerProvider>,
        );
        return root;
      },
      onRemove: (root) => root?.unmount(),
    });
    ui.autoMount();
  },
});
