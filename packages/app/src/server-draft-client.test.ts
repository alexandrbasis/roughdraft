import { afterEach, describe, expect, it, vi } from "vitest";
import { createDraftRecord } from "./draft-storage";
import { createServerDraftClient } from "./server-draft-client";

const documentPath = "/workspace/review.md";
const info = { kind: "local-files", label: "Local files", detail: "" } as const;
const draft = createDraftRecord({
  storageKey: documentPath,
  content: "pending",
  base: { content: "disk", version: "v1" },
  revision: "r1",
  tabId: "tab1",
  updatedAt: 1,
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
afterEach(() => vi.unstubAllGlobals());

describe("server draft client", () => {
  it("orders pending PUT, CAS DELETE, and newer PUT within one tab", async () => {
    let finishFirst!: (response: Response) => void;
    const calls: { method: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/status") return json({ serverDrafts: true });
        if (url.startsWith("/api/reviews/drafts?")) return json({ drafts: [] });
        if (!init?.method || typeof init.body !== "string")
          throw new Error("Expected draft mutation");
        calls.push({ method: init.method, body: JSON.parse(init.body) });
        if (calls.length === 1)
          return new Promise<Response>((resolve) => {
            finishFirst = resolve;
          });
        return init.method === "DELETE"
          ? json({ deleted: true })
          : json({
              ...draft,
              ...JSON.parse(init.body as string).draft,
              documentPath,
            });
      }),
    );
    const client = createServerDraftClient(info, documentPath);
    if (!client) throw new Error("Expected local draft support");
    const put = client.put(draft);
    const remove = client.remove(draft);
    const newer = { ...draft, revision: "r2", content: "newer", updatedAt: 2 };
    const putNewer = client.put(newer);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    finishFirst(json({ ...draft, documentPath }));
    await Promise.all([put, remove, putNewer]);
    expect(calls.map((call) => call.method)).toEqual(["PUT", "DELETE", "PUT"]);
    expect(calls[1].body).toEqual({
      documentPath,
      tabId: "tab1",
      revision: "r1",
    });
    expect(calls[2].body.draft).toEqual(newer);
  });

  it("continues with a newer revision after a failed mirror and preserves CAS false", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ serverDrafts: true }))
      .mockResolvedValueOnce(json({ drafts: [] }))
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json({ ...draft, documentPath }))
      .mockResolvedValueOnce(json({ deleted: false }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createServerDraftClient(info, documentPath);
    if (!client) throw new Error("Expected local draft support");
    await expect(client.put(draft)).rejects.toThrow();
    await expect(client.put(draft)).resolves.toMatchObject(draft);
    await expect(client.remove(draft)).resolves.toBe(false);
  });

  it("never sends draft requests to old servers, preview, remote, or relative paths", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(json({ backend: "local-files" }));
    vi.stubGlobal("fetch", fetchMock);
    expect(
      createServerDraftClient({ ...info, kind: "remote" }, documentPath),
    ).toBeNull();
    expect(
      createServerDraftClient({ ...info, kind: "local-storage" }, documentPath),
    ).toBeNull();
    expect(createServerDraftClient(info, "relative.md")).toBeNull();
    const client = createServerDraftClient(info, documentPath);
    if (!client) throw new Error("Expected local draft support");
    expect(await client.list()).toEqual([]);
    expect(await client.put(draft)).toBeNull();
    expect(await client.remove(draft)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/status");
  });

  it("uses the server canonical path for aliases before mirroring", async () => {
    const canonical = "/private/workspace/review.md";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ serverDrafts: true }))
      .mockResolvedValueOnce(json({ documentPath: canonical, drafts: [] }))
      .mockResolvedValueOnce(json({ ...draft, documentPath: canonical }))
      .mockResolvedValueOnce(json({ deleted: true }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createServerDraftClient(info, documentPath);
    if (!client) throw new Error("Expected local draft support");
    await client.put(draft);
    await client.remove(draft);
    expect(
      JSON.parse(String(fetchMock.mock.calls[2][1].body)).documentPath,
    ).toBe(canonical);
    expect(
      JSON.parse(String(fetchMock.mock.calls[3][1].body)).documentPath,
    ).toBe(canonical);
  });

  it("rejects records for another document and malformed acknowledgements", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json({ serverDrafts: true }))
        .mockResolvedValueOnce(
          json({ drafts: [{ ...draft, documentPath: "/other.md" }] }),
        )
        .mockResolvedValueOnce(json({ drafts: [] }))
        .mockResolvedValueOnce(
          json({ ...draft, documentPath, revision: "wrong" }),
        ),
    );
    const client = createServerDraftClient(info, documentPath);
    if (!client) throw new Error("Expected local draft support");
    await expect(client.list()).rejects.toThrow();
    await expect(client.put(draft)).rejects.toThrow();
  });
});
