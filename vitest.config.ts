import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    // Tests are pure logic (config, workspace, registry, CLI parsing);
    // no browser or DOM environment is needed.
  },
})
