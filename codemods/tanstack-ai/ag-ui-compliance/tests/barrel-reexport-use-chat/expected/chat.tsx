import { useChat, fetchServerSentEvents } from './ai'

export function Chat() {
  const result = useChat({
    connection: fetchServerSentEvents('/api/chat'),
    forwardedProps: {
      provider: 'openai',
      model: 'gpt-4o',
    },
  })
  return result
}
