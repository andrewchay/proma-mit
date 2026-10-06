import { describe, expect, it } from "bun:test"
import { builtinBenchmarkTemplates, explorerTemplate } from "./templates"

describe("预置评测模板", () => {
  it("继承用户已配置的运行渠道和模型", () => {
    for (const template of builtinBenchmarkTemplates) {
      expect(template.provider).toBe("")
      expect(template.modelId).toBe("")
    }
  })

  it("Explorer 用例自带可验证的项目清单", () => {
    expect(explorerTemplate.cases[0]?.statement).toContain("src/routes/auth.routes.ts")
    expect(explorerTemplate.cases[1]?.statement).toContain("src/api/users.ts")
    for (const testCase of explorerTemplate.cases) {
      expect(testCase.rubricItems.reduce((total, item) => total + item.points, 0)).toBe(100)
    }
  })
})
