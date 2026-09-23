import type { AnswerPayload, Document, Passage, Session } from '@/types'

/**
 * 演示数据：全部为明确虚构的中性占位内容，不对应任何真实政策条文或研究结论。
 * 页面不得直接导入本文件，统一通过 services/research.ts 访问。
 */

/** 演示模式的界面标注文案 */
export const DEMO_NOTICE = '演示模式 / 非真实检索结果'

export const documents: Document[] = [
  {
    id: 'doc-a',
    title: '示例文件 A：区域公共服务协同供给指导意见（虚构演示文本）',
    source: '虚构演示样本，非真实文件',
  },
  {
    id: 'doc-b',
    title: '示例文件 B：基层治理数字化试点工作方案（虚构演示文本）',
    source: '虚构演示样本，非真实文件',
  },
]

export const passages: Passage[] = [
  {
    id: 'p-a-1',
    documentId: 'doc-a',
    section: '第二章 总体要求',
    index: 3,
    text: '【演示文本】本段为虚构占位内容。示例文件 A 将“协同供给”表述为区域内多个主体之间的分工与衔接机制，强调由牵头单位统筹、相关单位配合。本段仅用于演示引用定位。',
    highlight: '区域内多个主体之间的分工与衔接机制',
  },
  {
    id: 'p-a-2',
    documentId: 'doc-a',
    section: '第四章 组织实施',
    index: 11,
    text: '【演示文本】本段为虚构占位内容。示例文件 A 规定基层执行主体负责需求汇总与情况反馈，不承担资源统筹职责。本段仅用于演示引用定位。',
    highlight: '负责需求汇总与情况反馈',
  },
  {
    id: 'p-a-3',
    documentId: 'doc-a',
    section: '第五章 保障措施',
    index: 15,
    text: '【演示文本】本段为虚构占位内容。示例文件 A 提出建立定期会商机制，用于协调跨主体事项。本段仅用于演示引用定位。',
    highlight: '建立定期会商机制',
  },
  {
    id: 'p-b-1',
    documentId: 'doc-b',
    section: '第一章 试点目标',
    index: 2,
    text: '【演示文本】本段为虚构占位内容。示例文件 B 将“协同”表述为平台化的数据共享与流程联动，侧重技术手段而非组织分工。本段仅用于演示引用定位。',
    highlight: '平台化的数据共享与流程联动',
  },
  {
    id: 'p-b-2',
    documentId: 'doc-b',
    section: '第三章 实施步骤',
    index: 7,
    text: '【演示文本】本段为虚构占位内容。示例文件 B 将试点划分为准备、试运行、评估推广三个阶段，每个阶段设有阶段性检查点。本段仅用于演示引用定位。',
    highlight: '准备、试运行、评估推广三个阶段',
  },
  {
    id: 'p-b-3',
    documentId: 'doc-b',
    section: '第四章 职责分工',
    index: 9,
    text: '【演示文本】本段为虚构占位内容。示例文件 B 要求基层执行主体直接负责平台数据的录入与维护，并对数据质量负责。本段仅用于演示引用定位。',
    highlight: '直接负责平台数据的录入与维护',
  },
]

export const sampleQuestions = [
  '示例文件 A 与示例文件 B 在“协同”机制上的表述有何差异？',
  '示例文件 B 中试点工作划分为哪些阶段？',
  '两份示例文件对基层执行主体的职责如何界定？',
]

/** 预设回答，按示例问题对应；其他问题返回通用演示回答 */
export const presetAnswers: Record<string, AnswerPayload> = {
  [sampleQuestions[0]]: {
    text: '（演示回答）两份示例文件对“协同”的表述侧重不同。示例文件 A 把协同理解为多个主体之间的组织分工与衔接[1]，并以定期会商作为协调手段[2]；示例文件 B 则把协同落在平台化的数据共享与流程联动上，更强调技术路径[3]。',
    citations: [
      { id: 'c-1', marker: 1, passageId: 'p-a-1' },
      { id: 'c-2', marker: 2, passageId: 'p-a-3' },
      { id: 'c-3', marker: 3, passageId: 'p-b-1' },
    ],
  },
  [sampleQuestions[1]]: {
    text: '（演示回答）示例文件 B 将试点划分为准备、试运行、评估推广三个阶段，并为每个阶段设置检查点[1]。',
    citations: [{ id: 'c-1', marker: 1, passageId: 'p-b-2' }],
  },
  [sampleQuestions[2]]: {
    text: '（演示回答）示例文件 A 将基层执行主体的职责限定为需求汇总与情况反馈[1]；示例文件 B 则要求其直接承担平台数据的录入、维护与质量责任[2]。两者在职责范围上存在明显差别。',
    citations: [
      { id: 'c-1', marker: 1, passageId: 'p-a-2' },
      { id: 'c-2', marker: 2, passageId: 'p-b-3' },
    ],
  },
}

export const genericAnswer: AnswerPayload = {
  text: '（演示回答）当前为演示模式，尚未接入真实检索与模型。以下引用来自虚构示例文件，用于演示引用与原文定位的交互[1][2]。',
  citations: [
    { id: 'c-1', marker: 1, passageId: 'p-a-1' },
    { id: 'c-2', marker: 2, passageId: 'p-b-1' },
  ],
}

export const demoSessions: Session[] = [
  {
    id: 's-demo-1',
    title: '协同机制表述比较（演示）',
    messages: [
      { id: 'm-1', role: 'user', text: sampleQuestions[0] },
      {
        id: 'm-2',
        role: 'assistant',
        status: 'done',
        question: sampleQuestions[0],
        ...presetAnswers[sampleQuestions[0]],
      },
    ],
  },
  {
    id: 's-demo-2',
    title: '基层执行主体职责界定：一个用于检查中文长标题截断效果的演示会话',
    messages: [
      { id: 'm-1', role: 'user', text: sampleQuestions[2] },
      {
        id: 'm-2',
        role: 'assistant',
        status: 'done',
        question: sampleQuestions[2],
        ...presetAnswers[sampleQuestions[2]],
      },
    ],
  },
]
