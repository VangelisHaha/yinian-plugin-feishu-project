import { handlers as agentTools } from "./handlers/tools.mjs";
/**
 * 飞书项目插件入口。
 *
 * 只做方法名到 handler 的映射。业务在 `handlers/`，飞书协议细节在 `feishu/`。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { start } from "./sdk/index.mjs";
import * as config from "./handlers/config.mjs";
import * as sync from "./handlers/sync.mjs";

/** 版本只维护在 manifest 一处。 */
function readManifestVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const manifest = JSON.parse(
    readFileSync(join(here, "..", "yinian-plugin.json"), "utf8"),
  ) as { version?: string };
  return manifest.version ?? "0.0.0";
}

start({
  version: readManifestVersion(),
  handlers: {
    ...agentTools,
    "sync.pull": sync.pull,
    "sync.push": sync.push,
    "config.validate": config.validate,
    "feishuProject.testConnection": config.testConnection,
    "feishuProject.previewSchedule": config.previewSchedule,
    "feishuProject.previewBugs": config.previewBugs,
  },
});
