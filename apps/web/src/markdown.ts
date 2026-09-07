import MarkdownIt from "markdown-it";
import hljs from "highlight.js/lib/core";
import sql from "highlight.js/lib/languages/sql";
import r from "highlight.js/lib/languages/r";
import python from "highlight.js/lib/languages/python";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import diff from "highlight.js/lib/languages/diff";

for (const [name, language] of Object.entries({ sql, r, python, javascript, typescript, json, bash, c, cpp, diff })) {
  hljs.registerLanguage(name, language);
}

// Render model Markdown with raw HTML disabled and unsafe link schemes rejected.
const markdown = new MarkdownIt({ html: false, linkify: false, breaks: false });
markdown.renderer.rules.fence = (tokens, index) => {
  const token = tokens[index]!;
  const language = token.info.trim().split(/\s+/)[0]?.toLowerCase() || "text";
  const label = markdown.utils.escapeHtml(language);
  const code = hljs.getLanguage(language)
    ? hljs.highlight(token.content, { language, ignoreIllegals: true }).value
    : markdown.utils.escapeHtml(token.content);
  return `<div class="code-block"><div class="code-toolbar"><span>${label}</span><button type="button" class="copy-code" aria-label="Copy code">Copy</button></div><pre><code class="hljs">${code}</code></pre></div>`;
};
const defaultLink = markdown.renderer.rules.link_open;
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  tokens[index]!.attrSet("target", "_blank");
  tokens[index]!.attrSet("rel", "noopener noreferrer");
  return defaultLink?.(tokens, index, options, env, self) ?? self.renderToken(tokens, index, options);
};

export function renderMarkdown(text: string): string {
  return markdown.render(text);
}
