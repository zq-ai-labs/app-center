// End to end with the real plugin center sync engine (sibling checkout ../bkms-plugin-center): the plugin center installs
// an app from its offline seed, the app registers with the real app center and appears; the app center itself never
// talks to the plugin center.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { apply } from '../lib/index.js'
import { createFakeHost } from '../demo/fake-host.mjs'
import { registerContract, registerMail } from '../demo/apps.mjs'

const syncModule = new URL('../../bkms-plugin-center/src/sync.mjs', import.meta.url)
const available = existsSync(syncModule)
const tmp = () => mkdtempSync(join(tmpdir(), 'ac-e2e-'))

function tarball(json) {
  const body = Buffer.from(json), header = Buffer.alloc(512)
  header.write('package/package.json', 0); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116)
  header.write(body.length.toString(8).padStart(11, '0') + '\0', 124); header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136)
  header.write('        ', 148); header.write('0', 156); header.write('ustar\0' + '00', 257)
  let sum = 0; for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
  return gzipSync(Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512), Buffer.alloc(1024)]))
}
const nameOf = path => { const tar = gunzipSync(readFileSync(path)); const size = parseInt(tar.subarray(124, 136).toString().replace(/\0.*$/s, '').trim(), 8); return JSON.parse(tar.subarray(512, 512 + size).toString()) }

function seedFor(packageName, version) {
  const seed = tmp()
  mkdirSync(join(seed, 'packages'))
  const manifest = { name: packageName, version, dsh: { bundle: { patch: './cordis.patch.yml' } } }
  const bytes = tarball(JSON.stringify(manifest))
  writeFileSync(join(seed, 'packages', 'app-contract.tgz'), bytes)
  const artifact = { url: 'http://127.0.0.1:9/never.tgz', sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, version, manifest, restart: { mode: 'none' } }
  writeFileSync(join(seed, 'distribution-v2.json'), JSON.stringify({ schemaVersion: 2, revision: 1, rules: [{ packageName, name: '合同', version, artifact, installMode: 'required', autoUpgrade: true, restart: { mode: 'none' } }] }))
  writeFileSync(join(seed, 'plugins.json'), JSON.stringify({ plugins: [{ name: '合同', packageName, url: 'seed://app-contract', version, artifact, app: { id: 'contract', category: '法务', summary: '合同风险评审、按模板起草', icon: '审' } }] }))
  return seed
}

test('the real plugin center installs an app from its seed; the app registers and appears; until then it is simply absent', { skip: !available && 'needs ../bkms-plugin-center' }, async () => {
  const { createSync } = await import(syncModule.href)
  const seed = seedFor('@bkms/app-contract', '1.2.0')
  let host
  let failNext = true
  const bundles = new Map()
  // The host plugin manager: installing the package hot-loads the app, which registers with the app center.
  const manager = () => ({
    async listBundles() { return [...bundles.values()] },
    async installBundle(spec) {
      if (failNext) { failNext = false; return { application: 'failed', error: { code: 'ETIMEDOUT', diagnostic: 'Error: ETIMEDOUT (simulated)' } } }
      const manifest = nameOf(spec.replace(/^file:/, ''))
      bundles.set(manifest.name, { name: manifest.name, version: manifest.version, installed: true, enabled: true })
      registerContract(host.provided.get('appCenter'))
      return { application: 'applied' }
    },
  })
  const offline = async () => { throw new Error('getaddrinfo ENOTFOUND center') }
  const sync = createSync({ manager, home: tmp(), stateDir: tmp(), fetcher: offline, timers: { set: () => 0, clear: () => {} }, seed, preset: { center: 'http://127.0.0.1:9/plugin-center/plugins.json' } })
  // The app center knows nothing about the plugin center.
  host = createFakeHost()
  apply(host.ctx, { dataDir: tmp() })
  registerMail(host.provided.get('appCenter'), { contract: () => undefined })
  const listed = async () => (await host.fetchRoute('/api/bkms-app-center', { action: 'apps' })).value.apps.map(app => app.id)

  assert.deepEqual(await listed(), ['mail'])
  assert.equal(host.skills.has('app-contract'), false)
  assert.equal((await host.callTool('app_call', { app: 'contract', action: 'list', args: {} })).value.code, 'unknown_app')

  // The first install fails inside the plugin center: nothing changes in the app center.
  await sync.checkNow()
  assert.equal(sync.status().plugins[0].failures, 1)
  assert.deepEqual(await listed(), ['mail'])

  // The plugin center retries (its own retry); the seed package installs without downloading, the app registers.
  await sync.retry('@bkms/app-contract')
  assert.deepEqual((await listed()).sort(), ['contract', 'mail'])
  assert.match(host.skills.get('app-contract').content, /### start/)
  assert.equal((await host.callTool('app_call', { app: 'contract', action: 'templates', args: {} })).value.ok, true)
  assert.equal(sync.status().policySource, 'seed')
  host.dispose()
})
