import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/physics/**/*.test.ts', 'src/maneuvers/**/*.test.ts', 'src/sensors/**/*.test.ts'],
  },
});
