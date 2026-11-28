import { mock } from 'bun:test'

mock.module('../project-owner-host-resources', () => ({
  readOwnerHostCpu: () => ({ idle: 0, total: 0 }),
  readOwnerHostAvailableMemory: async () => 4 * 1024 ** 3,
  readOwnerHostTotalMemory: () => 8 * 1024 ** 3,
}))
