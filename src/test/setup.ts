import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// jsdom 未实现 scrollIntoView / scrollTo
Element.prototype.scrollIntoView = () => {}
Element.prototype.scrollTo = () => {}
// jsdom 未实现对象 URL
URL.createObjectURL = () => 'blob:test'
URL.revokeObjectURL = () => {}

afterEach(() => cleanup())
