import { createHighlighter, type Highlighter, type ThemeRegistration } from "shiki";

/* Custom dark theme replicating the Geist code palette (verified against
   vercel.com/geist): keyword pink, string green, function purple, constant
   blue, parameter orange, comment gray. Transparent background — the card
   provides the surface. */
const geistDark: ThemeRegistration = {
  name: "geist-dark",
  type: "dark",
  colors: {
    "editor.background": "#00000000",
    "editor.foreground": "#ededed",
  },
  settings: [
    { settings: { foreground: "#ededed" } },
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: "#a0a0a0" },
    },
    {
      scope: ["string", "string.quoted", "punctuation.definition.string"],
      settings: { foreground: "#00ca52" },
    },
    {
      scope: [
        "keyword",
        "storage.type",
        "storage.modifier",
        "keyword.control",
        "keyword.operator.new",
        "keyword.operator.expression",
      ],
      settings: { foreground: "#ff518d" },
    },
    {
      scope: [
        "entity.name.function",
        "support.function",
        "meta.function-call entity.name.function",
      ],
      settings: { foreground: "#c472fb" },
    },
    {
      scope: [
        "constant",
        "constant.numeric",
        "constant.language",
        "variable.other.constant",
        "support.constant",
        "entity.name.type",
        "support.type",
      ],
      settings: { foreground: "#50a8ff" },
    },
    {
      scope: ["variable.parameter", "meta.parameters variable"],
      settings: { foreground: "#ff9900" },
    },
    {
      scope: ["entity.name.tag", "support.class.component"],
      settings: { foreground: "#ff518d" },
    },
    {
      scope: ["entity.other.attribute-name"],
      settings: { foreground: "#c472fb" },
    },
    {
      scope: ["punctuation", "meta.brace"],
      settings: { foreground: "#a0a0a0" },
    },
  ],
};

/* Cache on globalThis — dev hot reload re-evaluates modules and would
   otherwise spawn duplicate highlighter instances. */
const globalCache = globalThis as unknown as {
  __evestackHighlighter?: Promise<Highlighter>;
};

function getHighlighter(): Promise<Highlighter> {
  globalCache.__evestackHighlighter ??= createHighlighter({
    themes: [geistDark, "github-light"],
    langs: ["typescript", "tsx", "bash", "yaml", "json"],
  });
  return globalCache.__evestackHighlighter;
}

export type CodeLang = "typescript" | "tsx" | "bash" | "yaml" | "json";

/** Build-time (RSC) highlight → HTML with dual-theme CSS variables. */
export async function highlight(code: string, lang: CodeLang): Promise<string> {
  const highlighter = await getHighlighter();
  return highlighter.codeToHtml(code, {
    lang,
    themes: { dark: "geist-dark", light: "github-light" },
    defaultColor: false,
  });
}
