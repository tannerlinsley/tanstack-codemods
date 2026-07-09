import { chat } from '@tanstack/ai'
import { openaiText } from '@tanstack/ai-openai'

const rest = { messages: [] as Array<unknown> }
const mo = { presence_penalty: 0.2 }
const computed = 'extra'

export function run() {
  return chat({
    adapter: openaiText('gpt-4o'),
    ...rest,
    temperature: 0.3,
    maxTokens: 100,
    'custom-key': 1,
    [computed]: 2,
    modelOptions: {
      ...mo,
      frequency_penalty: 0.1,
    },
  })
}
