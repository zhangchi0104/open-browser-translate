import { browser } from "wxt/browser";
import { createClient } from "../modules/shared/protocol";

/** Pages' connection to the background: typed requests and the translation stream. */
export const background = createClient(browser.runtime);
