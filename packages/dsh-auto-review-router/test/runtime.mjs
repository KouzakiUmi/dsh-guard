// Offline dependency bootstrap. Normal checkout dependencies always win.
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

const root = process.env.DSH_APP_ROOT
if (root) {
  if (!existsSync(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))) throw new Error('DSH_APP_ROOT must point to a confirmed official installation root')
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try { return nextResolve(specifier, context) }
      catch (error) {
        if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('@deepseek-ai/')) throw error
        return nextResolve(specifier, { ...context, parentURL: pathToFileURL(join(root, 'package.json')).href })
      }
    },
  })
}
