import { isAbsolute, join, resolve } from 'node:path'

interface TestBuildPackageMetadata {
  gravitasTestBuild?: unknown
  gravitasTestProfileName?: unknown
  version?: unknown
}

export function getPackagedTestProfileName(metadata: unknown): string {
  if (typeof metadata !== 'object' || metadata === null) return 'Gravitas Owner Test'
  const name = (metadata as TestBuildPackageMetadata).gravitasTestProfileName
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9 -]{0,63}$/.test(name) ? name : 'Gravitas Owner Test'
}

/** 只有带有包内构建标记的已打包测试版才使用独立配置目录。 */
export function getPackagedTestConfigDir(
  isPackaged: boolean,
  metadata: unknown,
  appDataPath: string,
  testConfigOverride?: string,
  allowTestOverride = false,
): string | undefined {
  if (!isPackaged || typeof metadata !== 'object' || metadata === null
    || (metadata as TestBuildPackageMetadata).gravitasTestBuild !== true) return undefined
  if (allowTestOverride && testConfigOverride && isAbsolute(testConfigOverride)) return resolve(testConfigOverride)
  const packageVersion = (metadata as TestBuildPackageMetadata).version
  const profileName = getPackagedTestProfileName(metadata)
  const versionedProfileName = typeof packageVersion === 'string' && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(packageVersion)
    ? `${profileName} ${packageVersion}`
    : profileName
  return join(appDataPath, versionedProfileName, 'owner-config')
}
