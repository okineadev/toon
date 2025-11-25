// @ts-check
import antfu from '@antfu/eslint-config'

export default antfu({
  rules: {
    'no-cond-assign': 'off',
  },
}).append({
  files: ['packages/toon/README.md', 'SPEC.md', '**/docs/**/*'],
  rules: {
    'import/no-duplicates': 'off',
    'style/no-tabs': 'off',
    'yaml/quotes': 'off',
  },
})
