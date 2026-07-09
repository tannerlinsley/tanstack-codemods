import type { Edit, SgNode, SgRoot, Codemod } from 'codemod:ast-grep'
import type TSX from 'codemod:ast-grep/langs/tsx'

// TODO(platform): promote object-literal helpers to @jssg/utils.

type ObjectProp =
  | { kind: 'pair'; node: SgNode<TSX>; key: SgNode<TSX>; value: SgNode<TSX> }
  | { kind: 'shorthand'; node: SgNode<TSX> }

/** Named identifier props only — used for lookups / sampling-key detection. */
function listObjectProps(obj: SgNode<TSX>): ObjectProp[] {
  const out: ObjectProp[] = []
  for (const child of obj.children()) {
    if (child.kind() === 'pair') {
      const key = child.child(0)
      const value = child.child(2)
      if (!key || !value) continue
      if (key.kind() !== 'property_identifier' && key.kind() !== 'identifier') continue
      out.push({ kind: 'pair', node: child, key, value })
      continue
    }
    if (child.kind() === 'shorthand_property_identifier') {
      out.push({ kind: 'shorthand', node: child })
    }
  }
  return out
}

/**
 * Every object entry (pairs, shorthand, spreads, string/computed keys), in
 * source order. `name` is set only for plain identifier keys so callers can
 * filter known props without dropping spreads / exotic keys on rebuild.
 */
function listObjectEntries(obj: SgNode<TSX>): Array<{ node: SgNode<TSX>; name: string | null }> {
  const out: Array<{ node: SgNode<TSX>; name: string | null }> = []
  for (const child of obj.children()) {
    const kind = child.kind()
    if (kind === '{' || kind === '}' || kind === ',') continue
    if (kind === 'pair') {
      const key = child.child(0)
      let name: string | null = null
      if (key && (key.kind() === 'property_identifier' || key.kind() === 'identifier')) {
        name = key.text()
      }
      out.push({ node: child, name })
      continue
    }
    if (kind === 'shorthand_property_identifier') {
      out.push({ node: child, name: child.text() })
      continue
    }
    out.push({ node: child, name: null })
  }
  return out
}

function findObjectProp(obj: SgNode<TSX>, name: string): ObjectProp | null {
  for (const prop of listObjectProps(obj)) {
    if (prop.kind === 'pair' && prop.key.text() === name) return prop
    if (prop.kind === 'shorthand' && prop.node.text() === name) return prop
  }
  return null
}

function propValueText(prop: ObjectProp): string {
  if (prop.kind === 'shorthand') return prop.node.text()
  return prop.value.text()
}

function firstObjectArg(callOrNew: SgNode<TSX>): SgNode<TSX> | null {
  const args = callOrNew.field('arguments') ?? callOrNew.find({ rule: { kind: 'arguments' } })
  if (!args) return null
  for (const child of args.children()) {
    if (child.kind() === 'object') return child
  }
  return null
}

function formatObjectProp(key: string, valueText: string): string {
  if (valueText === key) return key
  return `${key}: ${valueText}`
}

function getStringContent(node: SgNode<TSX>): string | null {
  const fragment = node.find({ rule: { kind: 'string_fragment' } })
  return fragment ? fragment.text() : null
}

const CORE_PACKAGE = '@tanstack/ai'
const TARGET_EXPORTS = new Set(['chat', 'ai', 'generate', 'createChatOptions'])

const ROOT_SAMPLING_KEYS = ['temperature', 'topP', 'maxTokens'] as const
type RootSamplingKey = (typeof ROOT_SAMPLING_KEYS)[number]

type Provider = 'openai' | 'anthropic' | 'gemini' | 'grok' | 'groq' | 'openrouter' | 'ollama'

const FACTORY_TO_PROVIDER: Record<string, Provider> = {
  openaiText: 'openai',
  anthropicText: 'anthropic',
  geminiText: 'gemini',
  grokText: 'grok',
  groqText: 'groq',
  openRouterText: 'openrouter',
  openrouterText: 'openrouter',
  ollamaText: 'ollama',
}

const RENAME: Record<Provider, Record<RootSamplingKey, string>> = {
  openai: {
    temperature: 'temperature',
    topP: 'top_p',
    maxTokens: 'max_output_tokens',
  },
  anthropic: {
    temperature: 'temperature',
    topP: 'top_p',
    maxTokens: 'max_tokens',
  },
  gemini: {
    temperature: 'temperature',
    topP: 'topP',
    maxTokens: 'maxOutputTokens',
  },
  grok: {
    temperature: 'temperature',
    topP: 'top_p',
    maxTokens: 'max_tokens',
  },
  groq: {
    temperature: 'temperature',
    topP: 'top_p',
    maxTokens: 'max_completion_tokens',
  },
  openrouter: {
    temperature: 'temperature',
    topP: 'topP',
    maxTokens: 'maxCompletionTokens',
  },
  ollama: {
    temperature: 'temperature',
    topP: 'top_p',
    maxTokens: 'num_predict',
  },
}

const PROVIDERS_WITH_NESTED_OPTIONS = new Set<Provider>(['ollama'])

interface SymbolOrigin {
  module: string
  importedName: string
}

function moduleFromImportOrExport(stmt: SgNode<TSX>): string | null {
  const str = stmt.children().find((c) => c.kind() === 'string')
  return str ? getStringContent(str) : null
}

/**
 * Package export name from an import/export specifier.
 * `import { openaiText as x }` / `export { openaiText as x }` → `openaiText`.
 */
function importedNameFromSpecifier(spec: SgNode<TSX>, localName: string): string {
  if (spec.kind() === 'import_specifier' || spec.kind() === 'export_specifier') {
    const first = spec.findAll({ rule: { kind: 'identifier' } }).at(0)
    if (first) return first.text()
  }
  return localName
}

/**
 * When `definition()` lands on a whole import/export statement, recover the
 * original package export name for the local binding `localName`.
 */
function importedNameFromStatement(stmt: SgNode<TSX>, localName: string): string {
  for (const kind of ['import_specifier', 'export_specifier'] as const) {
    for (const spec of stmt.findAll({ rule: { kind } })) {
      const idents = spec.findAll({ rule: { kind: 'identifier' } })
      const local = idents.at(-1)?.text()
      if (local === localName) return importedNameFromSpecifier(spec, localName)
    }
  }
  return localName
}

function originFromImportOrExportNode(node: SgNode<TSX>, fallbackLocalName: string): SymbolOrigin | null {
  const exportStmt =
    node.kind() === 'export_statement' ? node : node.ancestors().find((a) => a.kind() === 'export_statement')
  if (exportStmt) {
    const module = moduleFromImportOrExport(exportStmt)
    if (module) {
      const importedName =
        node.kind() === 'export_specifier'
          ? importedNameFromSpecifier(node, fallbackLocalName)
          : importedNameFromStatement(exportStmt, fallbackLocalName)
      return { module, importedName }
    }
  }

  const importStmt =
    node.kind() === 'import_statement' ? node : node.ancestors().find((a) => a.kind() === 'import_statement')
  if (importStmt) {
    const module = moduleFromImportOrExport(importStmt)
    if (module) {
      const importedName =
        node.kind() === 'import_specifier'
          ? importedNameFromSpecifier(node, fallbackLocalName)
          : importedNameFromStatement(importStmt, fallbackLocalName)
      return { module, importedName }
    }
  }

  return null
}

/**
 * Resolve a local identifier to its TanStack package origin via semantic
 * analysis. Call-site `definition()` usually returns `kind: 'local'` on the
 * import binding; a second hop yields `import` (direct/aliased) or `external`
 * (barrel re-export). See https://docs.codemod.com/jssg/semantic-analysis
 */
function resolveSymbolOrigin(ident: SgNode<TSX>): SymbolOrigin | null {
  let current: SgNode<TSX> = ident
  const fallbackName = ident.text()

  for (let hop = 0; hop < 4; hop++) {
    const def = current.definition()
    if (!def) return null

    if (def.kind === 'import' || def.kind === 'external') {
      const fromStmt = originFromImportOrExportNode(def.node, fallbackName)
      if (fromStmt) return fromStmt

      if (def.kind === 'external') {
        const file = def.root.filename().replaceAll('\\', '/')
        const match = file.match(/node_modules\/(@tanstack\/[^/]+)/)
        if (match?.[1]) return { module: match[1], importedName: fallbackName }
      }
      return null
    }

    if (def.node.kind() === 'import_specifier' || def.node.kind() === 'export_specifier') {
      const importedIdent = def.node.findAll({ rule: { kind: 'identifier' } }).at(0)
      if (importedIdent) {
        const next = importedIdent.definition()
        if (next && (next.kind === 'import' || next.kind === 'external')) {
          // Prefer the origin from the next hop (package re-export / import).
          // Do not re-derive the name from `def.node` — for
          // `import { createOpenAI } from './barrel'` that would keep the
          // local alias instead of the package export (`openaiText`).
          const fromStmt = originFromImportOrExportNode(next.node, importedIdent.text())
          if (fromStmt) return fromStmt
        }
        current = importedIdent
        continue
      }
    }

    if (def.node.kind() === 'identifier') {
      current = def.node
      continue
    }

    current = def.node
  }

  return null
}

function isCoreHelperOrigin(origin: SymbolOrigin | null): boolean {
  return !!origin && origin.module === CORE_PACKAGE && TARGET_EXPORTS.has(origin.importedName)
}

function resolveProvider(obj: SgNode<TSX>): Provider | null {
  const adapterProp = findObjectProp(obj, 'adapter')
  if (adapterProp?.kind !== 'pair') return null
  const value = adapterProp.value
  if (value.kind() !== 'call_expression') return null
  const callee = value.child(0)
  if (callee?.kind() !== 'identifier') return null

  // Prefer package export name via semantic analysis so aliases / barrel
  // re-exports still resolve (jscodeshift only matched local identifier text).
  const origin = resolveSymbolOrigin(callee)
  if (origin) {
    const fromImported = FACTORY_TO_PROVIDER[origin.importedName]
    if (fromImported) return fromImported
  }
  return FACTORY_TO_PROVIDER[callee.text()] ?? null
}

function warn(filePath: string, line: number, reason: string): void {
  console.warn(`[move-sampling-to-model-options] ${filePath}:${line} — ${reason}`)
}

function objectPropIndent(obj: SgNode<TSX>): string {
  const first = listObjectProps(obj)[0]
  if (first) return ' '.repeat(first.node.range().start.column)
  return ' '.repeat(obj.range().start.column + 2)
}

function objectCloseIndent(obj: SgNode<TSX>): string {
  const propIndent = objectPropIndent(obj)
  if (propIndent.length >= 2) return propIndent.slice(0, -2)
  return ''
}

function joinObjectProps(propIndent: string, closeIndent: string, props: string[]): string {
  if (props.length === 0) return '{}'
  return `{\n${propIndent}${props.join(`,\n${propIndent}`)},\n${closeIndent}}`
}

function rebuildObjectWithout(obj: SgNode<TSX>, removeNames: Set<string>, appendProps: string[]): string {
  const propIndent = objectPropIndent(obj)
  const closeIndent = objectCloseIndent(obj)
  const kept: string[] = []
  for (const entry of listObjectEntries(obj)) {
    if (entry.name !== null && removeNames.has(entry.name)) continue
    kept.push(entry.node.text())
  }
  return joinObjectProps(propIndent, closeIndent, [...kept, ...appendProps])
}

/** Rebuild an object literal, optionally dropping named identifier keys. */
function rebuildObjectEntries(
  obj: SgNode<TSX>,
  propIndent: string,
  closeIndent: string,
  removeNames: Set<string>,
  appendProps: string[],
): string {
  const kept: string[] = []
  for (const entry of listObjectEntries(obj)) {
    if (entry.name !== null && removeNames.has(entry.name)) continue
    kept.push(entry.node.text())
  }
  return joinObjectProps(propIndent, closeIndent, [...kept, ...appendProps])
}

function transformCallObject(obj: SgNode<TSX>, calleeName: string, filePath: string): Edit | null {
  const present: Array<{ key: RootSamplingKey; prop: ObjectProp }> = []
  for (const key of ROOT_SAMPLING_KEYS) {
    const prop = findObjectProp(obj, key)
    if (prop) present.push({ key, prop })
  }
  if (present.length === 0) return null

  const line = obj.range().start.line + 1
  const provider = resolveProvider(obj)
  if (!provider) {
    warn(
      filePath,
      line,
      `${calleeName}(): could not resolve a known provider adapter from the \`adapter\` property; left alone.`,
    )
    return null
  }

  const renameMap = RENAME[provider]
  const nested = PROVIDERS_WITH_NESTED_OPTIONS.has(provider)

  let modelOptionsObj: SgNode<TSX> | null = null
  const modelOptionsProp = findObjectProp(obj, 'modelOptions')
  if (modelOptionsProp) {
    if (modelOptionsProp.kind !== 'pair' || modelOptionsProp.value.kind() !== 'object') {
      warn(
        filePath,
        line,
        `${calleeName}(): \`modelOptions\` exists but is not a plain object literal; left alone. Merge by hand.`,
      )
      return null
    }
    modelOptionsObj = modelOptionsProp.value
  }

  let nestedOptionsObj: SgNode<TSX> | null = null
  if (nested && modelOptionsObj) {
    const optionsProp = findObjectProp(modelOptionsObj, 'options')
    if (optionsProp) {
      if (optionsProp.kind !== 'pair' || optionsProp.value.kind() !== 'object') {
        warn(
          filePath,
          line,
          `${calleeName}(): \`modelOptions.options\` exists but is not a plain object literal; left alone. Merge by hand.`,
        )
        return null
      }
      nestedOptionsObj = optionsProp.value
    }
  }

  const destForCheck = nested ? nestedOptionsObj : modelOptionsObj
  for (const { key } of present) {
    const renamed = renameMap[key]
    if (destForCheck && findObjectProp(destForCheck, renamed)) {
      warn(
        filePath,
        line,
        `${calleeName}(): a target key already exists in ${
          nested ? '`modelOptions.options`' : '`modelOptions`'
        }; left alone. Merge by hand.`,
      )
      return null
    }
  }

  const movedPropTexts = present.map(({ key, prop }) => formatObjectProp(renameMap[key], propValueText(prop)))

  const callPropIndent = objectPropIndent(obj)
  const modelPropIndent = `${callPropIndent}  `
  const optionsPropIndent = `${modelPropIndent}  `
  const modelCloseIndent = callPropIndent
  const optionsCloseIndent = modelPropIndent

  let modelOptionsText: string
  if (nested) {
    let optionsInner: string
    if (nestedOptionsObj) {
      optionsInner = rebuildObjectEntries(
        nestedOptionsObj,
        optionsPropIndent,
        optionsCloseIndent,
        new Set(),
        movedPropTexts,
      )
    } else {
      optionsInner = joinObjectProps(optionsPropIndent, optionsCloseIndent, movedPropTexts)
    }

    if (modelOptionsObj) {
      modelOptionsText = rebuildObjectEntries(
        modelOptionsObj,
        modelPropIndent,
        modelCloseIndent,
        new Set(['options']),
        [`options: ${optionsInner}`],
      )
    } else {
      modelOptionsText = joinObjectProps(modelPropIndent, modelCloseIndent, [`options: ${optionsInner}`])
    }
  } else if (modelOptionsObj) {
    modelOptionsText = rebuildObjectEntries(
      modelOptionsObj,
      modelPropIndent,
      modelCloseIndent,
      new Set(),
      movedPropTexts,
    )
  } else {
    modelOptionsText = joinObjectProps(modelPropIndent, modelCloseIndent, movedPropTexts)
  }

  const removeNames = new Set<string>(present.map((p) => p.key))
  removeNames.add('modelOptions')

  return obj.replace(rebuildObjectWithout(obj, removeNames, [`modelOptions: ${modelOptionsText}`]))
}

const transform: Codemod<TSX> = async (root: SgRoot<TSX>) => {
  const rootNode = root.root()
  const filePath = root.filename()
  const edits: Edit[] = []
  const seen = new Set<number>()

  for (const call of rootNode.findAll({ rule: { kind: 'call_expression' } })) {
    const id = call.range().start.index
    if (seen.has(id)) continue

    const callee = call.child(0)
    if (callee?.kind() !== 'identifier') continue
    if (!isCoreHelperOrigin(resolveSymbolOrigin(callee))) continue

    seen.add(id)
    const obj = firstObjectArg(call)
    if (!obj) continue

    const edit = transformCallObject(obj, callee.text(), filePath)
    if (edit) edits.push(edit)
  }

  if (edits.length === 0) return null
  return rootNode.commitEdits(edits)
}

export default transform
