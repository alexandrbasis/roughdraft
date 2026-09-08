/** Short requests keep HTTP/1 connection slots available across review tabs. */
export function pollJson<T>(
  url: string,
  onValue: (value: T) => void,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: AbortController | undefined;

  const poll = async () => {
    const controller = new AbortController();
    active = controller;
    const deadline = setTimeout(() => controller.abort(), 5_000);
    let delay = 1_000;
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`Polling failed: ${response.status}`);
      const value = (await response.json()) as T;
      if (!stopped) onValue(value);
    } catch {
      // Retry after disconnects without overlapping requests or clearing state.
      delay = 3_000;
    } finally {
      clearTimeout(deadline);
      if (!stopped) timer = setTimeout(() => void poll(), delay);
    }
  };
  void poll();
  return () => {
    stopped = true;
    clearTimeout(timer);
    active?.abort();
  };
}
