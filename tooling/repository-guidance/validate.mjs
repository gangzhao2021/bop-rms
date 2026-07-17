import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const proposed = Array.from({ length: 17 }, (_, index) => String(index + 1).padStart(4, "0"));
const accepted = Array.from({ length: 12 }, (_, index) => String(index + 18).padStart(4, "0"));
const expectedAdrs = new Map([
  ...proposed.map((id) => [id, "Proposed"]),
  ...accepted.map((id) => [id, "Accepted"]),
]);
const expectedSkills = [
  "bop-work-package",
  "bop-screen-contract",
  "bop-domain-change",
  "bop-security-privacy-review",
  "bop-verification",
];

const read = (relativePath) => readFile(path.join(root, relativePath), "utf8");
const fail = (message) => {
  throw new Error(message);
};

function requireText(text, tokens, label) {
  for (const token of tokens) {
    if (!text.includes(token)) fail(`${label}: missing ${JSON.stringify(token)}`);
  }
}

function validatePortable(text, label) {
  for (const pattern of [
    /(?:^|[\s`(])\/(?:home|Users)\/[A-Za-z0-9._-]+\//m,
    /(?:^|[\s`(])\/mnt\/[a-z]\//m,
    /[A-Za-z]:\\(?:Users|projects)\\/m,
    /(?:TODO|FIXME|Replace with a description of)/,
    /gho_[A-Za-z0-9_]+/,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  ]) {
    if (pattern.test(text)) fail(`${label}: forbidden or unresolved content ${pattern}`);
  }
}

function validateAdr(text, id, status, label) {
  requireText(
    text,
    [
      `# ADR-${id} —`,
      `- Status: \`${status}\``,
      "- Owner:",
      "- Affected modules:",
      "- Source: Canonical Handoff",
      "## Context",
      "## Decision",
      "## Consequences",
      "## Revisit trigger",
    ],
    label,
  );
  validatePortable(text, label);
}

function parseFrontmatter(text, label) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) fail(`${label}: missing YAML frontmatter`);
  const entries = new Map();
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 1) fail(`${label}: invalid frontmatter line`);
    entries.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  if ([...entries.keys()].some((key) => !["name", "description"].includes(key))) {
    fail(`${label}: frontmatter allows only name and description`);
  }
  return entries;
}

function validateSkill(text, name) {
  const label = `.agents/skills/${name}/SKILL.md`;
  const frontmatter = parseFrontmatter(text, label);
  assert.equal(frontmatter.get("name"), name, `${label}: name mismatch`);
  const description = frontmatter.get("description") ?? "";
  if (description.length < 80 || !/Use (for|to|when)/.test(description)) {
    fail(`${label}: description must explain capability and trigger`);
  }
  requireText(
    text,
    [
      "## Required inputs",
      "WP",
      "## Workflow",
      "## Hard stops",
      "## Output",
      "## Smoke scenarios",
      "- Positive:",
      "- Boundary:",
    ],
    label,
  );
  if (/```(?:bash|sh|shell)[\s\S]*?\b(?:git push|gh pr merge|deploy)\b/.test(text)) {
    fail(`${label}: external mutation command is not allowed`);
  }
  validatePortable(text, label);
}

function validateOpenAiYaml(text, name) {
  const label = `.agents/skills/${name}/agents/openai.yaml`;
  requireText(
    text,
    ["interface:", "display_name:", "short_description:", "default_prompt:", `$${name}`],
    label,
  );
  validatePortable(text, label);
}

function validateModuleTemplate(text) {
  requireText(
    text,
    [
      "Template only",
      "## Identity and responsibility",
      "## Public contract",
      "## Dependencies",
      "Forbidden dependencies",
      "## Data ownership and lifecycle",
      "Tenant / Brand / Store",
      "never binary float",
      "## Persistence and eventing",
      "Not implemented",
      "## Security and privacy",
      "## Operations",
      "## Development and verification",
      "## Decisions and follow-up",
    ],
    "module README template",
  );
  validatePortable(text, "module README template");
}

function validateDeveloperSetup(text) {
  requireText(
    text,
    [
      "## Supported environment",
      "Node.js `24.18.0`",
      "Corepack `0.35.0`",
      "pnpm `11.13.0`",
      "Turbo `2.10.5`",
      "## Checkout and install",
      "pnpm install --frozen-lockfile",
      "## Local-only configuration",
      "chmod 0600",
      "## Validate and run",
      "pnpm environment:check",
      "pnpm dev",
      "database `not_configured`",
      "## Verify a change",
      "pnpm repository-guidance:check",
      "## Worktree template",
      "exact expected PR head",
      "## Troubleshooting and cleanup",
    ],
    "developer setup",
  );
  validatePortable(text, "developer setup");
}

function runBoundarySmoke(samples) {
  assert.throws(
    () => validateSkill(samples.skill.replace("- Boundary:", "- Omitted:"), "bop-work-package"),
    /missing "- Boundary:"/,
  );
  assert.throws(
    () =>
      validateAdr(
        samples.adr.replace("- Status: `Proposed`", "- Status: `Accepted`"),
        "0001",
        "Proposed",
        "smoke ADR",
      ),
    /missing "- Status: `Proposed`"/,
  );
  assert.throws(
    () => validateModuleTemplate(`${samples.module}\n/home/example/private/file`),
    /forbidden or unresolved content/,
  );
}

async function main() {
  const adrFiles = (await readdir(path.join(root, "docs/adr"))).filter((file) =>
    /^ADR-\d{4}-.+\.md$/.test(file),
  );
  const materialized = adrFiles.filter((file) => file !== "ADR-0000-template.md");
  assert.equal(materialized.length, expectedAdrs.size, "ADR file count mismatch");
  const seen = new Set();
  const adrTexts = new Map();
  for (const fileName of materialized) {
    const match = fileName.match(/^ADR-(\d{4})-[a-z0-9-]+\.md$/);
    if (!match) fail(`${fileName}: invalid ADR filename`);
    const id = match[1];
    if (!expectedAdrs.has(id) || seen.has(id)) fail(`${fileName}: unexpected or duplicate ADR ID`);
    seen.add(id);
    const text = await read(`docs/adr/${fileName}`);
    validateAdr(text, id, expectedAdrs.get(id), fileName);
    adrTexts.set(id, text);
  }
  for (const id of expectedAdrs.keys()) if (!seen.has(id)) fail(`missing ADR-${id}`);

  const skillDirectories = (
    await readdir(path.join(root, ".agents/skills"), { withFileTypes: true })
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(skillDirectories, [...expectedSkills].sort(), "repository skill set mismatch");
  const skillTexts = new Map();
  for (const name of expectedSkills) {
    const text = await read(`.agents/skills/${name}/SKILL.md`);
    validateSkill(text, name);
    validateOpenAiYaml(await read(`.agents/skills/${name}/agents/openai.yaml`), name);
    skillTexts.set(name, text);
  }

  const moduleTemplate = await read("docs/templates/module/README.md");
  validateModuleTemplate(moduleTemplate);
  validateDeveloperSetup(await read("docs/onboarding/developer-setup.md"));
  runBoundarySmoke({
    adr: adrTexts.get("0001"),
    skill: skillTexts.get("bop-work-package"),
    module: moduleTemplate,
  });
  process.stdout.write(
    `repository guidance valid: ${materialized.length} ADRs, ${expectedSkills.length} skills, templates, and boundary smoke scenarios\n`,
  );
}

await main();
