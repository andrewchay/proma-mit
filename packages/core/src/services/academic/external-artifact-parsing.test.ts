import { describe, expect, test } from 'bun:test'

/**
 * DVC 指针解析测试（M6.2）：
 * - 标准 outs 列表形式（含 md5/size/path）
 * - hash + hashAlgorithm 形式（DVC 3+）
 * - 缺路径/空文件/非 .dvc 拒绝
 * - 关键语义：解析结果永远标注「实体数据不在本地」并给出取数提示
 */

const { ResearchError, dvcRefOf, parseDvcPointer } = await import('@gravitas/core/services/academic')

describe('DVC 指针解析', () => {
  test('标准 outs 列表形式（md5 + size + path）', () => {
    const pointer = parseDvcPointer(
      'data/results.csv.dvc',
      `outs:
- md5: a1b2c3d4e5f60718293a4b5c6d7e8f90
  size: 204800
  path: results.csv
`,
    )
    expect(pointer.dataPath).toBe('results.csv')
    expect(pointer.hash).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f90')
    expect(pointer.sizeBytes).toBe(204800)
    // 指针不包含数据实体——必须明确标注
    expect(pointer.dataAvailableLocally).toBe(false)
    expect(pointer.fetchHint).toContain('dvc pull')
  })

  test('远端形式给出 remote 信息', () => {
    const pointer = parseDvcPointer(
      'data/big.parquet.dvc',
      `outs:
- md5: deadbeef
  size: 1024
  path: big.parquet
  remote: s3-store
`,
    )
    expect(pointer.remote).toBe('s3-store')
    expect(pointer.fetchHint).toContain('s3-store')
  })

  test('带引号的路径被还原', () => {
    const pointer = parseDvcPointer(
      'data/weird.dvc',
      `outs:
- md5: abc123
  path: "results with spaces.csv"
`,
    )
    expect(pointer.dataPath).toBe('results with spaces.csv')
  })

  test('非 .dvc/空文件/缺路径均拒绝', () => {
    expect(() => parseDvcPointer('plain.yaml', 'outs: []')).toThrow(ResearchError)
    expect(() => parseDvcPointer('x.dvc', '   ')).toThrow('为空')
    expect(() => parseDvcPointer('x.dvc', 'outs:\n- md5: abc\n')).toThrow('缺少数据路径')
  })

  test('dvcRefOf 生成外部引用形式（不进本地文件校验）', () => {
    const pointer = parseDvcPointer('d.dvc', 'outs:\n- md5: abc123\n  path: x.csv\n')
    expect(dvcRefOf(pointer)).toBe('dvc:abc123')
    // 该形态会被产物分类器视为 external（integrity=unverified）
    expect(/^dvc:/.test(dvcRefOf(pointer))).toBe(true)
  })

  test('无哈希时用路径构造引用', () => {
    const pointer = parseDvcPointer('d.dvc', 'outs:\n- path: x.csv\n')
    expect(dvcRefOf(pointer)).toBe('dvc:x.csv')
  })
})
