// Link this checkout into the local XBuddy desktop profile for a trial, or undo it.
//   node scripts/xbuddy-profile.mjs link [--samples]   add @bkms/app-center (optionally with the sample apps)
//   node scripts/xbuddy-profile.mjs unlink             restore the profile files saved by `link`
// Restart XBuddy afterwards. The profile folder can be overridden with XBUDDY_PROFILE.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const profile = process.env.XBUDDY_PROFILE || join(homedir(), '.xbuddy', 'profiles', 'desktop')
const NAME = '@bkms/app-center'
const BACKUP = '.bak-before-app-center'
const files = ['package.json', 'cordis.patch.yml']
const linkPath = join(profile, 'node_modules', '@bkms', 'app-center')
const [command, flag] = process.argv.slice(2)

if (!existsSync(join(profile, 'package.json'))) { console.error(`没有找到 XBuddy Profile：${profile}`); process.exit(1) }

if (command === 'link') {
  for (const file of files) if (existsSync(join(profile, file)) && !existsSync(join(profile, file + BACKUP))) copyFileSync(join(profile, file), join(profile, file + BACKUP))
  const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
  manifest.dependencies = { ...manifest.dependencies, [NAME]: `link:${root.replaceAll('\\', '/')}` }
  const bundles = manifest.dsh.profile.bundles
  if (!bundles.includes(NAME)) bundles.push(NAME)
  writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  mkdirSync(dirname(linkPath), { recursive: true })
  if (existsSync(linkPath) || isLink(linkPath)) rmSync(linkPath, { recursive: false, force: true })
  symlinkSync(root, linkPath, 'junction')
  if (flag === '--samples') {
    const patchFile = join(profile, 'cordis.patch.yml')
    const patch = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''
    if (!patch.includes('id: bkms-app-center')) writeFileSync(patchFile, patch.replace(/\s*$/, '\n') + `- id: bkms-app-center\n  name: '${NAME}'\n  config:\n    sampleApps: true\n`)
  }
  console.log(`已把 ${NAME} 链接进 ${profile}${flag === '--samples' ? '（含示例应用）' : ''}。重启 XBuddy 后在左侧栏看到“应用中心”。`)
} else if (command === 'unlink') {
  for (const file of files) if (existsSync(join(profile, file + BACKUP))) { copyFileSync(join(profile, file + BACKUP), join(profile, file)); rmSync(join(profile, file + BACKUP)) }
  if (existsSync(linkPath) || isLink(linkPath)) rmSync(linkPath, { recursive: false, force: true })
  console.log(`已从 ${profile} 移除 ${NAME} 并恢复原来的 Profile 文件。重启 XBuddy 生效。`)
} else {
  console.log('用法：node scripts/xbuddy-profile.mjs link [--samples] | unlink')
}

function isLink(path) { try { return lstatSync(path).isSymbolicLink() } catch { return false } }
