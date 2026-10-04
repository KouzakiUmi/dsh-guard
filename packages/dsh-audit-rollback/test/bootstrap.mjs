// Test-only resolution hook: prefer installed workspace peers. No files/links are written.
import { createRequire, registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const appRoot = process.env.DSH_APP_ROOT || (process.platform === 'win32' ? 'C:\\Program Files\\DSH NEXT\\resources\\app' : '')
const anchor = appRoot && join(appRoot, 'package.json')
const runtimeRequire = anchor && existsSync(anchor) ? createRequire(anchor) : undefined
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context) }
    catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('@deepseek-ai/') || !runtimeRequire) throw error
      // Preserve ESM export conditions: require.resolve would pick schemastery's CJS face.
      return nextResolve(specifier, { ...context, parentURL: pathToFileURL(anchor).href })
    }
  },
})
export const testRequire = createRequire(import.meta.url)
export function installedPath(specifier) {
  try { return testRequire.resolve(specifier) }
  catch (error) { if (!runtimeRequire) throw error; return runtimeRequire.resolve(specifier) }
}
