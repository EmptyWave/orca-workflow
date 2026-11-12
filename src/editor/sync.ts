// The only code that talks to Orca's document session; testable in Node via mockEditorHost.
import { decode, emit, mergeGraphs, type WfGraph } from './core'

/** Sends edits, keeps unsaved moves, merges outside writes (an agent editing the yaml too). */
export function startSession(): Promise<import('orca/frame').EditorSession<WfGraph>> {
  const document = orca.document
  if (!document) {
    throw new Error('этот модуль работает только как custom editor')
  }
  return document.session<WfGraph>({
    decode: (content) => (content.kind === 'text' ? decode(content.text) : { ...decode('') }),
    encode: (graph) => ({ kind: 'text', text: emit(graph) }),
    merge: (base, outside, mine) => mergeGraphs(base, outside, mine)
  })
}
