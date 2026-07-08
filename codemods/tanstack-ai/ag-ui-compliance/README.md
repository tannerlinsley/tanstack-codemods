# ag-ui-compliance

Migrates TanStack AI client code to AG-UI–compliant field names.

| Before                                  | After                                             |
| --------------------------------------- | ------------------------------------------------- |
| `useChat({ body: {...} })`              | `useChat({ forwardedProps: {...} })`              |
| `new ChatClient({ body: {...} })`       | `new ChatClient({ forwardedProps: {...} })`       |
| `client.updateOptions({ body: {...} })` | `client.updateOptions({ forwardedProps: {...} })` |
| `chat.updateBody(x)` (Svelte)           | `chat.updateForwardedProps(x)`                    |
| `chat({ conversationId: x })`           | `chat({ threadId: x })`                           |

Origin gating uses [JSSG semantic analysis](https://docs.codemod.com/jssg/semantic-analysis) (`definition()`), so this covers:

- **Import aliases** — `import { useChat as useAiChat } from '@tanstack/ai-react'`
- **Barrel re-exports** — `export { useChat } from '@tanstack/ai-react'` then import from `./ai`

If both legacy and canonical keys are already present, the call is left alone and a warning is printed.

## Run

```bash
npx codemod ag-ui-compliance

# Or locally
npx codemod workflow run \
  -w /path/to/tanstack-codemods/codemods/tanstack-ai/ag-ui-compliance/workflow.yaml \
  -t /path/to/your/app
```

## Development

```bash
pnpm install
pnpm --filter ag-ui-compliance test
pnpm --filter ag-ui-compliance check-types
```

## License

MIT
