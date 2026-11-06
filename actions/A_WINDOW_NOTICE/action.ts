import type { ActionContext } from "../../types";

interface Input {
  body: string;
  items: unknown[];
  windowDay: string;
  windowZone: string;
  windowNote: string;
  [key: string]: unknown;
}

export default {
  async execute(input: Input, _ctx: ActionContext): Promise<Record<string, unknown>> {
    const { body, items, windowDay, windowZone, windowNote, ...upstream } = input;
    const day = `${windowDay} (${windowZone})`;
    const note = windowNote ? `\n${windowNote}` : "";
    if (items.length === 0) return { ...upstream, items, body: `No articles from ${day}.${note}\n` };
    const count = items.length === 1 ? "1 article" : `${items.length} articles`;
    return { ...upstream, items, body: `${count} from ${day}.${note}\n\n${body.trim()}\n` };
  },
};
