import { createChat, fetchServerSentEvents } from '@tanstack/ai-svelte'

const chat = createChat({
  connection: fetchServerSentEvents('/api/chat'),
})

// Method call — should rename.
chat.updateForwardedProps({ provider: 'openai' })

// Property access / method reference — must NOT rename.
const updater = chat.updateBody
const form = {
  updateBody: (x: unknown) => x,
}
// Unrelated method call still matches the createChat-in-scope heuristic
// (same as the jscodeshift port); only non-call member access is newly protected.
form.updateForwardedProps({ keep: true })
