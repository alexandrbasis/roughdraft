export type MermaidColorScheme = "light" | "dark";

type MermaidApi = typeof import("mermaid")["default"];

let nextRenderId = 0;
let renderQueue: Promise<void> = Promise.resolve();

async function loadMermaid(): Promise<MermaidApi> {
  const module = await import("mermaid");
  return module.default;
}

export function renderMermaidDiagram(
  source: string,
  colorScheme: MermaidColorScheme,
): Promise<string> {
  const renderId = `roughdraft-mermaid-${++nextRenderId}`;
  const renderTask = renderQueue.then(async () => {
    const mermaid = await loadMermaid();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      htmlLabels: false,
      // Source directives must not relax the rendering boundary or inject CSS.
      secure: [
        "securityLevel",
        "startOnLoad",
        "suppressErrorRendering",
        "maxTextSize",
        "htmlLabels",
        "themeCSS",
      ],
      theme: colorScheme === "dark" ? "dark" : "default",
    });
    const { svg } = await mermaid.render(renderId, source);
    // Mermaid can emit xlink:href without declaring its namespace. Inline SVG
    // accepts that HTML output, but SVG images are parsed as XML by the browser.
    const imageSvg = svg.replace(
      /^(\s*<svg\b)(?![^>]*\bxmlns:xlink\s*=)/,
      '$1 xmlns:xlink="http://www.w3.org/1999/xlink"',
    );
    const parsed = new DOMParser().parseFromString(imageSvg, "image/svg+xml");
    if (
      parsed.querySelector("parsererror") ||
      parsed.documentElement.localName !== "svg"
    ) {
      throw new Error("The generated diagram is not a valid SVG image.");
    }
    return imageSvg;
  });

  renderQueue = renderTask.then(
    () => undefined,
    () => undefined,
  );

  return renderTask;
}

export function resetMermaidRenderStateForTests() {
  nextRenderId = 0;
  renderQueue = Promise.resolve();
}
