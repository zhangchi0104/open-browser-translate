// Reads JSON that is still arriving from a model, so translations can be shown while
// they stream. Whatever has arrived is kept, including a string still being written;
// a key, literal or escape cut off at the end is left out. Text before the first
// `{` or `[` and after the root value (code fences, chatter) is ignored.

const INCOMPLETE = Symbol("incomplete");
type Parsed = unknown | typeof INCOMPLETE;
const ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

export function parsePartialJson(text: string): unknown {
  let i = text.search(/[{[]/);
  if (i < 0) return undefined;
  // Set once the input runs out, so every enclosing value returns what it has.
  let ended = false;
  const skipSpace = () => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (i >= text.length) ended = true;
  };

  function string(): { value: string; complete: boolean } {
    i++; // opening quote
    let value = "";
    while (i < text.length) {
      const char = text[i]!;
      if (char === '"') {
        i++;
        return { value, complete: true };
      }
      if (char !== "\\") {
        value += char;
        i++;
        continue;
      }
      const code = text[i + 1];
      if (code === undefined) break;
      if (code === "u") {
        const hex = text.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
        value += String.fromCharCode(Number.parseInt(hex, 16));
        i += 6;
      } else {
        value += ESCAPES[code] ?? code;
        i += 2;
      }
    }
    ended = true;
    return { value, complete: false };
  }

  function value(): Parsed {
    skipSpace();
    if (ended) return INCOMPLETE;
    const char = text[i]!;
    if (char === "{") return object();
    if (char === "[") return array();
    if (char === '"') return string().value;
    const literal = /^(true|false|null)/.exec(text.slice(i, i + 5));
    if (literal) {
      i += literal[0].length;
      return literal[0] === "null" ? null : literal[0] === "true";
    }
    const number = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
    if (number) {
      i += number[0].length;
      if (i >= text.length) ended = true;
      return Number(number[0]);
    }
    // A literal or number cut off at the end, or something that isn't JSON.
    ended = true;
    return INCOMPLETE;
  }

  function object(): Record<string, unknown> {
    i++;
    const result: Record<string, unknown> = {};
    while (true) {
      skipSpace();
      if (ended) return result;
      const char = text[i]!;
      if (char === "}") {
        i++;
        return result;
      }
      if (char === ",") {
        i++;
        continue;
      }
      if (char !== '"') {
        ended = true;
        return result;
      }
      const key = string();
      if (!key.complete) return result;
      skipSpace();
      if (ended) return result;
      if (text[i] !== ":") {
        ended = true;
        return result;
      }
      i++;
      const item = value();
      if (item !== INCOMPLETE) result[key.value] = item;
      if (ended) return result;
    }
  }

  function array(): unknown[] {
    i++;
    const result: unknown[] = [];
    while (true) {
      skipSpace();
      if (ended) return result;
      const char = text[i]!;
      if (char === "]") {
        i++;
        return result;
      }
      if (char === ",") {
        i++;
        continue;
      }
      const item = value();
      if (item !== INCOMPLETE) result.push(item);
      if (ended) return result;
    }
  }

  const root = value();
  return root === INCOMPLETE ? undefined : root;
}

/** The translations a streaming response has produced so far: entries with an id and some text. */
export function partialTranslations(text: string): { id: number; text: string }[] {
  const translations = (parsePartialJson(text) as { translations?: unknown } | undefined)?.translations;
  if (!Array.isArray(translations)) return [];
  return translations.flatMap((entry) => {
    const { id, text: value } = (entry ?? {}) as { id?: unknown; text?: unknown };
    return typeof id === "number" && typeof value === "string" && value ? [{ id, text: value }] : [];
  });
}
