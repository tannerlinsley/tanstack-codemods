import { chat } from '@tanstack/ai'
import { ollamaText } from '@tanstack/ai-ollama'

const mo = { keep_alive: '5m' }
const opts = { seed: 42 }

export function run(messages: Array<unknown>) {
  return chat({
    adapter: ollamaText('llama3'),
    messages,
    temperature: 0.7,
    maxTokens: 200,
    modelOptions: {
      ...mo,
      options: {
        ...opts,
        num_ctx: 2048,
      },
    },
  })
}
