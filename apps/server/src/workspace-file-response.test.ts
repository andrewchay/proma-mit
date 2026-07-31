import { expect, test } from 'bun:test'
import { createWorkspaceFileDownloadResponse } from './workspace-file-response.ts'

test('given a workspace HTML file when downloading then browser execution is disabled', () => {
  const response = createWorkspaceFileDownloadResponse(new TextEncoder().encode('<script>danger()</script>'), 'text/html')

  expect(response.headers.get('content-type')).toBe('text/html')
  expect(response.headers.get('content-disposition')).toBe('attachment')
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
})
