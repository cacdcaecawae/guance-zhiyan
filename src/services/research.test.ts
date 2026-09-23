import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { demoSessions, genericAnswer, presetAnswers } from '@/mocks/demo-data'
import {
  askQuestion,
  createSession,
  getDocument,
  getPassage,
  getSessions,
  resetSessionsForTest,
  retryAnswer,
  sampleQuestions,
} from './research'

function session(id: string) {
  return getSessions().find((s) => s.id === id)!
}

function assistant(sessionId: string) {
  const msgs = session(sessionId).messages
  const last = msgs[msgs.length - 1]
  if (last.role !== 'assistant') throw new Error('最后一条不是回答')
  return last
}

describe('引用到片段的映射', () => {
  it('所有预设回答的引用都能定位到存在的片段与文献', () => {
    const answers = [...Object.values(presetAnswers), genericAnswer]
    expect(answers.length).toBeGreaterThan(0)
    for (const a of answers) {
      for (const c of a.citations) {
        const passage = getPassage(c.passageId)
        expect(passage, `引用 ${c.id} 对应片段缺失`).toBeDefined()
        expect(getDocument(passage.documentId)).toBeDefined()
        expect(passage.text).toContain(passage.highlight)
      }
      const markers = [...a.text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]))
      expect(new Set(markers)).toEqual(new Set(a.citations.map((c) => c.marker)))
    }
  })
})

describe('askQuestion', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetSessionsForTest()
  })
  afterEach(() => vi.useRealTimers())

  it('示例问题：先加载，再返回带引用的预设回答，并以问题作为会话标题', async () => {
    const s = createSession()
    askQuestion(s.id, sampleQuestions[1])
    expect(assistant(s.id).status).toBe('loading')
    expect(session(s.id).title).toBe(sampleQuestions[1])

    await vi.runAllTimersAsync()
    const a = assistant(s.id)
    expect(a.status).toBe('done')
    expect(a.citations).toEqual(presetAnswers[sampleQuestions[1]].citations)
  })

  it('其他问题返回通用演示回答，包括 constructor 这类对象自带的属性名', async () => {
    const s = createSession()
    askQuestion(s.id, 'constructor')
    await vi.runAllTimersAsync()
    expect(assistant(s.id).status).toBe('done')
    expect(assistant(s.id).citations).toEqual(genericAnswer.citations)
  })

  it('“演示空结果”返回空内容状态', async () => {
    const s = createSession()
    askQuestion(s.id, '演示空结果')
    await vi.runAllTimersAsync()
    expect(assistant(s.id).status).toBe('empty')
  })

  it('“演示失败”进入失败状态，重试会重新加载', async () => {
    const s = createSession()
    askQuestion(s.id, '演示失败')
    await vi.runAllTimersAsync()
    const failed = assistant(s.id)
    expect(failed.status).toBe('error')
    expect(failed.error).toContain('演示')

    retryAnswer(s.id, failed)
    expect(assistant(s.id).status).toBe('loading')
    await vi.runAllTimersAsync()
    expect(assistant(s.id).status).toBe('error')
  })

  it('演示会话不受新会话影响', () => {
    createSession()
    expect(session(demoSessions[0].id).messages).toEqual(demoSessions[0].messages)
  })
})
