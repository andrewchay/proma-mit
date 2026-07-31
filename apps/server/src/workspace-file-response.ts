/** 工作区文件始终按下载返回，避免用户或 Agent 写入的 HTML 在服务端同源执行。 */
export function createWorkspaceFileDownloadResponse(body: Uint8Array, contentType?: string): Response {
  return new Response(bytesToArrayBuffer(body), {
    headers: {
      'content-type': contentType ?? 'application/octet-stream',
      'content-disposition': 'attachment',
      'x-content-type-options': 'nosniff',
    },
  })
}

function bytesToArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer
}
