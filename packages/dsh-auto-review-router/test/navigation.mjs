import { testSingleSettingsEntry } from '../../../tools/test-single-settings-entry.mjs'
await testSingleSettingsEntry(new URL('../lib/client.js', import.meta.url), 'auto-review-router-tab')
