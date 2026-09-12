export interface CodeHighlight {
  from: number;
  to: number;
  style: string;
}

type Shiki = typeof import("shiki");
let highlighterPromise: Promise<{
  highlighter: Awaited<ReturnType<Shiki["createHighlighter"]>>;
  languages: Shiki["bundledLanguages"];
}> | null = null;

async function loadHighlighter() {
  highlighterPromise ??= import("shiki").then(async (shiki) => ({
    highlighter: await shiki.createHighlighter({
      themes: ["github-light", "github-dark"],
      langs: [],
    }),
    languages: shiki.bundledLanguages,
  }));
  try {
    return await highlighterPromise;
  } catch (error) {
    highlighterPromise = null;
    throw error;
  }
}

/** Returns decorations only: the original source and review marks stay intact. */
export async function highlightCode(
  source: string,
  language: string,
): Promise<CodeHighlight[]> {
  const { highlighter, languages } = await loadHighlighter();
  if (!Object.hasOwn(languages, language)) return [];
  const grammar = languages[language as keyof typeof languages];
  await highlighter.loadLanguage(grammar);
  const tokens = highlighter.codeToTokensWithThemes(source, {
    lang: language as keyof typeof languages,
    themes: { light: "github-light", dark: "github-dark" },
  });

  return tokens.flatMap((line) =>
    line.flatMap((token) => {
      const light = token.variants?.light;
      const dark = token.variants?.dark;
      if (!light?.color || !dark?.color || !token.content.length) return [];
      return [
        {
          from: token.offset,
          to: token.offset + token.content.length,
          style: `--shiki-light:${light.color};--shiki-dark:${dark.color}`,
        },
      ];
    }),
  );
}
