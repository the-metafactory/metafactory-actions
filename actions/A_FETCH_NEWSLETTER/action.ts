import type { ActionContext } from "../../types";
import { shellEscape } from "../../utils";

interface Input {
  account?: string;
  searchQuery: string;
  fromAddress?: string;
  [key: string]: unknown;
}

export default {
  async execute(input: Input, ctx: ActionContext) {
    const { account = "personal", searchQuery, fromAddress, ...upstream } = input;
    const shell = ctx.capabilities.shell!;

    if (!searchQuery) {
      throw new Error("searchQuery is required — e.g. 'unsupervised learning' or 'wisereads'");
    }

    let cmd = `email search ${shellEscape(searchQuery)} --limit 1 --output json`;
    if (fromAddress) {
      cmd += ` --from ${shellEscape(fromAddress)}`;
    }

    const searchResult = await shell(cmd);

    if (searchResult.code !== 0) {
      throw new Error(`Email search failed: ${searchResult.stderr}`);
    }

    const emails = JSON.parse(searchResult.stdout);
    if (!emails.length) {
      throw new Error(`No emails found for query: ${searchQuery}`);
    }

    const { uid, subject } = emails[0];

    const getResult = await shell(
      `email get --uid ${String(uid)} --account ${shellEscape(account)}`
    );

    if (getResult.code !== 0) {
      throw new Error(`Email get failed: ${getResult.stderr}`);
    }

    return {
      ...upstream,
      emailBody: getResult.stdout,
      emailSubject: subject,
      emailUid: uid,
      fetchedAt: new Date().toISOString(),
    };
  },
};
