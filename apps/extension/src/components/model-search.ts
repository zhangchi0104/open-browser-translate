import type { ChatGPTModel } from "../modules/shared/protocol";

// Numeric so `gpt-5` sorts before `gpt-10`; base sensitivity so case and accents don't split names.
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** Models A–Z by the name a picker shows, then by ID; the catalog's own order means nothing to a reader. */
export function sortModels(models: readonly ChatGPTModel[]): ChatGPTModel[] {
  return [...models].sort((a, b) => collator.compare(a.displayName, b.displayName) || collator.compare(a.slug, b.slug));
}

/** The models whose name or ID contains every word of `query`, ignoring case; all of them for an empty query. */
export function filterModels(models: readonly ChatGPTModel[], query: string): readonly ChatGPTModel[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return models;
  return models.filter(({ slug, displayName }) => {
    const text = `${displayName} ${slug}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}
