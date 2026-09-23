import type { AnswerPayload } from '@/types'
import { genericAnswer, presetAnswers } from './demo-data'

/**
 * 模拟的数据请求：只模拟“向后端要一个回答”的延迟与失败，不伪装 Agent 执行过程。
 * 可复现场景：问题含“演示失败”→ 请求失败；含“演示空结果”→ 返回空回答。
 */

const EMPTY_TRIGGER = '演示空结果'
const ERROR_TRIGGER = '演示失败'

export function fetchDemoAnswer(question: string): Promise<AnswerPayload> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (question.includes(ERROR_TRIGGER)) {
        reject(new Error('演示：模拟数据请求失败（非真实检索）'))
        return
      }
      if (question.includes(EMPTY_TRIGGER)) {
        resolve({ text: '', citations: [] })
        return
      }
      resolve(Object.hasOwn(presetAnswers, question) ? presetAnswers[question] : genericAnswer)
    }, 900)
  })
}
