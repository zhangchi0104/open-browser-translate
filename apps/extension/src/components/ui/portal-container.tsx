import { createContext, useContext } from "react"

/**
 * Where overlays (select menus, popovers) portal to. Unset, Radix uses `document.body`, which is
 * right for the settings page; UI in a shadow root on someone else's page sets it to its own
 * container so overlays stay inside the shadow root, styled and above the page.
 */
const PortalContainerContext = createContext<HTMLElement | null>(null)

export const PortalContainerProvider = PortalContainerContext.Provider

export function usePortalContainer() {
  return useContext(PortalContainerContext) ?? undefined
}
