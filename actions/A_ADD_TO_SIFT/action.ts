import type { ActionContext } from "../../types";
import { shellEscape } from "../../utils";

interface ApprovedCandidate {
  url: string;
  domain: string;
  feedUrl: string;
  title: string;
  type: string;
  topicId: number;
  topicName: string;
  reasoning: string;
}

interface AddResult {
  feedUrl: string;
  title: string;
  feedId?: number;
  topicId: number;
  topicName: string;
}

interface FailResult {
  feedUrl: string;
  title: string;
  error: string;
}

interface Input {
  approved: ApprovedCandidate[];
  [key: string]: unknown;
}

async function addCandidate(
  candidate: ApprovedCandidate,
  shell: (cmd: string) => Promise<{ stdout: string; stderr: string; code: number }>
): Promise<AddResult | FailResult> {
  const topicId = Number(candidate.topicId);
  if (!Number.isInteger(topicId) || topicId <= 0) {
    return { feedUrl: candidate.feedUrl, title: candidate.title, error: `Invalid topicId: ${candidate.topicId}` };
  }

  const addResult = await shell(
    `sift source-add ${shellEscape(candidate.feedUrl)} --type ${shellEscape(candidate.type)} --title ${shellEscape(candidate.title)} --priority 3 --json`
  );

  if (addResult.code !== 0) {
    return { feedUrl: candidate.feedUrl, title: candidate.title, error: addResult.stderr || "source-add failed" };
  }

  let feedId: number | undefined;
  try {
    const response = JSON.parse(addResult.stdout);
    feedId = response.id || response.feedId;
  } catch {
    const idMatch = addResult.stdout.match(/(?:id|ID)[:\s]+(\d+)/);
    feedId = idMatch ? parseInt(idMatch[1]) : undefined;
  }

  if (!feedId) {
    return { feedUrl: candidate.feedUrl, title: candidate.title, error: "Could not parse feed ID from source-add response" };
  }

  const assignResult = await shell(
    `sift assign-topic --feed-id ${feedId} --topic-id ${topicId} --source manual`
  );

  if (assignResult.code !== 0) {
    return {
      feedUrl: candidate.feedUrl, title: candidate.title, feedId,
      topicId, topicName: `${candidate.topicName} (assignment failed: ${assignResult.stderr})`,
    };
  }

  return { feedUrl: candidate.feedUrl, title: candidate.title, feedId, topicId, topicName: candidate.topicName };
}

function isFailResult(r: AddResult | FailResult): r is FailResult {
  return "error" in r;
}

export default {
  async execute(input: Input, ctx: ActionContext) {
    const { approved, ...upstream } = input;
    const shell = ctx.capabilities.shell!;

    const results = await Promise.all(
      approved.map((c) => addCandidate(c, shell))
    );

    const added = results.filter((r): r is AddResult => !isFailResult(r));
    const failed = results.filter(isFailResult);

    const lines = [
      `UL Harvest Complete: ${added.length} added, ${failed.length} failed`,
      "",
      ...added.map((a) => `  [${a.feedId}] ${a.title} -> ${a.topicName}`),
      ...failed.map((f) => `  FAIL ${f.title}: ${f.error}`),
    ];

    return {
      ...upstream,
      added,
      failed,
      summary: lines.join("\n"),
      completedAt: new Date().toISOString(),
    };
  },
};
