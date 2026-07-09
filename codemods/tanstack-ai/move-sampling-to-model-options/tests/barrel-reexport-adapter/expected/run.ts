import { chat } from '@tanstack/ai'
import { createOpenAI } from './adapters'

export function run(messages: Array<unknown>) {
  return chat({
    adapter: createOpenAI('gpt-4o'),
    messages,
    modelOptions: {
      temperature: 0.3,
      max_output_tokens: 100,
    },
  })
}
