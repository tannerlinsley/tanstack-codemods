import { useChat as useAiChat, fetchServerSentEvents } from '@tanstack/ai-react'

export function Chat() {
  const result = useAiChat({
    connection: fetchServerSentEvents('/api/chat'),
    body: { provider: 'openai' },
  })
  return result
}
