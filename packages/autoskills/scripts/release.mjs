#!/usr/bin/env node

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const REPO_ROOT = resolve(ROOT, '..', '..')
const PKG_PATH = resolve(ROOT, 'package.json')
const CHANGELOG_PATH = resolve(ROOT, 'CHANGELOG.md')

const VALID_BUMPS = ['patch', 'minor', 'major']

function run(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf-8', cwd: ROOT, stdio: 'pipe', ...opts }).trim()
}

function runVisible(cmd, opts = {}) {
  execSync(cmd, { cwd: ROOT, stdio: 'inherit', ...opts })
}

function fail(msg) {
  console.error(`\n❌ ${msg}`)
  process.exit(1)
}

function bumpVersion(version, type) {
  const [major, minor, patch] = version.split('.').map(Number)
  switch (type) {
    case 'major': return `${major + 1}.0.0`
    case 'minor': return `${major}.${minor + 1}.0`
    case 'patch': return `${major}.${minor}.${patch + 1}`
  }
}

function getLastTag() {
  try {
    return run('git describe --tags --abbrev=0', { cwd: REPO_ROOT })
  } catch {
    return null
  }
}

function getCommitsSinceTag(tag) {
  const range = tag ? `${tag}..HEAD` : 'HEAD'
  const log = run(
    `git log ${range} --pretty=format:"%s|%h" -- packages/autoskills/`,
    { cwd: REPO_ROOT }
  )
  if (!log) return []
  return log.split('\n').filter(Boolean).map(line => {
    const [message, hash] = line.split('|')
    return { message, hash }
  })
}

function categorizeCommits(commits) {
  const categories = {
    breaking: [],
    feat: [],
    fix: [],
    other: []
  }

  for (const { message, hash } of commits) {
    const lower = message.toLowerCase()
    if (lower.startsWith('feat') || lower.includes('add ') || lower.includes('add:')) {
      categories.feat.push({ message, hash })
    } else if (lower.startsWith('fix') || lower.includes('fix ') || lower.includes('fix:')) {
      categories.fix.push({ message, hash })
    } else if (lower.includes('breaking') || lower.includes('!:')) {
      categories.breaking.push({ message, hash })
    } else {
      categories.other.push({ message, hash })
    }
  }

  return categories
}

function buildChangelog(version, categories, repoUrl) {
  const date = new Date().toISOString().split('T')[0]
  let md = `## [${version}](${repoUrl}/releases/tag/v${version}) (${date})\n\n`

  if (categories.breaking.length) {
    md += `### ⚠️ Breaking Changes\n\n`
    for (const { message, hash } of categories.breaking) {
      md += `- ${message} [\`${hash}\`](${repoUrl}/commit/${hash})\n`
    }
    md += '\n'
  }

  if (categories.feat.length) {
    md += `### ✨ Features\n\n`
    for (const { message, hash } of categories.feat) {
      md += `- ${message} [\`${hash}\`](${repoUrl}/commit/${hash})\n`
    }
    md += '\n'
  }

  if (categories.fix.length) {
    md += `### 🐛 Bug Fixes\n\n`
    for (const { message, hash } of categories.fix) {
      md += `- ${message} [\`${hash}\`](${repoUrl}/commit/${hash})\n`
    }
    md += '\n'
  }

  if (categories.other.length) {
    md += `### 📦 Other Changes\n\n`
    for (const { message, hash } of categories.other) {
      md += `- ${message} [\`${hash}\`](${repoUrl}/commit/${hash})\n`
    }
    md += '\n'
  }

  return md
}

function updateChangelog(newEntry) {
  if (existsSync(CHANGELOG_PATH)) {
    const existing = readFileSync(CHANGELOG_PATH, 'utf-8')
    const headerEnd = existing.indexOf('\n## ')
    if (headerEnd !== -1) {
      const header = existing.slice(0, headerEnd + 1)
      const rest = existing.slice(headerEnd + 1)
      writeFileSync(CHANGELOG_PATH, `${header}${newEntry}${rest}`)
    } else {
      const lines = existing.split('\n')
      const headerLines = lines.slice(0, 2).join('\n') + '\n\n'
      writeFileSync(CHANGELOG_PATH, `${headerLines}${newEntry}`)
    }
  } else {
    writeFileSync(CHANGELOG_PATH, `# Changelog\n\n${newEntry}`)
  }
}

// --- Main ---

const bump = process.argv[2]

if (!bump || !VALID_BUMPS.includes(bump)) {
  fail(`Uso: node scripts/release.mjs <${VALID_BUMPS.join('|')}>`)
}

const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8'))
const repoUrl = pkg.repository?.url?.replace(/\.git$/, '') || 'https://github.com/midudev/autoskills'
const currentVersion = pkg.version
const newVersion = bumpVersion(currentVersion, bump)

console.log(`\n📦 ${pkg.name} ${currentVersion} → ${newVersion} (${bump})\n`)

// 1. Ensure working directory is clean (except package.json which may have been bumped manually)
const status = run('git status --porcelain -- .', { cwd: REPO_ROOT })
const dirtyFiles = status.split('\n').filter(f => f.trim() && !f.includes('package.json'))
if (dirtyFiles.length) {
  fail(`Hay cambios sin commitear:\n${dirtyFiles.join('\n')}`)
}

// 2. Run tests
console.log('🧪 Ejecutando tests...')
try {
  runVisible('node --test tests/*.test.mjs')
} catch {
  fail('Los tests han fallado. Arregla los errores antes de publicar.')
}

// 3. Generate changelog
console.log('\n📝 Generando changelog...')
const lastTag = getLastTag()
const commits = getCommitsSinceTag(lastTag)

if (commits.length === 0) {
  fail('No hay commits nuevos desde el último tag.')
}

const categories = categorizeCommits(commits)
const changelogEntry = buildChangelog(newVersion, categories, repoUrl)

console.log(changelogEntry)

// 4. Update version in package.json
pkg.version = newVersion
writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n')
console.log(`✅ package.json actualizado a ${newVersion}`)

// 5. Update CHANGELOG.md
updateChangelog(changelogEntry)
console.log('✅ CHANGELOG.md actualizado')

// 6. Git commit + tag
console.log('\n🔖 Creando commit y tag...')
run(`git add package.json CHANGELOG.md`, { cwd: ROOT })
run(`git commit -m "release: v${newVersion}"`, { cwd: REPO_ROOT })
run(`git tag -a v${newVersion} -m "v${newVersion}"`, { cwd: REPO_ROOT })

// 7. Publish to npm
console.log('\n🚀 Publicando en npm...')
runVisible('npm publish --access public')

// 8. Push to GitHub
console.log('\n📤 Pusheando a GitHub...')
run('git push', { cwd: REPO_ROOT })
run('git push --tags', { cwd: REPO_ROOT })

// 9. Create GitHub release
console.log('\n🏷️  Creando GitHub Release...')
const releaseNotes = changelogEntry.replace(/^## .*\n\n/, '')
const tempFile = resolve(ROOT, '.release-notes-tmp.md')
writeFileSync(tempFile, releaseNotes)

try {
  run(
    `gh release create v${newVersion} --title "v${newVersion}" --notes-file .release-notes-tmp.md`,
    { cwd: ROOT }
  )
  console.log(`✅ Release v${newVersion} creada en GitHub`)
} catch (e) {
  console.warn(`⚠️  No se pudo crear la release en GitHub (¿tienes gh instalado y autenticado?)`)
  console.warn(`   Puedes crearla manualmente: ${repoUrl}/releases/new?tag=v${newVersion}`)
} finally {
  try { run(`rm .release-notes-tmp.md`) } catch {}
}

console.log(`\n🎉 ¡Release v${newVersion} completada!\n`)
