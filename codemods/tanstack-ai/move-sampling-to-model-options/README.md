# move-sampling-to-model-options

Moves root-level `temperature` / `topP` / `maxTokens` off `chat()` / `ai()` / `generate()` / `createChatOptions()` into provider-native `modelOptions`, renaming each key per provider resolved from `adapter: <factory>(...)`.

For ollama, renamed keys nest under `modelOptions.options`. Calls with an unresolvable adapter, non-literal `modelOptions`, or a key conflict are left untouched and reported.

Callee origin uses [JSSG semantic analysis](https://docs.codemod.com/jssg/semantic-analysis) (`definition()`), so this also covers:

- **Import aliases** — `import { chat as runChat } from '@tanstack/ai'`
- **Barrel re-exports** — `export { chat } from '@tanstack/ai'` then import from `./ai`

## Run

```bash
npx codemod move-sampling-to-model-options

# Or locally
npx codemod workflow run \
  -w /path/to/tanstack-codemods/codemods/tanstack-ai/move-sampling-to-model-options/workflow.yaml \
  -t /path/to/your/app
```

## Development

```bash
pnpm install
pnpm --filter move-sampling-to-model-options test
pnpm --filter move-sampling-to-model-options check-types
```

## License

MIT
