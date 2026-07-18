/**
 * pdf-parse 子路径类型声明
 *
 * 主包入口包含调试代码，Electron 打包后会误触发读取测试文件；
 * 业务代码直接加载 lib/pdf-parse.js，因此这里声明项目实际使用到的返回字段。
 */
declare module 'pdf-parse/lib/pdf-parse.js' {
  export interface PdfParseResult {
    text: string
    numpages: number
  }

  export default function pdfParse(buffer: Buffer): Promise<PdfParseResult>
}
