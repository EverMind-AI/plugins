import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8')

// DSH resolves the module to load from `name` in the bundled cordis patch, so a
// rename that misses the patch ships a package the host cannot load.
test('the cordis patch loads the module this package actually publishes', () => {
  const { name } = JSON.parse(read('package.json')) as { name: string }
  const patch = read('cordis.patch.yml')

  assert.match(patch, new RegExp(`^\\s*name: '${name}'$`, 'm'))
})
