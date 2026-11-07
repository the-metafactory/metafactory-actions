import { describe, expect, test } from "bun:test";
import type { ActionContext } from "../../types";
import action from "./action";

const context: ActionContext = { capabilities: {}, env: { mode: "local" } };
const render = async (body: string): Promise<string> => (await action.execute({ body }, context)).html as string;

const DIGEST = `50 Artikel vom 2026-11-06 (Europe/Zurich).

### Sicherheit
- **Patchday:** Microsoft schliesst 12 Lücken in Windows & Office.
- **Router:** Hersteller warnt vor offenem Admin-Zugang.

### KI
- **Modell:** Neues Sprachmodell läuft lokal auf dem Mac.
`;

const ELEMENTS = /^<\/?(?:h[1-6]|p|strong|em|del|code|pre|blockquote|ul|ol|li|table|thead|tbody|tr|th|td|a|br|hr)(?: (?:href|start|align)="[^"<>]*")?>$/;

describe("A_FORMAT_MARKDOWN on a digest", () => {
  test("headings, bold and the list render", async () => {
    const html = await render(DIGEST);
    expect(html).toContain("<h3>Sicherheit</h3>");
    expect(html).toContain("<strong>Patchday:</strong>");
    expect(html).toContain("<li><strong>Router:</strong> Hersteller warnt vor offenem Admin-Zugang.</li>");
    expect(html).toContain("Windows &amp; Office");
    expect(html).not.toContain("**");
    expect(html).not.toContain("###");
  });

  test("the notice line and a note below it stay on two lines", async () => {
    expect(await render("1 Artikel vom 2026-11-06 (Europe/Zurich).\nOnly the first 1 of 2 are included.\n\n- eins\n")).toContain("(Europe/Zurich).<br>Only the first");
  });

  test("the body stays the plain text and the rest of the payload passes on", async () => {
    const out = await action.execute({ body: DIGEST, subject: "Täglich", windowDay: "2026-11-06" }, context);
    expect(out.body).toBe(DIGEST);
    expect(out.subject).toBe("Täglich");
    expect(out.windowDay).toBe("2026-11-06");
  });

  test("it replaces an html field an earlier step wrote", async () => {
    const out = await action.execute({ body: "plain", html: "<script>alert(1)</script>" }, context);
    expect(out.html).toBe("<p>plain</p>\n");
  });
});

describe("A_FORMAT_MARKDOWN on hostile text", () => {
  const inert: [string, string][] = [
    ["a block script", "<script>alert(1)</script>"],
    ["an inline script", "text <script>alert(1)</script> text"],
    ["a script in capitals", "<SCRIPT>alert(1)</SCRIPT>"],
    ["an unclosed tag", "<img src=x onerror=alert(1) "],
    ["an image tag", '<img src="https://tracker.example/x.png">'],
    ["a tag that opens a raw block", "<pre> <img src=x onerror=alert(1)  </pre>"],
    ["a style", "<style>a{background:url(https://tracker.example/x)}</style>"],
    ["a comment", "<!-- x --><b>y</b>"],
    ["an iframe", '<iframe src="https://example.org"></iframe>'],
    ["a javascript link", "[click](javascript:alert(1))"],
    ["a javascript link in capitals", "[click](JaVaScRiPt:alert(1))"],
    ["a javascript autolink", "<javascript:alert(1)>"],
    ["a data link", "[click](data:text/html;base64,PHNjcmlwdD4=)"],
    ["a vbscript link", "[click](vbscript:x)"],
    ["a mailto autolink", "<someone@example.com>"],
    ["an entity hiding a scheme", "[click](java&#115;cript:alert(1))"],
    ["a reference link", "[click][r]\n\n[r]: javascript:alert(1)"],
    ["a relative link", "[click](/path)"],
    ["a markdown image", "![alt](https://tracker.example/x.png)"],
    ["an image with markup in its alt", '![<b onclick="x">](https://tracker.example/x.png)'],
    ["an image inside a link", "[![alt](https://tracker.example/x.png)](https://example.org)"],
    ["a title with a quote", '[click](https://example.org "x\\" onclick=\\"alert(1)")'],
    ["a fence language with markup", '```"><script>alert(1)</script>\ncode\n```'],
    ["a task list", "- [x] done\n- [ ] open"],
    ["a table", "| a |\n|:--|\n| <b>c</b> |"],
    ["a control character", "x\u0000y\u000cz"],
  ];
  for (const [name, body] of inert) {
    test(`${name} yields only the plain elements, with no active content`, async () => {
      const html = await render(body);
      for (const tag of html.match(/<[^>]*>?/g) ?? []) expect(tag).toMatch(ELEMENTS);
      expect(html).not.toMatch(/<(?:script|img|style|iframe|input)/i);
      expect(html).not.toMatch(/(?:src|onerror|onclick|class|title)="/);
      expect(html).not.toMatch(/href="(?!https?:\/\/)/i);
      expect(html).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/);
    });
  }

  test("raw html reaches the reader as literal text", async () => {
    expect(await render("<script>alert(1)</script>")).toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>\n");
  });

  test("a refused link keeps its words", async () => {
    expect(await render("[click](javascript:alert(1))")).toBe("<p>click</p>\n");
  });

  test("an image becomes its alt text", async () => {
    expect(await render("![a chart](https://tracker.example/x.png)")).toBe("<p>a chart</p>\n");
  });

  test("web links survive, with a query kept whole", async () => {
    expect(await render("[a](https://example.org/x?b=1&c=2) <http://example.org/y>")).toBe('<p><a href="https://example.org/x?b=1&amp;c=2">a</a> <a href="http://example.org/y">http://example.org/y</a></p>\n');
  });
});
