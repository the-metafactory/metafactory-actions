import { describe, expect, test } from "bun:test";
import type { ActionContext } from "../../types";
import action from "./action";

const context: ActionContext = { capabilities: {}, env: { mode: "local" } };
const window = { windowDay: "2026-11-05", windowZone: "Europe/Zurich", windowNote: "" };

describe("A_WINDOW_NOTICE", () => {
  test("an empty window drops whatever the model wrote", async () => {
    const out = await action.execute({ ...window, items: [], body: "- Invented article" }, context);
    expect(out.body).toBe("No articles from 2026-11-05 (Europe/Zurich).\n");
  });

  test("an empty window still says why it may be empty", async () => {
    const out = await action.execute({ ...window, items: [], body: "x", windowNote: "The feed reaches back only to 2026-11-06 07:00." }, context);
    expect(out.body).toBe("No articles from 2026-11-05 (Europe/Zurich).\nThe feed reaches back only to 2026-11-06 07:00.\n");
  });

  test("a whole day leads with its date and count", async () => {
    const out = await action.execute({ ...window, items: [{}, {}], body: "- one\n- two\n" }, context);
    expect(out.body).toBe("2 articles from 2026-11-05 (Europe/Zurich).\n\n- one\n- two\n");
  });

  test("a partial day says so ahead of the summary, by code", async () => {
    const out = await action.execute({ ...window, items: [{}], body: "- one", windowNote: "Only the first 1 of 2 articles from 2026-11-05 are included." }, context);
    expect(out.body).toBe("1 article from 2026-11-05 (Europe/Zurich).\nOnly the first 1 of 2 articles from 2026-11-05 are included.\n\n- one\n");
  });

  test("the rest of the payload reaches the delivery step", async () => {
    const out = await action.execute({ ...window, items: [{}], body: "- one", subject: "Daily" }, context);
    expect(out.subject).toBe("Daily");
  });
});
