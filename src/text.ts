/** Rich-text (HTML) helpers for descriptions coming from the doc API. */

const ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m: string, name: string) => ENTITIES[name.toLowerCase()] ?? m);
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

/** Convert the doc site's rich-text HTML into readable markdown-ish plain text. */
export function cleanText(html: string | null | undefined): string {
  if (!html) return "";
  let s = String(html);
  s = s.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, inner: string) => {
    const text = stripTags(inner).trim() || href;
    return `[${text}](${href})`;
  });
  s = s.replace(/<img\b[^>]*src=["']([^"']+)["'][^>]*>/gi, (_, src: string) => `[图片](${src})`);
  s = s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n");
  s = stripTags(s);
  s = decodeEntities(s);
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

/** Make a string safe for a markdown table cell. */
export function cell(s: string | null | undefined): string {
  const t = cleanText(s ?? "");
  return t.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}
