import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// jsdom 未实现 scrollIntoView
Element.prototype.scrollIntoView = () => {}

afterEach(() => cleanup())
