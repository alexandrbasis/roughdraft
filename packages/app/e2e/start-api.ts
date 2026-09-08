import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../../server/src/index";

const stateDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "roughdraft-e2e-state-"),
);
process.env.ROUGHDRAFT_STATE_DIR = stateDirectory;
delete process.env.ROUGHDRAFT_STATE_FILE;
process.on("exit", () =>
  fs.rmSync(stateDirectory, { recursive: true, force: true }),
);
process.once("SIGTERM", () => process.exit(0));
process.once("SIGINT", () => process.exit(0));

await createServer(Number(process.env.API_PORT ?? 4317));
