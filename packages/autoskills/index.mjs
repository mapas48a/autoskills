#!/usr/bin/env node

import { resolve, dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { detectTechnologies, collectSkills } from "./lib.mjs";
import { bold, dim, green, yellow, cyan, magenta, red, gray, white, pink, SHOW_CURSOR } from "./colors.mjs";
import { printBanner, multiSelect, formatTime } from "./ui.mjs";
import { installAll } from "./installer.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf-8")).version;

process.on("SIGINT", () => {
  process.stdout.write(SHOW_CURSOR + "\n");
  process.exit(130);
});

// ── CLI ──────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    autoYes: args.includes("-y") || args.includes("--yes"),
    dryRun: args.includes("--dry-run"),
    verbose: args.includes("--verbose") || args.includes("-v"),
    help: args.includes("--help") || args.includes("-h"),
  };
}

function showHelp() {
  console.log(`
  ${bold("autoskills")} — Auto-install the best AI skills for your project

  ${bold("Usage:")}
    npx autoskills            Detect & install skills
    npx autoskills ${dim("-y")}        Skip confirmation
    npx autoskills ${dim("--dry-run")} Show what would be installed

  ${bold("Options:")}
    -y, --yes       Skip confirmation prompt
    --dry-run       Show skills without installing
    -v, --verbose   Show error details on failure
    -h, --help      Show this help message
`);
}

// ── Display ──────────────────────────────────────────────────

function printDetected(detected, combos, isFrontend) {
  if (detected.length > 0) {
    const withSkills = detected.filter((t) => t.skills.length > 0);
    const withoutSkills = detected.filter((t) => t.skills.length === 0);
    const allTech = [...withSkills, ...withoutSkills];

    console.log(cyan("   ▸ ") + bold("Detected technologies:"));
    console.log();

    const COLS = 3;
    const maxNameLen = Math.max(...allTech.map((t) => t.name.length));
    const colWidth = maxNameLen + 3;
    const rows = Math.ceil(allTech.length / COLS);

    for (let r = 0; r < rows; r++) {
      let line = "     ";
      for (let c = 0; c < COLS; c++) {
        const idx = r * COLS + c;
        if (idx < allTech.length) {
          const tech = allTech[idx];
          const hasSkills = tech.skills.length > 0;
          const icon = hasSkills ? green("✔") : dim("●");
          const padded = tech.name.padEnd(colWidth);
          line += `${icon} ${hasSkills ? padded : dim(padded)}`;
        }
      }
      console.log(line);
    }

    if (combos.length > 0) {
      console.log();
      console.log(magenta("   ▸ ") + bold("Detected combos:"));
      console.log();
      for (const combo of combos) {
        console.log(magenta(`     ⚡ `) + combo.name);
      }
    }
    console.log();
  }

  if (isFrontend && detected.length === 0) {
    console.log(cyan("   ▸ ") + bold("Web frontend detected ") + dim("(from project files)"));
    console.log();
  }
}

function printSkillsList(skills) {
  const maxLen = Math.max(...skills.map((s) => s.skill.length));
  console.log(cyan("   ▸ ") + bold(`Skills to install `) + dim(`(${skills.length})`));
  console.log();
  for (let i = 0; i < skills.length; i++) {
    const { skill, sources } = skills[i];
    const pad = " ".repeat(maxLen - skill.length);
    const num = String(i + 1).padStart(2, " ");
    console.log(
      dim(`   ${num}.`) + ` ${cyan(skill)}${pad}  ${dim(`← ${sources.join(", ")}`)}`,
    );
  }
  console.log();
}

function printSummary({ installed, failed, errors, elapsed, verbose }) {
  console.log();
  if (failed === 0) {
    console.log(
      green(
        bold(
          `   ✔ Done! ${installed} skill${installed !== 1 ? "s" : ""} installed in ${formatTime(elapsed)}.`,
        ),
      ),
    );
  } else {
    console.log(
      yellow(
        `   Done: ${green(`${installed} installed`)}, ${red(`${failed} failed`)} in ${formatTime(elapsed)}.`,
      ),
    );

    if (errors.length > 0) {
      console.log();
      console.log(bold(red("   Errors:")));
      for (const { name, output } of errors) {
        console.log(red(`     ✘ ${name}`));
        if (verbose && output) {
          const lines = output.trim().split("\n").slice(-5);
          for (const line of lines) {
            console.log(dim(`       ${line}`));
          }
        }
      }
      if (!verbose) {
        console.log(dim("   Run with --verbose to see error details."));
      }
    }
  }
  console.log();
  console.log(pink("   Enjoyed autoskills? Consider sponsoring → https://github.com/sponsors/midudev"));
  console.log();
}

// ── Skill Selection ──────────────────────────────────────────

async function selectSkills(skills, autoYes) {
  const maxLen = Math.max(...skills.map((s) => s.skill.length));

  if (autoYes) {
    printSkillsList(skills);
    return skills;
  }

  console.log(
    cyan("   ▸ ") + bold(`Select skills to install `) + dim(`(${skills.length} found)`),
  );
  console.log();

  const selected = await multiSelect(skills, {
    labelFn: (s) => s.skill + " ".repeat(maxLen - s.skill.length),
    hintFn: (s) => (s.sources.length > 1 ? `← ${s.sources.join(", ")}` : ""),
    groupFn: (s) => s.sources[0],
  });

  if (selected.length === 0) {
    console.log();
    console.log(dim("   Nothing selected."));
    console.log();
    process.exit(0);
  }

  return selected;
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const { autoYes, dryRun, verbose, help } = parseArgs();

  if (help) {
    showHelp();
    process.exit(0);
  }

  printBanner(VERSION);

  const projectDir = resolve(".");

  process.stdout.write(dim("   Scanning project...\r"));
  const { detected, isFrontend, combos } = detectTechnologies(projectDir);
  process.stdout.write("\x1b[K");

  if (detected.length === 0 && !isFrontend) {
    console.log(yellow("   ⚠ No supported technologies detected."));
    console.log(dim("   Make sure you run this in a project directory."));
    console.log();
    process.exit(0);
  }

  printDetected(detected, combos, isFrontend);

  const skills = collectSkills(detected, isFrontend, combos);

  if (skills.length === 0) {
    console.log(yellow("   No skills available for your stack yet."));
    console.log(dim("   Check https://skills.sh for the latest."));
    console.log();
    process.exit(0);
  }

  if (dryRun) {
    printSkillsList(skills);
    console.log(dim("   --dry-run: nothing was installed."));
    console.log();
    process.exit(0);
  }

  const selectedSkills = await selectSkills(skills, autoYes);

  if (!autoYes && process.stdout.isTTY) {
    process.stdout.write("\x1b[H\x1b[2J\x1b[3J");
    printBanner(VERSION);
  } else {
    console.log();
  }

  console.log(cyan("   ▸ ") + bold("Installing skills..."));
  console.log();

  const startTime = Date.now();
  const { installed, failed, errors } = await installAll(selectedSkills);
  const elapsed = Date.now() - startTime;

  if (process.stdout.isTTY) {
    const up = selectedSkills.length + 2;
    process.stdout.write(`\x1b[${up}A\r\x1b[K`);
    console.log(green("   ▸ ") + bold("Done!"));
    process.stdout.write(`\x1b[${selectedSkills.length + 1}B`);
  }

  printSummary({ installed, failed, errors, elapsed, verbose });
}

main().catch((err) => {
  console.error(red(`\n   Error: ${err.message}\n`));
  process.exit(1);
});
