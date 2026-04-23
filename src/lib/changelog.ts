import changelogRaw from "../../CHANGELOG.md?raw";

export interface ChangelogEntry {
  version: string;
  date: string;
  body: string;
}

const VERSION_HEADING = /^## \[([\w.+-]+)\](?:\s*-\s*(\S+))?\s*$/;

export function parseChangelog(raw: string): ChangelogEntry[] {
  const lines = raw.split("\n");
  const entries: ChangelogEntry[] = [];
  let current: ChangelogEntry | null = null;
  let bodyLines: string[] = [];

  const flush = () => {
    if (!current) return;
    current.body = bodyLines.join("\n").trim();
    entries.push(current);
  };

  for (const line of lines) {
    const m = VERSION_HEADING.exec(line);
    if (m) {
      flush();
      current = { version: m[1], date: m[2] || "", body: "" };
      bodyLines = [];
    } else if (current) {
      bodyLines.push(line);
    }
  }
  flush();
  return entries;
}

let cache: ChangelogEntry[] | null = null;

export function loadChangelog(): ChangelogEntry[] {
  if (!cache) cache = parseChangelog(changelogRaw);
  return cache;
}
