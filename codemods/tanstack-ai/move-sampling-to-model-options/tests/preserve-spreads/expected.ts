import { chat } from '@tanstack/ai'
import { openaiText } from '@tanstack/ai-openai'

const rest = { messages: [] as Array<unknown> }
const mo = { presence_penalty: 0.2 }
const computed = 'extra'

export function run() {
  return chat({
    adapter: openaiText('gpt-4o'),
    ...rest,
    'custom-key': 1,
    [computed]: 2,
    modelOptions: {
      ...mo,
      frequency_penalty: 0.1,
      temperature: 0.3,
      max_output_tokens: 100,
    },
  })
}
