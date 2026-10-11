// Where the built-in providers' APIs live and how Anthropic's takes a key. Kept apart from the
// adapters so the options page can use them without bundling a model client.

export const ANTHROPIC_API_URL = "https://api.anthropic.com";
export const OPENROUTER_API_URL = "https://openrouter.ai/api/v1";

/**
 * The background's requests carry the extension's origin, which Anthropic's API refuses unless the
 * caller says it means to call from a browser with the user's own key, as this extension does.
 */
export const ANTHROPIC_BROWSER_ACCESS = { "anthropic-dangerous-direct-browser-access": "true" } as const;

/** Headers for an Anthropic API request with `apiKey`. */
export const anthropicHeaders = (apiKey: string) => ({ "x-api-key": apiKey, "anthropic-version": "2023-06-01", ...ANTHROPIC_BROWSER_ACCESS });
