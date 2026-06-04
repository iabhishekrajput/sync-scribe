import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'
 
const eslintConfig = defineConfig([
  ...nextVitals,
  // eslint-plugin-react@7.37.5 auto-detect calls context.getFilename(), removed
  // in ESLint 10. Pinning the version skips the detection path entirely.
  { settings: { react: { version: '19' } } },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    // ESLint 10 + next's bundled babel-eslint parser: scope manager misses
    // addGlobals(). TS files use @typescript-eslint/parser and are fine.
    '*.config.mjs',
    '*.config.js',
  ]),
])
 
export default eslintConfig
