import { Schema } from "effect";
import { TermPair } from "../../shared/protocol";
import { DEFAULT_TARGET_LANGUAGE } from "../../shared/settings/model";

/**
 * What a site's (or a work's) earlier translations leave behind for later batches: the glossary
 * the model chose, which follows the reader across pages, and the last few translated passages
 * (the voice), which only stay with the page or work they came from (`recentFrom`).
 */
export const TranslationContext = Schema.Struct({
  glossary: Schema.Array(TermPair),
  recent: Schema.Array(TermPair),
  recentFrom: Schema.optional(Schema.String),
  updatedAt: Schema.Number,
});
export type TranslationContext = typeof TranslationContext.Type;

/** The slice of a context sent with one batch. */
export type PromptContext = Pick<TranslationContext, "glossary" | "recent">;

export const MAX_GLOSSARY = 60;
export const MAX_RECENT = 3;
// Only glossary terms that occur in the batch are sent, at most this many.
const MAX_PROMPT_TERMS = 20;
const MAX_TERMS_PER_BATCH = 10;
const MAX_TERM_LENGTH = 80;
const MAX_RECENT_LENGTH = 300;
// A site not translated for a week starts fresh.
export const CONTEXT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const emptyContext = (now: number): TranslationContext => ({ glossary: [], recent: [], updatedAt: now });

/**
 * The site a page belongs to: its origin, for http and https pages only. Site context and cached
 * translations are kept per site, so they follow the reader across a site's pages. Pages without
 * a site (private windows pass no URL, browser and extension pages have none) keep nothing.
 */
export function siteOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const { protocol, origin } = new URL(url);
    return protocol === "http:" || protocol === "https:" ? origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where a batch's context is kept (`key`) and where its recent passages belong (`passages`).
 * A site's pages share one context, so the glossary follows the reader around the site, but
 * recent passages stay with their page: another page on the site may be another story entirely.
 * A work (see `workOf` in the page modules: a pixiv novel series, say) gets a context of its own,
 * kept apart from the rest of the site, and its passages carry from one chapter to the next.
 * Glossaries and passages are in one language, so each target language has its own context;
 * Simplified Chinese keeps the bare key, as before.
 */
export interface ContextScope {
  readonly key: string;
  readonly passages: string;
}

export function contextScopeOf(pageUrl: string | undefined, language: string, work?: string): ContextScope | undefined {
  const site = siteOf(pageUrl);
  if (!site) return undefined;
  const scoped = work ? `${site}/${work}` : site;
  const key = language !== DEFAULT_TARGET_LANGUAGE ? `${scoped} ${language}` : scoped;
  if (work) return { key, passages: key };
  // Only to tell pages apart: the page's address isn't kept.
  const { pathname, search } = new URL(pageUrl!);
  return { key, passages: fnv1a(`${pathname}${search}`) };
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  return (hash >>> 0).toString(36);
}

export const isFresh = (context: TranslationContext, now: number) => now - context.updatedAt < CONTEXT_TTL_MS;

/**
 * Folds one translated batch from `passages` (a `ContextScope`'s) into the context. Terms are kept
 * only when their source actually appears in the batch, so a model (or page text posing as
 * instructions) cannot plant glossary entries for text it never saw. Recent passages from
 * elsewhere give way to the batch's.
 */
export function recordBatch(
  context: TranslationContext,
  passages: string,
  segments: readonly TermPair[],
  terms: readonly TermPair[],
  now: number,
): TranslationContext {
  const batchText = segments.map(({ source }) => source.toLowerCase()).join("\n");
  const accepted = terms
    .map(({ source, target }) => ({ source: source.trim(), target: target.trim() }))
    .filter(({ source, target }) => source && target
      && source.length <= MAX_TERM_LENGTH && target.length <= MAX_TERM_LENGTH
      && batchText.includes(source.toLowerCase()))
    .slice(0, MAX_TERMS_PER_BATCH);
  // Newest rendering of a term wins; the oldest terms fall off first.
  const replaced = new Set(accepted.map(({ source }) => source.toLowerCase()));
  const glossary = context.glossary
    .filter(({ source }) => !replaced.has(source.toLowerCase()))
    .concat(accepted)
    .slice(-MAX_GLOSSARY);
  const recent = recentIn(context, passages)
    .concat(segments
      .filter(({ source, target }) => source.trim() && target.trim())
      .map(({ source, target }) => ({ source: source.slice(0, MAX_RECENT_LENGTH), target: target.slice(0, MAX_RECENT_LENGTH) })))
    .slice(-MAX_RECENT);
  return { glossary, recent, recentFrom: passages, updatedAt: now };
}

const recentIn = (context: TranslationContext, passages: string) => context.recentFrom === passages ? context.recent : [];

/** Picks the part of a context worth sending with a batch of texts from `passages`. */
export function promptContext(context: TranslationContext, passages: string, texts: readonly string[]): PromptContext | undefined {
  const batchText = texts.join("\n").toLowerCase();
  const glossary = context.glossary
    .filter(({ source }) => batchText.includes(source.toLowerCase()))
    .slice(-MAX_PROMPT_TERMS);
  const recent = recentIn(context, passages);
  return glossary.length || recent.length ? { glossary, recent } : undefined;
}
