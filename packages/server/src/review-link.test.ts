import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runDomainCommand } from "./domain-command";
import { readPublicBaseUrl } from "./local-domain";
import { registerReviewLink } from "./review-link";

let state: string;
beforeEach(() => {
  state = fs.mkdtempSync(path.join(os.tmpdir(), "review-link-"));
});
afterEach(() => fs.rmSync(state, { recursive: true, force: true }));

it("enables only a verified origin, then prints its readable registered route", async () => {
  const env = { ROUGHDRAFT_STATE_DIR: state };
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url.toString());
    return Response.json(
      url.pathname === "/api/status"
        ? { serverRoot: "/install", port: 7373 }
        : { route: "/admitad-one/appsflyer", afterSequence: 17 },
    );
  };
  const context = {
    env,
    serverRoot: "/install",
    fetchImpl,
    ensureServer: async () => ({ port: 7373 }),
    log: vi.fn(),
  };
  await runDomainCommand(["setup", "review.rd", "--json"], context);
  expect(readPublicBaseUrl(env)).toBeNull();
  await runDomainCommand(["enable", "http://review.rd", "--json"], context);
  expect(readPublicBaseUrl(env)).toBe("http://review.rd");
  await expect(
    registerReviewLink({
      apiUrl: "http://localhost:7373",
      documentPath: "/projects/draft.md",
      port: 7373,
      ...context,
    }),
  ).resolves.toEqual({
    url: "http://review.rd/admitad-one/appsflyer",
    afterSequence: 17,
  });
  expect(requests.at(-1)).toBe("http://localhost:7373/api/reviews");
  await runDomainCommand(["disable"], context);
  expect(readPublicBaseUrl(env)).toBeNull();
});

it("supports a legacy server only when no public domain is configured", async () => {
  const options = {
    env: { ROUGHDRAFT_STATE_DIR: state },
    serverRoot: "/install",
    apiUrl: "http://localhost:7373",
    port: 7373,
    documentPath: "/projects/draft.md",
    fetchImpl: vi.fn(async () => new Response(null, { status: 404 })),
  };
  await expect(registerReviewLink(options)).resolves.toEqual({});
  await expect(
    registerReviewLink({
      ...options,
      fetchImpl: async () => new Response(null, { status: 500 }),
    }),
  ).rejects.toThrow("Could not register review: HTTP 500");
});

it("does not register a document when its configured address points to another server", async () => {
  const fetchImpl = vi.fn(async () =>
    Response.json({ serverRoot: "/other", port: 7373 }),
  );
  await expect(
    registerReviewLink({
      env: {
        ROUGHDRAFT_STATE_DIR: state,
        ROUGHDRAFT_PUBLIC_URL: "http://review.rd",
      },
      serverRoot: "/install",
      apiUrl: "http://localhost:7373",
      port: 7373,
      documentPath: "/projects/draft.md",
      fetchImpl,
    }),
  ).rejects.toThrow("does not reach this Roughdraft server");
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
