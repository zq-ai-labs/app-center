import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { Config, name, apply } from '../lib/index.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('package.json declares an XBuddy (DSH) bundle plugin with a web client', () => {
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json')
  assert.equal(pkg.exports['./cordis.patch.yml'], './cordis.patch.yml')
  for (const file of ['lib', 'locale/*.json', 'assets/icon.svg', 'cordis.patch.yml']) assert.ok(pkg.files.includes(file), file)
  assert.ok(existsSync(new URL(`../${pkg.icon}`, import.meta.url)))
  assert.equal(pkg.dependencies, undefined, 'no runtime dependencies to bundle')
  assert.ok(!Object.keys(pkg.scripts).some(script => /^(pre|post)?install$|^prepare$/.test(script)), 'no install scripts')
})

test('DSH peers are ranges, not exact pins, so a client update does not disable the plugin', () => {
  for (const [peer, range] of Object.entries(pkg.peerDependencies)) {
    if (/^@deepseek-ai\/dsh(-|$)/.test(peer)) assert.match(range, /^>=\S+ <\S+$/, `${peer} ${range}`)
  }
})

test('the bundle patch inserts this plugin and the plugin page has a title and description', () => {
  assert.match(read('cordis.patch.yml'), /id: bkms-app-center\s+name: '@bkms\/app-center'/)
  for (const locale of ['en', 'zh']) {
    const dictionary = JSON.parse(read(`locale/${locale}.json`))
    assert.ok(dictionary.meta.title && dictionary.meta.description, locale)
    for (const key of Object.keys(Config({}))) assert.ok(dictionary[key], `${locale}: label for ${key}`)
  }
})

test('the host entry exports name, apply and a settings schema with safe defaults', () => {
  assert.equal(name, 'bkms-app-center')
  assert.equal(typeof apply, 'function')
  assert.deepEqual(Config({}), { confirmDrafts: false, resident: ['mail.search'], dataDir: '', sampleApps: false })
})

test('the client bundle registers itself with the host module loader and only needs React from it', () => {
  const client = read('lib/client.js')
  assert.ok(client.startsWith('window.__ModuleLoader__.load({id:"@bkms/app-center"'))
  const requests = [...new Set([...client.matchAll(/require\("([^"]+)"\)/g)].map(match => match[1]))]
  assert.deepEqual(requests, ['react'])
})
