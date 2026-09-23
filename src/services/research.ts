import { useSyncExternalStore } from 'react'
import type { AssistantMessage, Document, Passage, Session } from '@/types'
import { DEMO_NOTICE, demoSessions, documents, passages, sampleQuestions } from '@/mocks/demo-data'
import { fetchDemoAnswer } from '@/mocks/demo-api'

/**
 * UI 唯一的数据访问入口。当前阶段会话与消息只存内存，不做持久化。
 * 接入真实后端时以替换 fetchDemoAnswer 与文献/片段查询为主；getPassage/getDocument 目前同步读取，
 * 改为网络请求后，调用处需补加载与失败状态。
 */

export { DEMO_NOTICE, sampleQuestions }

let sessions: Session[] = demoSessions
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function updateSession(id: string, patch: (s: Session) => Session) {
  sessions = sessions.map((s) => (s.id === id ? patch(s) : s))
  emit()
}

function updateMessage(sessionId: string, messageId: string, patch: Partial<AssistantMessage>) {
  updateSession(sessionId, (s) => ({
    ...s,
    messages: s.messages.map((m) =>
      m.id === messageId && m.role === 'assistant' ? { ...m, ...patch } : m,
    ),
  }))
}

let seq = 0
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++seq}`

export function getSessions(): Session[] {
  return sessions
}

export function useSessions(): Session[] {
  return useSyncExternalStore(subscribe, getSessions)
}

export function createSession(): Session {
  const session: Session = {
    id: nextId('s'),
    title: '新研究',
    messages: [],
  }
  sessions = [session, ...sessions]
  emit()
  return session
}

async function runAnswer(sessionId: string, messageId: string, question: string) {
  updateMessage(sessionId, messageId, { status: 'loading' })
  try {
    const answer = await fetchDemoAnswer(question)
    updateMessage(sessionId, messageId, {
      status: answer.text ? 'done' : 'empty',
      text: answer.text,
      citations: answer.citations,
    })
  } catch (e) {
    updateMessage(sessionId, messageId, {
      status: 'error',
      error: (e as Error).message,
    })
  }
}

/** 追加用户问题并发起回答（输入区已去除首尾空白并拦下空问题） */
export function askQuestion(sessionId: string, question: string) {
  const assistant: AssistantMessage = {
    id: nextId('m'),
    role: 'assistant',
    status: 'loading',
    question,
    text: '',
    citations: [],
  }
  updateSession(sessionId, (s) => ({
    ...s,
    title: s.messages.length === 0 ? question : s.title,
    messages: [...s.messages, { id: nextId('m'), role: 'user', text: question }, assistant],
  }))
  void runAnswer(sessionId, assistant.id, question)
}

export function retryAnswer(sessionId: string, message: AssistantMessage) {
  void runAnswer(sessionId, message.id, message.question)
}

// 演示数据里每个引用都能找到片段与文献，由 research.test.ts 保证
export function getPassage(passageId: string): Passage {
  return passages.find((p) => p.id === passageId)!
}

export function getDocument(documentId: string): Document {
  return documents.find((d) => d.id === documentId)!
}

/** 仅供测试重置内存状态 */
export function resetSessionsForTest() {
  sessions = demoSessions
  emit()
}
