import type { ActionContext } from "../../types";

interface Input {
  body: string;
  items: unknown[];
  windowDay: string;
  windowZone: string;
  windowNote: string;
  language?: string;
  [key: string]: unknown;
}

interface Wording {
  none: (day: string) => string;
  some: (count: number, day: string) => string;
}

const ENGLISH: Wording = {
  none: (day) => `No articles found for ${day}.`,
  some: (count, day) => `${count === 1 ? "1 article" : `${count} articles`} from ${day}.`,
};

const WORDINGS: Record<string, Wording> = {
  de: {
    none: (day) => `Keine Artikel vom ${day} gefunden.`,
    some: (count, day) => `${count} Artikel vom ${day}.`,
  },
};

export default {
  async execute(input: Input, _ctx: ActionContext): Promise<Record<string, unknown>> {
    const { body, items, windowDay, windowZone, windowNote, ...upstream } = input;
    const wording = (input.language && WORDINGS[input.language]) || ENGLISH;
    const day = `${windowDay} (${windowZone})`;
    const note = windowNote ? `\n${windowNote}` : "";
    if (items.length === 0) return { ...upstream, items, body: `${wording.none(day)}${note}\n` };
    return { ...upstream, items, body: `${wording.some(items.length, day)}${note}\n\n${body.trim()}\n` };
  },
};
