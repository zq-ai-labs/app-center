import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
await mkdir('demo/public', { recursive: true })
// The demo bundles React itself; in XBuddy the host provides it.
await build({ entryPoints: ['demo/client.tsx'], bundle: true, outfile: 'demo/public/app.js', platform: 'browser', format: 'iife', target: 'es2022', jsx: 'transform', loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"production"' }, minify: true })
console.log('demo/public/app.js')
