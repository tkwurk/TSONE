#!/usr/bin/env node
/**
 * Deploy the Apps Script backend (apps-script-source/) to one or all outlets.
 *
 * Every outlet has its own Google Sheet with its own bound Apps Script project.
 * They all run the SAME code; only the script ID / deployment ID differ. Those
 * IDs live in outlets.local.json (git-ignored, never published).
 *
 *   npm run deploy /all          push + redeploy every outlet
 *   npm run deploy all           (same)
 *   npm run deploy TS1           only TS1
 *   npm run deploy TS1 TS3       TS1 and TS3
 *   npm run deploy TS1 --push-only   push code, skip the Web App redeploy
 *   npm run outlets:secret       print the VITE_OUTLETS value for GitHub
 *
 * For each outlet: `clasp push --force`, then update the existing Web App
 * deployment in place (so its /exec URL never changes). If an outlet has no
 * deploymentId yet, a new deployment is created and its ID is saved back to
 * outlets.local.json.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG_FILE = join(ROOT, 'outlets.local.json')
const SOURCE_DIR = join(ROOT, 'apps-script-source')
const PROJECT_DIR = join(ROOT, '.clasp-outlets')

function fail(msg) {
  console.error(`\n✖ ${msg}\n`)
  process.exit(1)
}

function loadOutlets() {
  if (!existsSync(CONFIG_FILE)) {
    fail('outlets.local.json not found. Copy outlets.example.json to outlets.local.json and fill in your outlets.')
  }
  const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
  const outlets = Object.fromEntries(Object.entries(raw).filter(([name]) => !name.startsWith('_')))
  for (const [name, o] of Object.entries(outlets)) {
    if (!o || !o.scriptId || o.scriptId.startsWith('PASTE_')) fail(`Outlet "${name}" has no scriptId in outlets.local.json.`)
  }
  return outlets
}

function saveOutlets(outlets) {
  const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
  for (const [name, o] of Object.entries(outlets)) raw[name] = o
  writeFileSync(CONFIG_FILE, JSON.stringify(raw, null, 2) + '\n')
}

function execUrl(deploymentId) {
  return `https://script.google.com/macros/s/${deploymentId}/exec`
}

function clasp(projectFile, args) {
  // shell:true so Windows finds clasp.cmd; args are fixed strings + IDs from our own config.
  return execFileSync('clasp', ['-P', projectFile, ...args], {
    // Run inside the source folder so pushed file names are relative to it
    // (from the repo root clasp would prefix them with "apps-script-source\").
    cwd: SOURCE_DIR,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: ['inherit', 'pipe', 'pipe'],
  })
}

function writeProjectFile(name, scriptId) {
  mkdirSync(PROJECT_DIR, { recursive: true })
  const file = join(PROJECT_DIR, `${name}.json`)
  writeFileSync(
    file,
    JSON.stringify(
      {
        scriptId,
        rootDir: SOURCE_DIR,
        scriptExtensions: ['.js', '.gs'],
        htmlExtensions: ['.html'],
        jsonExtensions: ['.json'],
        filePushOrder: [],
        skipSubdirectories: false,
      },
      null,
      2,
    ),
  )
  return file
}

function deployOutlet(name, outlet, { pushOnly }) {
  const project = writeProjectFile(name, outlet.scriptId)
  console.log(`\n==> ${name}: pushing code…`)
  process.stdout.write(clasp(project, ['push', '--force']))

  if (pushOnly) return
  // No spaces: on Windows the args go through a shell.
  const description = `deploy-${new Date().toISOString()}`
  if (outlet.deploymentId) {
    console.log(`==> ${name}: updating Web App deployment…`)
    process.stdout.write(clasp(project, ['update-deployment', outlet.deploymentId, '-d', description]))
  } else {
    console.log(`==> ${name}: creating Web App deployment…`)
    const out = clasp(project, ['create-deployment', '-d', description])
    process.stdout.write(out)
    const id = out.match(/AKfy[\w-]+/)?.[0]
    if (!id) throw new Error('Could not read the new deployment ID from clasp output.')
    outlet.deploymentId = id
    console.log(`==> ${name}: saved deploymentId to outlets.local.json`)
  }
  console.log(`==> ${name}: ${execUrl(outlet.deploymentId)}`)
}

function printSecret(outlets) {
  const list = Object.entries(outlets)
    .filter(([, o]) => o.deploymentId)
    .map(([name, o]) => ({ name, url: execUrl(o.deploymentId) }))
  const missing = Object.keys(outlets).filter((n) => !outlets[n].deploymentId)
  if (missing.length) console.error(`(skipped, not deployed yet: ${missing.join(', ')})`)
  console.log(JSON.stringify(list))
}

function main() {
  const args = process.argv.slice(2)
  const outlets = loadOutlets()

  if (args.includes('--secret')) return printSecret(outlets)

  const pushOnly = args.includes('--push-only')
  // Keep only the last path segment: "/all" → "all". Git Bash on Windows rewrites
  // a leading-slash argument into a path (e.g. "C:/Program Files/Git/all").
  const targets = args.filter((a) => !a.startsWith('--')).map((a) => a.split(/[\\/]/).pop())
  if (!targets.length) {
    fail(`Say which outlet(s) to deploy: npm run deploy /all  |  npm run deploy ${Object.keys(outlets)[0] ?? 'TS1'}\nOutlets: ${Object.keys(outlets).join(', ')}`)
  }

  const names = targets.some((t) => t.toLowerCase() === 'all') ? Object.keys(outlets) : targets
  const unknown = names.filter((n) => !outlets[n])
  if (unknown.length) fail(`Unknown outlet(s): ${unknown.join(', ')}. Known: ${Object.keys(outlets).join(', ')}`)

  const failed = []
  for (const name of names) {
    try {
      deployOutlet(name, outlets[name], { pushOnly })
    } catch (err) {
      failed.push(name)
      console.error(`✖ ${name} failed:\n${err.stderr || err.message}`)
    }
  }
  saveOutlets(outlets)

  const ok = names.filter((n) => !failed.includes(n))
  console.log(`\nDone. OK: ${ok.join(', ') || '-'}${failed.length ? `  FAILED: ${failed.join(', ')}` : ''}`)
  if (failed.length) process.exit(1)
}

main()
