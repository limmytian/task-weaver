/**
 * Migration script: Convert HTML content (from TipTap) to Markdown.
 *
 * Usage:
 *   pnpm --filter @task-weaver/db db:migrate-markdown          # dry-run (preview only)
 *   pnpm --filter @task-weaver/db db:migrate-markdown -- --apply  # apply changes
 *
 * Author: Limmy
 */

import postgres from "postgres";
import TurndownService from "turndown";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL environment variable is not set");
  process.exit(1);
}

const applyMode = process.argv.includes("--apply");

const sql = postgres(DATABASE_URL, { max: 1 });

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  emDelimiter: "*",
  strongDelimiter: "**",
  hr: "---",
});

// Custom rule: TipTap wiki-link spans -> [[title]] / [[title|display]]
turndown.addRule("wikiLink", {
  filter: (node) => {
    return (
      node.nodeName === "SPAN" &&
      node.getAttribute("data-wiki-link") !== null
    );
  },
  replacement: (_content, node) => {
    const el = node as unknown as { getAttribute(name: string): string | null };
    const title = el.getAttribute("data-wiki-link") ?? "";
    const display = el.getAttribute("data-display");
    if (display && display !== title) {
      return `[[${title}|${display}]]`;
    }
    return `[[${title}]]`;
  },
});

function isHtml(content: string): boolean {
  return /<[a-z][\s\S]*>/i.test(content);
}

async function migrate() {
  console.log(`Mode: ${applyMode ? "APPLY" : "DRY-RUN (preview only)"}\n`);

  // Migrate documents table
  const docs = await sql`SELECT id, title, content FROM documents ORDER BY created_at`;
  console.log(`Found ${docs.length} documents to check.\n`);

  let converted = 0;
  for (const doc of docs) {
    if (!isHtml(doc.content)) {
      continue;
    }
    const md = turndown.turndown(doc.content);
    converted++;
    console.log(`--- [${converted}] Document: "${doc.title}" (${doc.id}) ---`);
    console.log(`  HTML length: ${doc.content.length} -> MD length: ${md.length}`);
    console.log(`  Preview (first 200 chars): ${md.slice(0, 200).replace(/\n/g, "\\n")}`);

    if (applyMode) {
      await sql`UPDATE documents SET content = ${md} WHERE id = ${doc.id}`;
      console.log(`  -> Updated.`);
    }
  }

  // Migrate document_versions table
  const versions = await sql`SELECT id, document_id, version, title, content FROM document_versions ORDER BY created_at`;
  console.log(`\nFound ${versions.length} document versions to check.\n`);

  let vConverted = 0;
  for (const v of versions) {
    if (!isHtml(v.content)) {
      continue;
    }
    const md = turndown.turndown(v.content);
    vConverted++;
    console.log(`--- [${vConverted}] Version: doc=${v.document_id} v${v.version} "${v.title}" ---`);
    console.log(`  HTML length: ${v.content.length} -> MD length: ${md.length}`);

    if (applyMode) {
      await sql`UPDATE document_versions SET content = ${md} WHERE id = ${v.id}`;
      console.log(`  -> Updated.`);
    }
  }

  console.log(`\n========================================`);
  console.log(`Documents converted: ${converted}/${docs.length}`);
  console.log(`Versions  converted: ${vConverted}/${versions.length}`);
  if (!applyMode && (converted > 0 || vConverted > 0)) {
    console.log(`\nRun with --apply to write changes to the database.`);
  }

  await sql.end();
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
