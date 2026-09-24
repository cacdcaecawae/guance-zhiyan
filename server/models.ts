import { randomUUID } from 'node:crypto'
import {
  DeepSeekAdapter,
  resolveAdapterOptions,
  type DeepSeekAdapterOptions,
} from '@deepseek-ai/dsh-llm-deepseek'
import type { ModelCatalog, ModelSelection } from '../src/types/index.ts'
import { HttpError } from './store.ts'

const providers = [
  {
    id: 'deepseek-official',
    name: 'DeepSeek 官方',
    key: 'DEEPSEEK_API_KEY',
    baseEnv: 'DEEPSEEK_BASE_URL',
    base: 'https://api.deepseek.com/anthropic',
    models: [
      { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    ],
  },
  {
    id: 'qianwen',
    name: '千问 AI 平台',
    key: 'QIANWEN_API_KEY',
    baseEnv: 'QIANWEN_BASE_URL',
    base: 'https://maas.qianwenaiapi.com/apps/anthropic',
    models: [
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
      { id: 'deepseek-v4-pro-0813', name: 'DeepSeek V4 Pro（0813）' },
    ],
  },
]
export const defaultSelection: ModelSelection = {
  provider: 'deepseek-official',
  model: 'deepseek-flash',
}
export function modelCatalog(testAdapter = false): ModelCatalog {
  return {
    providers: providers.map(({ id, name, key, models }) => ({
      id,
      name,
      models,
      configured: testAdapter || !!process.env[key]?.trim(),
    })),
    defaultSelection,
  }
}
export function validateSelection(value: unknown): ModelSelection {
  if (value && typeof value === 'object' && 'provider' in value && 'model' in value) {
    const provider = providers.find((item) => item.id === value.provider)
    if (provider?.models.some((model) => model.id === value.model))
      return { provider: provider.id, model: value.model as string }
  }
  throw new HttpError(400, '请选择支持的供应商和 DeepSeek 模型。')
}
export function connection(selection: ModelSelection) {
  const provider = providers.find((item) => item.id === selection.provider)!
  return {
    ...provider,
    baseURL: (process.env[provider.baseEnv]?.trim() || provider.base).replace(/\/$/, ''),
    apiKey: process.env[provider.key]?.trim(),
  }
}
export function modelAdapter(provider: string) {
  const anonymous = randomUUID() as ReturnType<DeepSeekAdapterOptions['resolveUserId']>
  return new DeepSeekAdapter({
    options: () => {
      const config = connection({ provider, model: '' })
      return resolveAdapterOptions({
        apiKeyEnv: config.key,
        baseURL: config.baseURL,
        thinking: 'enabled',
        reasoningEffort: 'high',
        maxTokens: 8192,
        streamIdleTimeoutMs: 60000,
      })
    },
    resolveApiKey: async (config) => {
      const key = process.env[config.apiKeyEnv]?.trim()
      if (!key) throw new Error('供应商密钥尚未配置。')
      return key
    },
    resolveUserId: () => anonymous,
    prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
  })
}
