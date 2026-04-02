import type { ActionContext } from "../../types";

interface Input {
  handover: string;
  author: string;
  handoverDate: string;
  recipient?: string;
  skipDiscord?: boolean;
  [key: string]: unknown;
}

export default {
  async execute(input: Input, ctx: ActionContext) {
    const { handover, author, handoverDate, recipient, skipDiscord, ...upstream } = input;
    const shell = ctx.capabilities.shell;
    const writeFile = ctx.capabilities.writeFile;

    // Save handover to file
    const fileName = `${handoverDate}-${author}-handover.md`;
    const handoverDir = `${process.env.HOME}/work/mf/meta-factory/handovers`;
    const filePath = `${handoverDir}/${fileName}`;

    let fileSaved = false;
    if (writeFile) {
      try {
        // Ensure directory exists
        if (shell) await shell(`mkdir -p "${handoverDir}"`);
        await writeFile(filePath, handover);
        fileSaved = true;
      } catch {
        // Non-fatal — continue to Discord
      }
    }

    // Post to Discord
    let postedToDiscord = false;
    if (shell && !skipDiscord) {
      try {
        // Discord message (truncated if too long)
        const discordMsg = handover.length > 1800
          ? handover.slice(0, 1800) + `\n\n_Full handover: ${fileName}_`
          : handover;
        const escaped = discordMsg.replace(/"/g, '\\"');
        const result = await shell(`bun ~/bin/discord post --channel handover "${escaped}"`);
        postedToDiscord = result.code === 0;
      } catch {
        // Non-fatal
      }
    }

    return {
      ...upstream,
      handover,
      author,
      recipient,
      handoverDate,
      filePath: fileSaved ? filePath : undefined,
      fileSaved,
      postedToDiscord,
      deliveredAt: new Date().toISOString(),
    };
  },
};
