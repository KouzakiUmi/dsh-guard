// Official strict Typert InvocationDescriptor shape; source metadata uses one request parameter.
export function parseRollbackRequest(method, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_REQUEST')
  const fields = method === 'changedFiles' ? ['sessionId', 'cursor', 'limit', 'turn'] : method === 'preview' ? ['sessionId', 'entryId'] : ['sessionId', 'entryId', 'nonce', 'expectedCurrentHash']
  if (Object.keys(value).some((key) => !fields.includes(key))) throw new Error('UNEXPECTED_REQUEST_FIELD')
  if (typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId === 'unknown' || value.sessionId.length > 512) throw new Error('INVALID_SESSION')
  if (method === 'changedFiles') {
    for (const key of ['cursor', 'limit', 'turn']) if (value[key] !== undefined && !Number.isSafeInteger(value[key])) throw new Error('INVALID_PAGE')
    if ((value.cursor ?? 0) < 0 || (value.limit ?? 25) < 1 || (value.limit ?? 25) > 100) throw new Error('INVALID_PAGE')
  } else {
    if (!/^entry-[a-f0-9]{64}$/.test(value.entryId || '')) throw new Error('INVALID_ENTRY_ID')
    if (method === 'restore' && (!/^[a-f0-9-]{36}$/.test(value.nonce || '') || !/^(absent|[a-f0-9]{40})$/.test(value.expectedCurrentHash || ''))) throw new Error('INVALID_PREVIEW_BINDING')
  }
  return value
}
export function parseRollbackResult(method, value) {
  if (!value || typeof value !== 'object' || typeof value.sessionId !== 'string') throw new Error('INVALID_ROLLBACK_RESULT')
  if (method === 'changedFiles' && (!Array.isArray(value.rows) || !Number.isSafeInteger(value.total))) throw new Error('INVALID_FILE_LIST')
  if (method === 'preview' && (typeof value.entryId !== 'string' || typeof value.canRestore !== 'boolean' || !value.diff || typeof value.diff.text !== 'string')) throw new Error('INVALID_PREVIEW')
  if (method === 'restore' && (typeof value.applied !== 'boolean' || typeof value.recorded !== 'boolean' || typeof value.operationId !== 'string')) throw new Error('INVALID_RECEIPT')
  return value
}
export const rollbackMethods = ['changedFiles', 'preview', 'restore']
const codec = (typeSymbol, parse) => ({ mode: 'strict', typeSymbol, schema: { parse }, create: () => ({ parse }) })
export const rollbackDescriptors = rollbackMethods.map((method) => ({
  id: 'dsh-audit-rollback#auditRollback/' + method,
  service: 'auditRollback', namespace: 'auditRollback', method, invocation: { kind: 'direct' },
  parameters: [{ name: 'request', wire: 'request', source: 'json', codec: codec('dsh-audit-rollback#' + method + ':request', (v) => parseRollbackRequest(method, v)) }],
  result: codec('dsh-audit-rollback#' + method + ':result', (v) => parseRollbackResult(method, v)),
}))
