// Build the installable plugin package dist/bkms-app-center-<version>.tgz (no runtime dependencies, no install scripts),
// then check the files XBuddy's plugin page and loader read are inside.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
mkdirSync('dist', { recursive: true })
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
execFileSync(pnpm, ['pack', '--pack-destination', 'dist'], { stdio: 'inherit', shell: process.platform === 'win32' })
const file = join('dist', `bkms-app-center-${pkg.version}.tgz`)
const listing = execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)
const required = ['package/package.json', 'package/cordis.patch.yml', 'package/lib/index.js', 'package/lib/client.js', 'package/locale/en.json', 'package/locale/zh.json', 'package/assets/icon.svg']
const missing = required.filter(name => !listing.includes(name))
const forbidden = listing.filter(name => /^package\/(demo|src|test|node_modules)\//.test(name))
if (missing.length || forbidden.length) { console.error({ missing, forbidden }); process.exit(1) }
console.log(`${file}  ${(statSync(file).size / 1024).toFixed(0)} KB, ${listing.length} files`)
