import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
await mkdir('lib', { recursive: true })
// React and DSH modules come from the host's module loader; CSS is bundled as text and injected at runtime.
const result = await build({ entryPoints: ['client/index.tsx'], bundle: true, write: false, platform: 'browser', format: 'cjs', target: 'es2022', jsx: 'transform', loader: { '.css': 'text' }, external: ['react', '@deepseek-ai/*'], define: { 'process.env.NODE_ENV': '"production"' } })
await writeFile('lib/client.js', 'window.__ModuleLoader__.load({id:"@bkms/app-center",factory:(require)=>{var module={exports:{}};var exports=module.exports;\n' + result.outputFiles[0].text + '\nreturn module.exports;}});\n')
console.log('lib/client.js')
