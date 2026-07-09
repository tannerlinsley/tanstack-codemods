import { chat } from '@tanstack/ai'
import { openaiText as createOpenAI } from '@tanstack/ai-openai'

export function run(messages: Array<unknown>) {
  return chat({
    adapter: createOpenAI('gpt-4o'),
    messages,
    temperature: 0.3,
    maxTokens: 100,
  })
}
