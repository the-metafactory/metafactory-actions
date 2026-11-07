import { Marked } from "marked";
import type { ActionContext } from "../../types";

interface Input {
  body: string;
  [key: string]: unknown;
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
const unescapeEntities = (text: string): string => text.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity] ?? entity);
const escapeHtml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The normalised address, ready for an attribute, or null for anything but an absolute http or https link. */
function webHref(href: string): string | null {
  const address = unescapeEntities(href);
  if (!/^https?:\/\//i.test(address) || !URL.canParse(address)) return null;
  return new URL(address).href.replace(/'/g, "%27").replace(/&/g, "&amp;");
}

/**
 * Returning undefined from a tokenizer turns it off, so raw HTML is never recognised and reaches the inline text path, which
 * escapes it. This also keeps marked out of its raw block state, where text after a tag such as <pre> is left unescaped.
 * The renderers drop what the default would emit beyond plain formatting: images, titles, language classes and checkboxes.
 */
const renderer = new Marked({
  gfm: true,
  breaks: true,
  async: false,
  tokenizer: {
    html: () => undefined,
    tag: () => undefined,
  },
  renderer: {
    link({ href, tokens }) {
      const text = this.parser.parseInline(tokens);
      const safe = webHref(href);
      return safe ? `<a href="${safe}">${text}</a>` : text;
    },
    image({ text }) {
      return text;
    },
    code({ text }) {
      return `<pre><code>${escapeHtml(text)}</code></pre>\n`;
    },
    checkbox({ checked }) {
      return checked ? "[x]" : "[ ]";
    },
  },
});

export default {
  async execute(input: Input, _ctx: ActionContext): Promise<Record<string, unknown>> {
    return { ...input, html: renderer.parse(input.body.replace(CONTROL, ""), { async: false }) };
  },
};
