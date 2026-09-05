/**
 * The skill registry.
 *
 * Each skill is a markdown file with YAML front matter: a `name`, a
 * `description` that goes in the prompt's skill index, and a body the model
 * loads with `load_skill` when a request matches. This keeps the rules for
 * less frequent flows out of every request's prompt — the pattern from
 * `commerce_common/skills.py` in anthropics/commerce-agents (Apache-2.0).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface Skill {
  name: string;
  description: string;
  body: string;
}

const SKILLS_DIR = join(import.meta.dirname, "skills");

function parse(source: string, fallbackName: string): Skill {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source);
  if (!match)
    return { name: fallbackName, description: "", body: source.trim() };
  const [, frontMatter, body] = match;
  const fields: Record<string, string> = {};
  let currentKey: string | null = null;
  for (const line of (frontMatter ?? "").split("\n")) {
    const keyed = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (keyed) {
      currentKey = keyed[1]!;
      fields[currentKey] = keyed[2]!.trim();
    } else if (currentKey && line.trim() !== "") {
      fields[currentKey] += " " + line.trim();
    }
  }
  return {
    name: fields.name ?? fallbackName,
    description: fields.description ?? "",
    body: (body ?? "").trim(),
  };
}

let cached: Skill[] | null = null;

export function skills(): Skill[] {
  if (cached) return cached;
  const files = readdirSync(SKILLS_DIR)
    .filter((file) => file.endsWith(".md"))
    .sort();
  cached = files.map((file) =>
    parse(
      readFileSync(join(SKILLS_DIR, file), "utf8"),
      file.replace(/\.md$/, ""),
    ),
  );
  return cached;
}

export function skillByName(name: string): Skill | undefined {
  return skills().find((skill) => skill.name === name);
}

export function skillNames(): string[] {
  return skills().map((skill) => skill.name);
}

/** The index block the static prompt carries: one line per skill. */
export function skillIndexBlock(): string {
  return skills()
    .map((skill) => `- \`${skill.name}\` — ${skill.description}`)
    .join("\n");
}
