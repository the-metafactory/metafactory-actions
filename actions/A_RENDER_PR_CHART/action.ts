import type { ActionContext } from "../../types";

interface MergedPR {
  number: number;
  title: string;
  author: string;
  mergedAt: string;
  date: string;
}

interface Input {
  prsByRepo: Record<string, MergedPR[]>;
  repos: string[];
  sinceDate: string;
  outputPath?: string;
  [key: string]: unknown;
}

// Dark-themed colors — distinct per repo
const COLORS = [
  "#3b82f6", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6",
  "#ec4899", "#06b6d4", "#f97316", "#14b8a6", "#a855f7",
  "#6366f1", "#84cc16", "#e11d48", "#0ea5e9", "#d946ef",
  "#22c55e", "#eab308", "#64748b", "#fb923c", "#2dd4bf",
  "#c084fc", "#f43f5e", "#38bdf8", "#a3e635", "#818cf8",
  "#fbbf24", "#34d399", "#f87171", "#a78bfa", "#fb7185",
];

export default {
  async execute(input: Input, ctx: ActionContext) {
    const { prsByRepo, repos, sinceDate, outputPath = "/tmp/mf-pr-stats.html", ...upstream } = input;
    const writeFile = ctx.capabilities.writeFile;
    if (!writeFile) throw new Error("writeFile capability required");

    // Build date range
    const start = new Date(sinceDate);
    const end = new Date();
    const dates: string[] = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      dates.push(d.toISOString().split("T")[0]);
    }

    // Count PRs per repo per day
    const dailyCounts: Record<string, Record<string, number>> = {};
    for (const repo of repos) {
      dailyCounts[repo] = {};
      for (const date of dates) dailyCounts[repo][date] = 0;
      for (const pr of prsByRepo[repo] || []) {
        if (dailyCounts[repo][pr.date] !== undefined) {
          dailyCounts[repo][pr.date]++;
        }
      }
    }

    // Active repos only (at least 1 PR)
    const activeRepos = repos.filter((r) => (prsByRepo[r] || []).length > 0);

    // Build cumulative datasets
    const cumulativeDatasets = activeRepos.map((repo, i) => {
      let cumulative = 0;
      const data = dates.map((date) => {
        cumulative += dailyCounts[repo]?.[date] || 0;
        return cumulative;
      });
      return {
        label: repo,
        data,
        borderColor: COLORS[i % COLORS.length],
        backgroundColor: "transparent",
        tension: 0.3,
        pointRadius: 0,
      };
    });

    // Build daily stacked bar datasets
    const dailyDatasets = activeRepos.map((repo, i) => ({
      label: repo,
      data: dates.map((date) => dailyCounts[repo]?.[date] || 0),
      backgroundColor: COLORS[i % COLORS.length],
    }));

    const totalPRs = activeRepos.reduce((sum, r) => sum + (prsByRepo[r]?.length || 0), 0);

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>metafactory PR Stats</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  body { margin: 0; padding: 24px; background: #0f172a; color: #e2e8f0; font-family: system-ui, -apple-system, sans-serif; }
  h1 { font-size: 1.5rem; margin-bottom: 4px; }
  .subtitle { color: #94a3b8; margin-bottom: 24px; font-size: 0.9rem; }
  .chart-container { max-width: 1200px; margin: 0 auto 40px; }
  canvas { background: #1e293b; border-radius: 8px; padding: 16px; }
</style>
</head>
<body>
<div class="chart-container">
  <h1>metafactory — Merged PRs (cumulative)</h1>
  <p class="subtitle">${totalPRs} PRs merged since ${sinceDate} across ${activeRepos.length} repos</p>
  <canvas id="cumulative"></canvas>
</div>
<div class="chart-container">
  <h1>metafactory — PRs Merged per Day</h1>
  <p class="subtitle">Daily breakdown by repository</p>
  <canvas id="daily"></canvas>
</div>
<script>
const dates = ${JSON.stringify(dates)};
const cumulativeDatasets = ${JSON.stringify(cumulativeDatasets)};
const dailyDatasets = ${JSON.stringify(dailyDatasets)};

const commonScales = {
  x: { ticks: { color: '#94a3b8', maxRotation: 45 }, grid: { color: '#334155' } },
  y: { ticks: { color: '#94a3b8' }, grid: { color: '#334155' }, beginAtZero: true }
};

new Chart(document.getElementById('cumulative'), {
  type: 'line',
  data: { labels: dates, datasets: cumulativeDatasets },
  options: {
    responsive: true,
    plugins: { legend: { labels: { color: '#e2e8f0' } } },
    scales: commonScales
  }
});

new Chart(document.getElementById('daily'), {
  type: 'bar',
  data: { labels: dates, datasets: dailyDatasets },
  options: {
    responsive: true,
    plugins: { legend: { labels: { color: '#e2e8f0' } } },
    scales: { ...commonScales, x: { ...commonScales.x, stacked: true }, y: { ...commonScales.y, stacked: true } }
  }
});
</script>
</body>
</html>`;

    await writeFile(outputPath, html);

    return {
      ...upstream,
      prsByRepo,
      repos: activeRepos,
      sinceDate,
      outputPath,
      html,
      totalPRs,
      renderedAt: new Date().toISOString(),
    };
  },
};
