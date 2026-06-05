import type { ActionContext } from "../../types";
import { homedir } from "os";
import { join } from "path";

interface Input {
  /** Wrangler environment to query: "production" (default) or "dev" */
  environment?: string;
  [key: string]: unknown;
}

interface PackageDownloads {
  package: string;
  downloads: number;
  anonymous: number;
  versions: number;
  firstDownload: string;
  lastDownload: string;
}

interface DownloadStats {
  packages: PackageDownloads[];
  total: number;
  anonymousTotal: number;
  environment: string;
  queriedAt: string;
}

/** Wrangler env → D1 database name (from meta-factory/wrangler.toml) */
const D1_DATABASES: Record<string, string> = {
  production: "metafactory-prod",
  dev: "metafactory-dev",
};

// Counts package_download audit events per package. Matches both the current
// shape (event_type='admin_action' + details.action='package_download') and
// the dedicated event_type once meta-factory#531 lands, so the action keeps
// working across the taxonomy migration. Joins sha256 → package_versions →
// packages to resolve artifact hashes to @namespace/name.
const QUERY = `
SELECT p.namespace || '/' || p.name AS package,
       COUNT(*) AS downloads,
       SUM(CASE WHEN json_extract(a.details,'$.anonymous') THEN 1 ELSE 0 END) AS anonymous,
       COUNT(DISTINCT pv.version) AS versions,
       datetime(MIN(a.created_at),'unixepoch') AS firstDownload,
       datetime(MAX(a.created_at),'unixepoch') AS lastDownload
FROM audit_log a
JOIN package_versions pv ON pv.sha256 = json_extract(a.details,'$.sha256')
JOIN packages p ON p.id = pv.package_id
WHERE a.event_type = 'package_download'
   OR (a.event_type = 'admin_action'
       AND json_extract(a.details,'$.action') = 'package_download')
GROUP BY package
ORDER BY downloads DESC;
`.trim();

export default {
  async execute(input: Input, ctx: ActionContext) {
    const { environment = "production", ...upstream } = input;
    const shell = ctx.capabilities.shell;
    if (!shell) throw new Error("Shell capability required");

    const database = D1_DATABASES[environment];
    if (!database) {
      throw new Error(`Unknown environment "${environment}" — expected one of: ${Object.keys(D1_DATABASES).join(", ")}`);
    }

    // wrangler must run from the meta-factory checkout (wrangler.toml + CF auth)
    const devRoot = process.env.PULSE_DEV_ROOT || join(homedir(), "Developer");
    const metafactoryPath = process.env.METAFACTORY_PATH || join(devRoot, "meta-factory");

    // Must use --command: wrangler's remote --file mode uploads the SQL and
    // returns only an execution summary (no result rows), and pollutes stdout
    // with progress lines. Escape for a double-quoted shell string — the
    // query contains single quotes and $-JSON-paths.
    const escapedQuery = QUERY.replace(/(["\\$`])/g, "\\$1");
    const result = await shell(
      `cd "${metafactoryPath}" && bunx wrangler d1 execute ${database} --remote --env ${environment} --json --command "${escapedQuery}" 2>/dev/null`
    );
    if (result.code !== 0) {
      throw new Error(`wrangler d1 execute failed (exit ${result.code}): ${result.stderr.trim().slice(0, 500)}`);
    }
    const parsed = JSON.parse(result.stdout.trim()) as Array<{ results?: PackageDownloads[] }>;
    const rows: PackageDownloads[] = parsed[0]?.results ?? [];

    const downloadStats: DownloadStats = {
      packages: rows,
      total: rows.reduce((sum, r) => sum + r.downloads, 0),
      anonymousTotal: rows.reduce((sum, r) => sum + r.anonymous, 0),
      environment,
      queriedAt: new Date().toISOString(),
    };

    return {
      ...upstream,
      downloadStats,
    };
  },
};
