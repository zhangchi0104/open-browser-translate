import { Schema } from "effect";
import { TermPair } from "../../shared/protocol";
import { DEFAULT_TARGET_LANGUAGE } from "../../shared/settings/model";

/**
 * What a site's earlier translations leave behind for later batches and pages:
 * recent page titles (the topic), the glossary the model chose, and the last
 * few translated passages (the voice).
 */
export const TranslationContext = Schema.Struct({
  pages: Schema.Array(Schema.String),
  glossary: Schema.Array(TermPair),
  recent: Schema.Array(TermPair),
  updatedAt: Schema.Number,
});
export type TranslationContext = typeof TranslationContext.Type;

/** The slice of a context sent with one batch. */
export type PromptContext = Omit<TranslationContext, "updatedAt">;

const MAX_PAGES = 5;
export const MAX_GLOSSARY = 60;
export const MAX_RECENT = 3;
// Only glossary terms that occur in the batch are sent, at most this many.
const MAX_PROMPT_TERMS = 20;
const MAX_TERMS_PER_BATCH = 10;
const MAX_TERM_LENGTH = 80;
const MAX_RECENT_LENGTH = 300;
const MAX_TITLE_LENGTH = 200;
// A site not translated for a week starts fresh.
export const CONTEXT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const emptyContext = (now: number): TranslationContext => ({ pages: [], glossary: [], recent: [], updatedAt: now });

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
 * What a site's context is kept under: its glossary and recent passages are in one language, so
 * each target language has its own. Simplified Chinese keeps the bare site, as before.
 */
export function contextKeyOf(site: string | undefined, language: string): string | undefined {
  return site && language !== DEFAULT_TARGET_LANGUAGE ? `${site} ${language}` : site;
}

export const isFresh = (context: TranslationContext, now: number) => now - context.updatedAt < CONTEXT_TTL_MS;

/** Records a page the reader started translating; the newest titles describe the topic. */
export function notePage(context: TranslationContext, title: string, now: number): TranslationContext {
  const trimmed = title.trim().slice(0, MAX_TITLE_LENGTH);
  if (!trimmed) return { ...context, updatedAt: now };
  const pages = context.pages.filter((page) => page !== trimmed).concat(trimmed).slice(-MAX_PAGES);
  return { ...context, pages, updatedAt: now };
}

/**
 * Folds one translated batch into the context. Terms are kept only when their
 * source actually appears in the batch, so a model (or page text posing as
 * instructions) cannot plant glossary entries for text it never saw.
 */
export function recordBatch(
  context: TranslationContext,
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
  const recent = context.recent
    .concat(segments
      .filter(({ source, target }) => source.trim() && target.trim())
      .map(({ source, target }) => ({ source: source.slice(0, MAX_RECENT_LENGTH), target: target.slice(0, MAX_RECENT_LENGTH) })))
    .slice(-MAX_RECENT);
  return { pages: context.pages, glossary, recent, updatedAt: now };
}

/** Picks the part of a context worth sending with a batch of texts. */
export function promptContext(context: TranslationContext, texts: readonly string[]): PromptContext | undefined {
  const batchText = texts.join("\n").toLowerCase();
  const glossary = context.glossary
    .filter(({ source }) => batchText.includes(source.toLowerCase()))
    .slice(-MAX_PROMPT_TERMS);
  const prompt = { pages: context.pages, glossary, recent: context.recent };
  return prompt.pages.length || prompt.glossary.length || prompt.recent.length ? prompt : undefined;
}
