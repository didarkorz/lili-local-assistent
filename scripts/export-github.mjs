// Export reviewed source paths only. Never copy .git, user data or local models.
import { copyFileSync, lstatSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const files = [
  '.gitignore', '.gitattributes', 'README.md', 'PUBLISHING.md', 'LICENSE',
  'LILI_ABILITIES.txt', 'package.json', 'package-lock.json', 'index.html',
  'electron-builder.yml', 'postcss.config.js', 'tailwind.config.js',
  'tsconfig.json', 'tsconfig.node.json', 'vite.config.ts',
  'scripts/export-github.mjs', 'scripts/qwen_worker.py',
]

function collect(directory, extensions) {
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const relative = `${directory}/${entry.name}`
    if (entry.isSymbolicLink()) throw new Error(`Refusing symbolic link: ${relative}`)
    if (entry.isDirectory()) collect(relative, extensions)
    else if (extensions.includes(extname(entry.name))) files.push(relative)
  }
}

collect('electron', ['.ts'])
collect('src', ['.ts', '.tsx', '.css'])

// Validate the whole selection before creating an export. Keep private data out
// of source files too: this allowlist is not a substitute for a content review.
let bytes = 0
for (const relative of files) {
  const absolute = join(root, relative)
  const stat = lstatSync(absolute)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Not a regular file: ${relative}`)
  if (stat.size > 5 * 1024 * 1024) throw new Error(`Unexpectedly large source file: ${relative}`)
  bytes += stat.size
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const output = join(root, 'exports', `lili-github-${stamp}`)
mkdirSync(join(root, 'exports'), { recursive: true })
mkdirSync(output) // Do not overwrite an earlier export.
for (const relative of files) {
  const destination = join(output, relative)
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(join(root, relative), destination)
}
console.log(`Exported ${files.length} files (${(bytes / 1024).toFixed(1)} KiB).`)
console.log(output)
console.log('Publish this directory as a NEW repository. Do not copy the original .git directory.')
