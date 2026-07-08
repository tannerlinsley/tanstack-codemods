/**
 * AG-UI client compliance migration (JSSG port of TanStack AI's jscodeshift
 * `ag-ui-compliance` transform).
 *
 *   1. useChat({ body }) → useChat({ forwardedProps })
 *   2. new ChatClient({ body }) → new ChatClient({ forwardedProps })
 *   3. client.updateOptions({ body }) → { forwardedProps }
 *      (when ChatClient is in scope from @tanstack/ai-client)
 *   4. chat.updateBody(x) → chat.updateForwardedProps(x)
 *      (when createChat is in scope from @tanstack/ai-svelte)
 *   5. chat({ conversationId }) → chat({ threadId })
 *      (when chat is in scope from @tanstack/ai)
 *
 * Origin gating uses JSSG semantic analysis (`definition()`) so barrel
 * re-exports and import aliases work — cases the jscodeshift port skips
 * (see TanStack/ai ag-ui-compliance README "Re-exports and aliases").
 *
 * Conflict handling: if both legacy and canonical keys are already present,
 * leave the property alone and warn.
 */
import type { Edit, SgNode, SgRoot, Transform } from 'codemod:ast-grep'
import type TSX from 'codemod:ast-grep/langs/tsx'

// TODO(platform): promote object-literal helpers to @jssg/utils.

type ObjectProp =
  | { kind: 'pair'; node: SgNode<TSX>; key: SgNode<TSX>; value: SgNode<TSX> }
  | { kind: 'shorthand'; node: SgNode<TSX> }

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

function findObjectProp(obj: SgNode<TSX>, name: string): ObjectProp | null {
  for (const prop of listObjectProps(obj)) {
    if (prop.kind === 'pair' && prop.key.text() === name) return prop
    if (prop.kind === 'shorthand' && prop.node.text() === name) return prop
  }
  return null
}

/** Rename `oldName` → `newName`. Shorthand `{ body }` → `{ forwardedProps: body }`. */
function renameObjectProp(obj: SgNode<TSX>, oldName: string, newName: string): Edit | 'conflict' | null {
  const oldProp = findObjectProp(obj, oldName)
  if (!oldProp) return null
  if (findObjectProp(obj, newName)) return 'conflict'
  if (oldProp.kind === 'shorthand') {
    return oldProp.node.replace(`${newName}: ${oldName}`)
  }
  return oldProp.key.replace(newName)
}

function firstObjectArg(callOrNew: SgNode<TSX>): SgNode<TSX> | null {
  const args = callOrNew.field('arguments') ?? callOrNew.find({ rule: { kind: 'arguments' } })
  if (!args) return null
  for (const child of args.children()) {
    if (child.kind() === 'object') return child
  }
  return null
}

function getStringContent(node: SgNode<TSX>): string | null {
  const fragment = node.find({ rule: { kind: 'string_fragment' } })
  return fragment ? fragment.text() : null
}

const FRAMEWORK_USE_CHAT_PACKAGES = new Set([
  '@tanstack/ai-react',
  '@tanstack/ai-react-ui',
  '@tanstack/ai-vue',
  '@tanstack/ai-vue-ui',
  '@tanstack/ai-solid',
  '@tanstack/ai-solid-ui',
  '@tanstack/ai-preact',
])

const SVELTE_PACKAGE = '@tanstack/ai-svelte'
const CLIENT_PACKAGE = '@tanstack/ai-client'
const CORE_PACKAGE = '@tanstack/ai'

interface SymbolOrigin {
  module: string
  /** Package export name (e.g. `useChat`), not the local alias. */
  importedName: string
}

function moduleFromImportOrExport(stmt: SgNode<TSX>): string | null {
  const str = stmt.children().find((c) => c.kind() === 'string')
  return str ? getStringContent(str) : null
}

/**
 * When `definition()` lands on an import/export specifier, recover the
 * original package export name (`useChat` in `import { useChat as x }`).
 */
function importedNameFromSpecifier(spec: SgNode<TSX>, localName: string): string {
  if (spec.kind() === 'import_specifier' || spec.kind() === 'export_specifier') {
    const idents = spec.findAll({ rule: { kind: 'identifier' } })
    const first = idents.at(0)
    if (first) return first.text()
  }
  return localName
}

function originFromImportOrExportNode(node: SgNode<TSX>, fallbackLocalName: string): SymbolOrigin | null {
  const exportStmt =
    node.kind() === 'export_statement' ? node : node.ancestors().find((a) => a.kind() === 'export_statement')
  if (exportStmt) {
    const module = moduleFromImportOrExport(exportStmt)
    if (module) {
      return { module, importedName: importedNameFromSpecifier(node, fallbackLocalName) }
    }
  }

  const importStmt =
    node.kind() === 'import_statement' ? node : node.ancestors().find((a) => a.kind() === 'import_statement')
  if (importStmt) {
    const module = moduleFromImportOrExport(importStmt)
    if (module) {
      return { module, importedName: importedNameFromSpecifier(node, fallbackLocalName) }
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

    // kind === 'local': hop through the binding. Prefer the imported name
    // identifier inside `import { useChat as useAiChat }` so the next
    // definition() returns kind: 'import' / 'external'.
    if (def.node.kind() === 'import_specifier' || def.node.kind() === 'export_specifier') {
      const idents = def.node.findAll({ rule: { kind: 'identifier' } })
      const importedIdent = idents.at(0)
      if (importedIdent) {
        const next = importedIdent.definition()
        if (next && (next.kind === 'import' || next.kind === 'external')) {
          const fromStmt = originFromImportOrExportNode(next.node, fallbackName)
          if (fromStmt) {
            // Prefer the package export name from the specifier text.
            return {
              module: fromStmt.module,
              importedName: importedNameFromSpecifier(def.node, fromStmt.importedName),
            }
          }
        }
        current = importedIdent
        continue
      }
    }

    if (def.node.kind() === 'identifier') {
      current = def.node
      continue
    }

    // Local landed on the specifier itself — try definition on it.
    current = def.node
  }

  return null
}

function isUseChatOrigin(origin: SymbolOrigin | null): boolean {
  return !!origin && FRAMEWORK_USE_CHAT_PACKAGES.has(origin.module) && origin.importedName === 'useChat'
}

function isChatClientOrigin(origin: SymbolOrigin | null): boolean {
  return !!origin && origin.module === CLIENT_PACKAGE && origin.importedName === 'ChatClient'
}

function isCreateChatOrigin(origin: SymbolOrigin | null): boolean {
  return !!origin && origin.module === SVELTE_PACKAGE && origin.importedName === 'createChat'
}

function isChatOrigin(origin: SymbolOrigin | null): boolean {
  return !!origin && origin.module === CORE_PACKAGE && origin.importedName === 'chat'
}

function reportConflict(filePath: string, site: string, node: SgNode<TSX>): void {
  const line = node.range().start.line + 1
  console.warn(
    `[ag-ui-compliance] ${filePath}:${line} — ${site}: both legacy and canonical keys are already present; left alone. Merge by hand.`,
  )
}

function applyRename(
  obj: SgNode<TSX>,
  filePath: string,
  siteLabel: string,
  oldKey: string,
  newKey: string,
  site: SgNode<TSX>,
  edits: Edit[],
): void {
  const outcome = renameObjectProp(obj, oldKey, newKey)
  if (outcome === 'conflict') {
    reportConflict(filePath, siteLabel, site)
  } else if (outcome) {
    edits.push(outcome)
  }
}

const transform: Transform<TSX> = async (root: SgRoot<TSX>) => {
  const rootNode = root.root()
  const filePath = root.filename()
  const edits: Edit[] = []

  // 1 + 5. Identifier call sites: useChat(...) / chat(...)
  for (const call of rootNode.findAll({ rule: { kind: 'call_expression' } })) {
    const callee = call.child(0)
    if (callee?.kind() !== 'identifier') continue

    const origin = resolveSymbolOrigin(callee)
    const obj = firstObjectArg(call)
    if (!obj) continue

    if (isUseChatOrigin(origin)) {
      applyRename(obj, filePath, 'useChat({ body })', 'body', 'forwardedProps', call, edits)
    } else if (isChatOrigin(origin)) {
      applyRename(obj, filePath, 'chat({ conversationId })', 'conversationId', 'threadId', call, edits)
    }
  }

  // 2. new ChatClient({ body })
  for (const expr of rootNode.findAll({ rule: { kind: 'new_expression' } })) {
    const callee = expr.children().find((c) => c.kind() === 'identifier')
    if (!callee) continue
    if (!isChatClientOrigin(resolveSymbolOrigin(callee))) continue
    const obj = firstObjectArg(expr)
    if (!obj) continue
    applyRename(obj, filePath, 'new ChatClient({ body })', 'body', 'forwardedProps', expr, edits)
  }

  // 3. *.updateOptions({ body }) when ChatClient is imported in this file
  //    (same heuristic as jscodeshift — method name is distinctive enough).
  let hasChatClient = false
  for (const id of rootNode.findAll({ rule: { kind: 'identifier', regex: '^ChatClient$' } })) {
    if (isChatClientOrigin(resolveSymbolOrigin(id))) {
      hasChatClient = true
      break
    }
  }
  // Also accept local aliases whose origin is ChatClient
  if (!hasChatClient) {
    for (const stmt of rootNode.findAll({ rule: { kind: 'import_statement' } })) {
      for (const spec of stmt.findAll({ rule: { kind: 'import_specifier' } })) {
        const local = spec.findAll({ rule: { kind: 'identifier' } }).at(-1)
        if (!local) continue
        if (isChatClientOrigin(resolveSymbolOrigin(local))) {
          hasChatClient = true
          break
        }
      }
      if (hasChatClient) break
    }
  }

  if (hasChatClient) {
    for (const call of rootNode.findAll({ rule: { pattern: '$OBJ.updateOptions($$$ARGS)' } })) {
      const obj = firstObjectArg(call)
      if (!obj) continue
      applyRename(obj, filePath, 'updateOptions({ body })', 'body', 'forwardedProps', call, edits)
    }
  }

  // 4. *.updateBody(...) when createChat is in scope from @tanstack/ai-svelte
  let hasCreateChat = false
  for (const stmt of rootNode.findAll({ rule: { kind: 'import_statement' } })) {
    for (const spec of stmt.findAll({ rule: { kind: 'import_specifier' } })) {
      const local = spec.findAll({ rule: { kind: 'identifier' } }).at(-1)
      if (!local) continue
      if (isCreateChatOrigin(resolveSymbolOrigin(local))) {
        hasCreateChat = true
        break
      }
    }
    if (hasCreateChat) break
  }

  if (hasCreateChat) {
    for (const prop of rootNode.findAll({
      rule: {
        kind: 'property_identifier',
        regex: '^updateBody$',
        inside: { kind: 'member_expression' },
      },
    })) {
      const parent = prop.parent()
      if (parent?.kind() !== 'member_expression') continue
      const field = parent.field('property')
      if (field?.id() !== prop.id()) continue
      edits.push(prop.replace('updateForwardedProps'))
    }
  }

  if (edits.length === 0) return null
  return rootNode.commitEdits(edits)
}

export default transform
