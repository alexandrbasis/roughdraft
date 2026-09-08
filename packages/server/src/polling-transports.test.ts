import fs from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp } from "./index";

let directory: string;
let server: Server;
let baseUrl: string;
let closeDatabase: () => void;
const clientA = "11111111-1111-4111-8111-111111111111";
const clientB = "22222222-2222-4222-8222-222222222222";

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-polling-"));
  fs.writeFileSync(path.join(directory, "draft.md"), "# Original\n");
  const { app } = createApp({
    projectDir: directory,
    homeDir: directory,
    stateDirectory: path.join(directory, "state"),
  });
  closeDatabase = () => app.locals.reviewDatabase.close();
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDatabase();
  fs.rmSync(directory, { recursive: true, force: true });
});

function metadata(file = "draft.md") {
  return request(server)
    .get("/api/markdown-file/events")
    .query({ poll: "1", projectPath: directory, path: file })
    .timeout({ deadline: 1000 });
}

function poll(clientId: string, file = "/project/draft.md") {
  return request(server)
    .get("/api/open-requests")
    .query({ poll: "1", clientId, path: file })
    .timeout({ deadline: 1000 });
}

function open(url = "/project/review", file = "/project/draft.md") {
  return request(server).post("/api/open-request").send({ path: file, url });
}

it("returns finite JSON metadata that changes after writes and deletion", async () => {
  const first = await metadata();
  expect(first.status).toBe(200);
  expect(first.type).toBe("application/json");
  expect(first.body).toEqual({
    path: "draft.md",
    exists: true,
    version: expect.any(String),
  });
  fs.writeFileSync(path.join(directory, "draft.md"), "# Changed\n");
  const changed = await metadata();
  expect(changed.body.version).not.toBe(first.body.version);
  fs.unlinkSync(path.join(directory, "draft.md"));
  expect((await metadata()).body).toEqual({
    path: "draft.md",
    exists: false,
    version: null,
  });
});

it("reports a file that vanishes during metadata reading as missing", async () => {
  const read = fs.readFileSync.bind(fs);
  vi.spyOn(fs, "readFileSync").mockImplementation(
    (...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] === path.join(directory, "draft.md")) {
        fs.unlinkSync(path.join(directory, "draft.md"));
      }
      return read(...args);
    },
  );
  const response = await metadata();
  expect(response.status).toBe(200);
  expect(response.body).toEqual({
    path: "draft.md",
    exists: false,
    version: null,
  });
  expect((await request(server).get("/api/status")).status).toBe(200);
});

it("preserves metadata path validation", async () => {
  expect((await metadata("../outside.md")).status).toBe(404);
  expect((await metadata("draft.txt")).status).toBe(404);
});

it("delivers once to the newest matching polling client without reordering touches", async () => {
  expect((await poll(clientA)).body).toEqual({});
  expect((await poll(clientB)).body).toEqual({});
  await poll(clientA);
  expect((await open()).body).toEqual({ delivered: true });
  expect((await poll(clientA)).body).toEqual({});
  expect((await poll(clientB)).body).toEqual({ url: "/project/review" });
  expect((await poll(clientB)).body).toEqual({});
  expect((await open("/other", "/other.md")).body).toEqual({
    delivered: false,
  });
});

it("expires idle clients, refreshes touched leases, and unregisters explicitly", async () => {
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  await poll(clientA);
  now += 14_000;
  await poll(clientA);
  now += 14_000;
  expect((await open()).body).toEqual({ delivered: true });
  now += 15_001;
  expect((await open()).body).toEqual({ delivered: false });
  expect((await poll(clientA)).body).toEqual({});
  await request(server)
    .delete("/api/open-requests")
    .query({ clientId: clientA })
    .expect(200);
  expect((await open()).body).toEqual({ delivered: false });
});

it("requires a client identity for finite open-request polling", async () => {
  const response = await request(server)
    .get("/api/open-requests")
    .query({ poll: "1" })
    .timeout({ deadline: 1000 });
  expect(response.status).toBe(400);
});

it("preserves SSE delivery and orders SSE and polling clients together", async () => {
  await poll(clientA);
  const controller = new AbortController();
  const stream = await fetch(
    `${baseUrl}/api/open-requests?path=/project/draft.md`,
    {
      signal: controller.signal,
    },
  );
  if (!stream.body) throw new Error("The legacy SSE response must have a body");
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  try {
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    expect(decoder.decode((await reader.read()).value)).toContain(
      "event: connected",
    );
    await poll(clientA);
    expect((await open()).body).toEqual({ delivered: true });
    expect(decoder.decode((await reader.read()).value)).toContain(
      '"url":"/project/review"',
    );
    expect((await poll(clientA)).body).toEqual({});
    await poll(clientB);
    expect((await open("/newest")).body).toEqual({ delivered: true });
    expect((await poll(clientB)).body).toEqual({ url: "/newest" });
  } finally {
    controller.abort();
    await reader.cancel().catch(() => undefined);
  }
});
