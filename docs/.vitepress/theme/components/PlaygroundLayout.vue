<script setup lang="ts">
import type { Delimiter } from '../../../../packages/toon/src'
import { useClipboard, useDebounceFn } from '@vueuse/core'
import { unzlibSync, zlibSync } from 'fflate'
import { base64ToUint8Array, stringToUint8Array, uint8ArrayToBase64, uint8ArrayToString } from 'uint8array-extras'
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { DEFAULT_DELIMITER, encode } from '../../../../packages/toon/src'
import VPInput from './VPInput.vue'

// Types
interface PlaygroundState {
  json: string
  delimiter: Delimiter
  indent: number
}

type PlusOrMinus = '+' | '-'

type CalculatedSavings = {
  diff: number
  percent: string
  sign: PlusOrMinus
  isSavings: boolean
} | undefined

interface BaseFormat {
  id: 'json' | 'yaml' | 'csv' | 'toon'
  title: string
  editable: boolean
  output: string
  tokens?: number
}

interface SavingsFormat extends BaseFormat {
  id: 'yaml' | 'csv' | 'toon'
  savings: CalculatedSavings
}

interface JsonFormat extends BaseFormat {
  id: 'json'
  savings?: undefined
}

type Format = JsonFormat | SavingsFormat

// Constants
const PRESETS = {
  hikes: {
    context: {
      task: 'Our favorite hikes together',
      location: 'Boulder',
      season: 'spring_2025',
    },
    friends: ['ana', 'luis', 'sam'],
    hikes: [
      { id: 1, name: 'Blue Lake Trail', distanceKm: 7.5, elevationGain: 320, companion: 'ana', wasSunny: true },
      { id: 2, name: 'Ridge Overlook', distanceKm: 9.2, elevationGain: 540, companion: 'luis', wasSunny: false },
      { id: 3, name: 'Wildflower Loop', distanceKm: 5.1, elevationGain: 180, companion: 'sam', wasSunny: true },
    ],
  },
  orders: {
    orders: [
      {
        orderId: 'ORD-001',
        customer: { name: 'Alice Chen', email: 'alice@example.com' },
        items: [
          { sku: 'WIDGET-A', quantity: 2, price: 29.99 },
          { sku: 'GADGET-B', quantity: 1, price: 49.99 },
        ],
        total: 109.97,
        status: 'shipped',
      },
      {
        orderId: 'ORD-002',
        customer: { name: 'Bob Smith', email: 'bob@example.com' },
        items: [
          { sku: 'THING-C', quantity: 3, price: 15.00 },
        ],
        total: 45.00,
        status: 'delivered',
      },
    ],
  },
  metrics: {
    metrics: [
      { date: '2025-01-01', views: 5200, clicks: 180, conversions: 24, revenue: 2890.50 },
      { date: '2025-01-02', views: 6100, clicks: 220, conversions: 31, revenue: 3450.00 },
      { date: '2025-01-03', views: 4800, clicks: 165, conversions: 19, revenue: 2100.25 },
      { date: '2025-01-04', views: 5900, clicks: 205, conversions: 28, revenue: 3200.00 },
    ],
  },
  events: {
    logs: [
      { timestamp: '2025-01-15T10:23:45Z', level: 'info', endpoint: '/api/users', statusCode: 200, responseTime: 45 },
      { timestamp: '2025-01-15T10:24:12Z', level: 'error', endpoint: '/api/orders', statusCode: 500, responseTime: 120, error: { message: 'Database timeout', retryable: true } },
      { timestamp: '2025-01-15T10:25:03Z', level: 'info', endpoint: '/api/products', statusCode: 200, responseTime: 32 },
      { timestamp: '2025-01-15T10:26:47Z', level: 'warn', endpoint: '/api/payment', statusCode: 429, responseTime: 5, error: { message: 'Rate limit exceeded', retryable: true } },
    ],
  },
} as const

const DELIMITER_OPTIONS: { value: Delimiter, label: string }[] = [
  { value: ',', label: 'Comma (,)' },
  { value: '\t', label: 'Tab (\\t)' },
  { value: '|', label: 'Pipe (|)' },
]

const DEFAULT_JSON = JSON.stringify(PRESETS.hikes, undefined, 2)

// State
const jsonInput = ref(DEFAULT_JSON)
const yamlInput = ref('')
const csvInput = ref('')
const delimiter = ref<Delimiter>(DEFAULT_DELIMITER)
const indent = ref(2)
const hasCopiedUrl = ref(false)
const activeEditor = ref<'json' | 'yaml' | 'csv'>('json')

// Lazy loaded libraries
const tokenizer = shallowRef<typeof import('gpt-tokenizer')>()
const yaml = shallowRef<typeof import('yaml')>()
const papa = shallowRef<typeof import('papaparse')>()

// Computed
const parsedJson = computed(() => {
  try {
    return { data: JSON.parse(jsonInput.value), error: null }
  }
  catch (e) {
    return { data: null, error: e instanceof Error ? e.message : 'Invalid JSON' }
  }
})

const toonOutput = computed(() => {
  if (parsedJson.value.error)
    return ''
  try {
    return encode(parsedJson.value.data, {
      indent: indent.value,
      delimiter: delimiter.value,
    })
  }
  catch {
    return ''
  }
})

const yamlOutput = computed(() => {
  if (!yaml.value || parsedJson.value.error)
    return ''
  try {
    return yaml.value.stringify(parsedJson.value.data, { indent: indent.value })
  }
  catch {
    return ''
  }
})

const csvOutput = computed(() => {
  if (!papa.value || parsedJson.value.error)
    return ''
  try {
    const array = Array.isArray(parsedJson.value.data)
      ? parsedJson.value.data
      : [parsedJson.value.data]
    return papa.value.unparse(array)
  }
  catch {
    return ''
  }
})

function calculateTokens(text: string) {
  return tokenizer.value?.encode(text).length
}

const jsonTokens = computed(() => calculateTokens(jsonInput.value))
const yamlTokens = computed(() => yamlOutput.value ? calculateTokens(yamlOutput.value) : undefined)
const csvTokens = computed(() => csvOutput.value ? calculateTokens(csvOutput.value) : undefined)
const toonTokens = computed(() => toonOutput.value ? calculateTokens(toonOutput.value) : undefined)

function calculateSavings(baseTokens?: number, compareTokens?: number) {
  if (!baseTokens || !compareTokens)
    return undefined

  const diff = baseTokens - compareTokens
  const percent = Math.abs((diff / baseTokens) * 100).toFixed(1)
  const sign: PlusOrMinus = diff > 0 ? '-' : '+'

  return { diff, percent, sign, isSavings: diff > 0 }
}

const formats = computed((): Format[] => [
  {
    id: 'json',
    title: 'JSON Input',
    editable: true,
    output: jsonInput.value,
    tokens: jsonTokens.value,
  },
  {
    id: 'toon',
    title: 'TOON Output',
    editable: false,
    output: toonOutput.value,
    tokens: toonTokens.value,
    savings: calculateSavings(jsonTokens.value, toonTokens.value),
  },
  {
    id: 'yaml',
    title: 'YAML',
    editable: true,
    output: yamlOutput.value,
    tokens: yamlTokens.value,
    savings: calculateSavings(jsonTokens.value, yamlTokens.value),
  },
  {
    id: 'csv',
    title: 'CSV',
    editable: true,
    output: csvOutput.value,
    tokens: csvTokens.value,
    savings: calculateSavings(jsonTokens.value, csvTokens.value),
  },
])

// Clipboard hooks
const clipboardHooks = {
  toon: useClipboard({ source: toonOutput }),
  yaml: useClipboard({ source: yamlOutput }),
  csv: useClipboard({ source: csvOutput }),
}

// Methods
const parseInput = {
  yaml: (value: string) => {
    if (!yaml.value)
      return
    try {
      const parsed = yaml.value.parse(value)
      jsonInput.value = JSON.stringify(parsed, undefined, 2)
    }
    catch {}
  },
  csv: (value: string) => {
    if (!papa.value)
      return
    try {
      const result = papa.value.parse(value, {
        header: true,
        dynamicTyping: true,
      })
      if (result.data) {
        jsonInput.value = JSON.stringify(result.data, undefined, 2)
      }
    }
    catch {}
  },
}

function syncOutputs() {
  if (activeEditor.value !== 'json' || parsedJson.value.error)
    return

  if (yaml.value) {
    yamlInput.value = yaml.value.stringify(parsedJson.value.data, {
      indent: indent.value,
    })
  }

  if (papa.value) {
    const array = Array.isArray(parsedJson.value.data)
      ? parsedJson.value.data
      : [parsedJson.value.data]
    csvInput.value = papa.value.unparse(array)
  }
}

function encodeState(): string {
  const state: PlaygroundState = {
    json: jsonInput.value,
    delimiter: delimiter.value,
    indent: indent.value,
  }
  const compressed = zlibSync(stringToUint8Array(JSON.stringify(state)))
  return uint8ArrayToBase64(compressed, { urlSafe: true })
}

function decodeState(hash: string): PlaygroundState | undefined {
  try {
    const bytes = base64ToUint8Array(hash)
    const decompressed = unzlibSync(bytes)
    const decoded = uint8ArrayToString(decompressed)
    return decoded ? JSON.parse(decoded) : undefined
  }
  catch {
    return undefined
  }
}

const updateUrl = useDebounceFn(() => {
  if (typeof window === 'undefined')
    return
  window.history.replaceState(null, '', `#${encodeState()}`)
}, 300)

async function copyShareUrl() {
  await navigator.clipboard.writeText(window.location.href)
  hasCopiedUrl.value = true
  setTimeout(() => (hasCopiedUrl.value = false), 2000)
}

function loadPreset(name: keyof typeof PRESETS) {
  activeEditor.value = 'json'
  jsonInput.value = JSON.stringify(PRESETS[name], undefined, 2)
}

async function loadLibraries() {
  tokenizer.value = await import('gpt-tokenizer')
  yaml.value = await import('yaml')
  papa.value = await import('papaparse')
  syncOutputs()
}

function restoreState() {
  const hash = window.location.hash.slice(1)
  if (!hash)
    return

  const state = decodeState(hash)
  if (state) {
    jsonInput.value = state.json
    delimiter.value = state.delimiter
    indent.value = state.indent
  }
}

function updateEditorInput(formatId: string, value: string) {
  if (formatId === 'json') {
    jsonInput.value = value
  }
  else if (formatId === 'yaml') {
    yamlInput.value = value
  }
  else if (formatId === 'csv') {
    csvInput.value = value
  }
}

function handleEditorFocus(formatId: string) {
  if (formatId === 'json' || formatId === 'yaml' || formatId === 'csv') {
    activeEditor.value = formatId
  }
}

// Watchers
watch([jsonInput, delimiter, indent], updateUrl)
watch(jsonInput, syncOutputs)
watch(yamlInput, () => activeEditor.value === 'yaml' && parseInput.yaml(yamlInput.value))
watch(csvInput, () => activeEditor.value === 'csv' && parseInput.csv(csvInput.value))

// Lifecycle
onMounted(() => {
  loadLibraries()
  restoreState()
})
</script>

<template>
  <div class="playground">
    <div class="playground-container">
      <!-- Header -->
      <header class="playground-header">
        <h1>Playground</h1>
        <p>Experiment with JSON, YAML, CSV and TOON encoding in real-time.</p>
      </header>

      <!-- Options Bar -->
      <div class="options-bar">
        <VPInput id="delimiter" label="Delimiter">
          <select id="delimiter" v-model="delimiter">
            <option
              v-for="opt in DELIMITER_OPTIONS"
              :key="opt.value"
              :value="opt.value"
            >
              {{ opt.label }}
            </option>
          </select>
        </VPInput>

        <VPInput id="indent" label="Indent">
          <input
            id="indent"
            v-model.number="indent"
            type="number"
            min="0"
            max="8"
          >
        </VPInput>

        <VPInput id="preset" label="Preset">
          <select
            id="preset"
            @change="(e) => loadPreset((e.target as HTMLSelectElement).value as keyof typeof PRESETS)"
          >
            <option value="" disabled selected>
              Load example...
            </option>
            <option
              v-for="(_, key) in PRESETS"
              :key="key"
              :value="key"
            >
              {{ key.charAt(0).toUpperCase() + key.slice(1) }}
            </option>
          </select>
        </VPInput>

        <button
          class="share-button"
          :class="[hasCopiedUrl && 'copied']"
          :aria-label="hasCopiedUrl ? 'Link copied!' : 'Copy shareable URL'"
          @click="copyShareUrl"
        >
          <span class="icon" :class="[hasCopiedUrl && 'check']" aria-hidden="true" />
          {{ hasCopiedUrl ? 'Copied!' : 'Share' }}
        </button>
      </div>

      <!-- Editor Container -->
      <div class="editor-container">
        <div
          v-for="format in formats"
          :key="format.id"
          class="editor-pane"
        >
          <div class="pane-header">
            <span class="pane-title">
              {{ format.title }}
              <span v-if="format.savings" class="savings-badge" :class="[!format.savings.isSavings && 'increase']">
                {{ format.savings.sign }}{{ format.savings.percent }}%
              </span>
            </span>
            <span class="pane-stats">
              <span>{{ format.tokens ?? '...' }} tokens</span>
              <span>{{ format.output.length }} chars</span>
            </span>
          </div>

          <div v-if="format.editable" class="editor-content">
            <textarea
              :value="format.output"
              class="editor-textarea"
              spellcheck="false"
              :aria-label="`${format.title} input`"
              :aria-invalid="format.id === 'json' && !!parsedJson.error"
              :placeholder="`Enter ${format.title} here...`"
              @input="updateEditorInput(format.id, ($event.target as HTMLTextAreaElement).value)"
              @focus="handleEditorFocus(format.id)"
            />
            <div
              v-if="format.id === 'json' && parsedJson.error"
              class="error-message"
              role="alert"
            >
              {{ parsedJson.error }}
            </div>
          </div>

          <div v-else class="editor-output">
            <button
              v-if="format.id !== 'json'"
              class="copy-button"
              :class="{ copied: clipboardHooks[format.id as keyof typeof clipboardHooks]?.copied.value }"
              :disabled="!!parsedJson.error || !format.output"
              @click="clipboardHooks[format.id as keyof typeof clipboardHooks]?.copy()"
            />
            <pre v-if="!parsedJson.error"><code>{{ format.output }}</code></pre>
            <div v-else class="error-message" role="alert">
              {{ parsedJson.error }}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.playground {
  padding: 32px 24px 96px;
  min-height: 100vh;
  background: var(--vp-c-bg);

  @media (min-width: 768px) {
    padding: 48px 32px 128px;
  }

  @media (min-width: 960px) {
    padding: 48px 32px 0;
  }
}

.playground-container {
  max-width: 1400px;
  margin: 0 auto;
}

.playground-header {
  margin-bottom: 24px;

  h1 {
    font-size: 28px;
    font-weight: 600;
    letter-spacing: -0.02em;
    line-height: 40px;
    color: var(--vp-c-text-1);
    margin: 0 0 8px;

    @media (min-width: 768px) {
      font-size: 32px;
    }
  }

  p {
    font-size: 16px;
    line-height: 28px;
    color: var(--vp-c-text-2);
  }
}

.options-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: flex-end;
  margin-bottom: 16px;
  padding: 12px 16px;
  background: var(--vp-c-bg-soft);
  border-radius: 8px;
  border: 1px solid var(--vp-c-divider);
}

.share-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 12px;
  height: 32px;
  font-size: 13px;
  font-weight: 500;
  color: var(--vp-c-text-1);
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-border);
  border-radius: 6px;
  transition: border-color 0.25s, color 0.25s;
  margin-left: auto;

  &:hover {
    border-color: var(--vp-c-brand-1);
    color: var(--vp-c-brand-1);
  }

  &:focus-visible {
    outline: 2px solid var(--vp-c-brand-1);
    outline-offset: 2px;
  }

  &.copied {
    border-color: var(--vp-c-green-1);
    color: var(--vp-c-green-1);
  }

  .icon {
    --icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' stroke='currentColor' stroke-linecap='round' stroke-linejoin='round' stroke-width='2' viewBox='0 0 24 24'%3E%3Cpath d='M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71'/%3E%3Cpath d='M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'/%3E%3C/svg%3E");
    display: inline-block;
    width: 1em;
    height: 1em;
    mask: var(--icon) no-repeat;
    mask-size: 100% 100%;
    background-color: currentColor;

    &.check {
      --icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' stroke='currentColor' stroke-linecap='round' stroke-linejoin='round' stroke-width='2' viewBox='0 0 24 24'%3E%3Cpath d='M20 6 9 17l-5-5'/%3E%3C/svg%3E");
    }
  }
}

.editor-container {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
  min-height: 500px;

  @media (max-width: 768px) {
    grid-template-columns: 1fr;
  }
}

.editor-pane {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  overflow: hidden;
  background: var(--vp-c-bg-soft);
  transition: border-color 0.25s;

  &:focus-within {
    border-color: var(--vp-c-brand-1);
  }
}

.pane-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: var(--vp-c-bg-alt);
  border-bottom: 1px solid var(--vp-c-divider);
}

.pane-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--vp-c-text-2);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  line-height: 1.5;
}

.pane-stats {
  display: flex;
  gap: 12px;
  margin-left: auto;
  font-size: 0.75rem;
  font-weight: 400;
  color: var(--vp-c-text-2);
  text-transform: none;
  letter-spacing: normal;
}

.savings-badge {
  display: inline-flex;
  padding: 2px 6px;
  font-size: 0.625rem;
  font-weight: 600;
  color: var(--vp-c-green-1);
  background: var(--vp-c-green-soft);
  border-radius: 4px;
  text-transform: none;
  letter-spacing: normal;

  &.increase {
  color: var(--vp-c-yellow-1);
  background: var(--vp-c-yellow-soft);
}

}

.editor-content,
.editor-output {
  position: relative;
  flex: 1;
  font-family: var(--vp-font-family-mono);
  font-size: 0.875rem;
  line-height: 1.7;
}

.editor-content {
  display: flex;
  flex-direction: column;
}

.editor-textarea {
  flex: 1;
  resize: none;
  padding: 16px;
  color: var(--vp-c-text-1);
  background: var(--vp-c-bg);
  border: none;
  outline: none;
}

.editor-output {
  overflow: auto;
  background: var(--vp-code-block-bg);

  pre {
    margin: 0;
    padding: 16px;
    white-space: pre-wrap;
    word-break: break-all;
  }
}

.copy-button {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 3;
  width: 40px;
  height: 40px;
  border: 1px solid var(--vp-code-copy-code-border-color);
  border-radius: 4px;
  background-color: var(--vp-code-copy-code-bg);
  background-image: var(--vp-icon-copy);
  background-position: 50%;
  background-size: 20px;
  background-repeat: no-repeat;
  opacity: 0;
  cursor: pointer;
  transition: border-color 0.25s, background-color 0.25s, opacity 0.25s;

  &:hover:not(:disabled),
  &.copied {
    border-color: var(--vp-code-copy-code-hover-border-color);
    background-color: var(--vp-code-copy-code-hover-bg);
  }

  &:focus-visible {
    outline: 2px solid var(--vp-c-brand-1);
    outline-offset: 2px;
  }

  &:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  &.copied {
    border-radius: 0 4px 4px 0;
    background-image: var(--vp-icon-copied);

    &::before {
      content: var(--vp-code-copy-copied-text-content);
      position: relative;
      top: -1px;
      display: flex;
      justify-content: center;
      align-items: center;
      width: fit-content;
      height: 40px;
      padding: 0 10px;
      transform: translateX(calc(-100% - 1px));
      border: 1px solid var(--vp-code-copy-code-hover-border-color);
      border-right: 0;
      border-radius: 4px 0 0 4px;
      background-color: var(--vp-code-copy-code-hover-bg);
      color: var(--vp-code-copy-code-active-text);
      font-size: 12px;
      font-weight: 500;
      white-space: nowrap;
      text-align: center;
    }
  }
}

.editor-output:hover .copy-button,
.copy-button:focus {
  opacity: 1;
}

.error-message {
  padding: 8px 12px;
  margin: 16px;
  color: var(--vp-c-danger-1);
  background: var(--vp-c-danger-soft);
  border-radius: 4px;
  font-size: 0.875rem;
  font-family: var(--vp-font-family-base);
}
</style>
