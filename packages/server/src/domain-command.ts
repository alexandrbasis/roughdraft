import {
  prepareLocalDomain,
  readPublicBaseUrl,
  savePublicBaseUrl,
  verifyPublicBaseUrl,
} from "./local-domain.js";

export interface DomainCommandContext {
  env: NodeJS.ProcessEnv;
  serverRoot: string;
  fetchImpl: typeof fetch;
  ensureServer: () => Promise<{ port: number }>;
  log: (message: string) => void;
}

export async function runDomainCommand(
  args: string[],
  context: DomainCommandContext,
): Promise<number> {
  const json = args.includes("--json");
  const positionals = args.filter((argument) => argument !== "--json");
  const [command = "status", value] = positionals;
  if (command === "--help" || command === "-h") {
    context.log("Usage: roughdraft domain setup [hostname] [--json]");
    context.log("       roughdraft domain enable <http://hostname> [--json]");
    context.log("       roughdraft domain status|disable [--json]");
    context.log(
      "Setup prepares local hosts and Caddy configuration. Enable verifies the address before using it in review links.",
    );
    return 0;
  }
  const maxArguments = command === "status" || command === "disable" ? 1 : 2;
  if (
    positionals.length > maxArguments ||
    positionals.some((argument) => argument.startsWith("-"))
  ) {
    throw new Error("Invalid domain arguments. Run roughdraft domain --help.");
  }
  if (command === "status") {
    const publicBaseUrl = readPublicBaseUrl(context.env);
    context.log(
      json
        ? JSON.stringify({ publicBaseUrl }, null, 2)
        : (publicBaseUrl ?? "Review links use the local server address."),
    );
    return 0;
  }
  if (command === "disable") {
    savePublicBaseUrl(null, context.env);
    context.log(
      json
        ? JSON.stringify({ publicBaseUrl: null })
        : "Review links now use the local server address.",
    );
    return 0;
  }
  if (command === "setup") {
    const server = await context.ensureServer();
    const setup = prepareLocalDomain(
      value ?? "review.rd",
      server.port,
      context.env,
    );
    if (json) context.log(JSON.stringify(setup, null, 2));
    else {
      context.log(`Prepared ${setup.publicBaseUrl}`);
      context.log(
        `Add the entries from ${setup.hostsFile} to your hosts file.`,
      );
      context.log(`Include ${setup.caddyfile} in Caddy and reload it.`);
      context.log(
        "Your operating system may require administrator permission for the hosts file.",
      );
      context.log(`Then run: roughdraft domain enable ${setup.publicBaseUrl}`);
    }
    return 0;
  }
  if (command === "enable") {
    if (!value)
      throw new Error("Usage: roughdraft domain enable <http://hostname>");
    const server = await context.ensureServer();
    const publicBaseUrl = await verifyPublicBaseUrl(
      value,
      { serverRoot: context.serverRoot, port: server.port },
      context.fetchImpl,
    );
    savePublicBaseUrl(publicBaseUrl, context.env);
    context.log(
      json
        ? JSON.stringify({ publicBaseUrl }, null, 2)
        : `Review links now use ${publicBaseUrl}`,
    );
    return 0;
  }
  throw new Error("Unknown domain command. Run roughdraft domain --help.");
}
