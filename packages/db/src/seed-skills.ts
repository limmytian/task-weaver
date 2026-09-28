import { readFileSync, readdirSync } from "node:fs";
import { resolve, basename } from "node:path";

const SKILLS_DIR = resolve(import.meta.dirname, "../../../skills/task-weaver");
const API_URL = process.env.TW_API_URL || "http://localhost:3001";
const API_KEY = process.env.TW_API_KEY;

function parseFrontmatter(raw: string): { meta: Record<string, unknown>; content: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, content: raw };

  const meta: Record<string, unknown> = {};
  for (const line of match[1]!.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value: unknown = line.slice(idx + 1).trim();
    if (typeof value === "string" && value.startsWith("[")) {
      try { value = JSON.parse(value); } catch { /* keep as string */ }
    }
    if (typeof value === "string" && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }
  return { meta, content: match[2]!.trim() };
}

async function main() {
  const files = readdirSync(SKILLS_DIR).filter((f) => f.endsWith(".md"));
  console.log(`Found ${files.length} skill files in ${SKILLS_DIR}`);

  const skills = files.map((f) => {
    const raw = readFileSync(resolve(SKILLS_DIR, f), "utf-8");
    const { meta, content } = parseFrontmatter(raw);
    const title = (meta.name as string) || (meta.title as string) || basename(f, ".md");
    return {
      title,
      content,
      summary: meta.description as string | undefined,
      keywords: meta.keywords as string[] | undefined,
      tags: meta.tags as string[] | undefined,
    };
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Actor-Type": "agent",
    "X-Actor-Id": "seed-skills",
  };
  if (API_KEY) headers["Authorization"] = `Bearer ${API_KEY}`;

  const res = await fetch(`${API_URL}/api/v1/context/import/batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ skills }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`Failed to import skills: ${res.status} ${body}`);
    process.exit(1);
  }

  const result = await res.json() as { count: number };
  console.log(`Successfully imported ${result.count} skills`);
}

main();
