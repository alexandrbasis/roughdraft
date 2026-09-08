import { afterEach, expect, it, vi } from "vitest";
import { pollJson } from "./poll-json";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("cancels a stalled request before retrying and recovers after an outage", async () => {
  vi.useFakeTimers();
  let aborted = false;
  const fetchMock = vi.fn((_url: string, init: RequestInit) => {
    if (fetchMock.mock.calls.length > 1)
      return Promise.resolve(new Response(JSON.stringify({ version: "v2" })));
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("Aborted", "AbortError"));
      });
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const onValue = vi.fn();
  const stop = pollJson("/api/watch?poll=1", onValue);
  await vi.advanceTimersByTimeAsync(4_999);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(3_000);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(onValue).toHaveBeenCalledWith({ version: "v2" });
  stop();
});

it("does not overlap requests or deliver an old response after disposal", async () => {
  vi.useFakeTimers();
  let resolve!: (response: Response) => void;
  let signal: AbortSignal | null | undefined;
  const fetchMock = vi.fn((_url: string, init: RequestInit) => {
    signal = init.signal;
    return new Promise<Response>((done) => {
      resolve = done;
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const onValue = vi.fn();
  const stop = pollJson("/api/watch?poll=1", onValue);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  stop();
  expect(signal?.aborted).toBe(true);
  resolve(new Response(JSON.stringify({ version: "old" })));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(onValue).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
