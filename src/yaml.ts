// A strict mini-YAML parser for the workflow template subset: block maps and lists,
// flow maps/lists, quoted and plain scalars, `|` block scalars, comments.
// Anything outside the subset fails with a line number instead of guessing.
export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue }

type Line = { indent: number; text: string; no: number }

const FLOW_END = new Set([',', ']', '}'])

function lex(source: string): Line[] {
  const out: Line[] = []
  const raw = source.split(/\r?\n/)
  for (let i = 0; i < raw.length; i++) {
    let line = raw[i]
    const hash = findComment(line)
    if (hash >= 0) line = line.slice(0, hash)
    if (!line.trim()) {
      out.push({ indent: -1, text: '', no: i + 1 })
      continue
    }
    const indent = line.match(/^ */)![0].length
    out.push({ indent, text: line.trim(), no: i + 1 })
  }
  // Drop trailing blank lines; the parser ignores the rest.
  while (out.length > 0 && out[out.length - 1].text === '') out.pop()
  return out
}

/** A `#` starts a comment only outside quotes and at line start or after whitespace. */
function findComment(line: string): number {
  let quote: '"' | "'" | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === quote) quote = null
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return i
    }
  }
  return -1
}

/** Index of the next non-blank line at or after `i`. */
function nextMeaningful(lines: Line[], i: number): number {
  while (i < lines.length && lines[i].text === '') i++
  return i
}

export function parseYaml(source: string): YamlValue {
  const lines = lex(source)
  const first = nextMeaningful(lines, 0)
  if (first >= lines.length) throw new Error('yaml: пустой файл')
  return parseBlock(lines, first, lines[first].indent).value
}

/** Parses consecutive lines at `indent` as a map or a list, until a shallower line. */
function parseBlock(lines: Line[], start: number, indent: number): { value: YamlValue; next: number } {
  if (lines[start].text === '-' || lines[start].text.startsWith('- ')) {
    return parseList(lines, start, indent)
  }
  return parseMap(lines, start, indent)
}

function parseList(lines: Line[], start: number, indent: number): { value: YfValueList; next: number } {
  const items: YamlValue[] = []
  let i = start
  for (;;) {
    i = nextMeaningful(lines, i)
    if (i >= lines.length || lines[i].indent !== indent) break
    const text = lines[i].text
    if (text !== '-' && !text.startsWith('- ')) break
    const rest = text === '-' ? '' : text.slice(2)
    if (rest === '') {
      const child = nextMeaningful(lines, i + 1)
      if (child < lines.length && lines[child].indent > indent) {
        const parsed = parseBlock(lines, child, lines[child].indent)
        items.push(parsed.value)
        i = parsed.next
      } else {
        items.push(null)
        i++
      }
      continue
    }
    if (isKeyLine(rest)) {
      // "- key: value" starts a map whose remaining keys sit at indent + 2.
      const itemIndent = indent + 2
      const shifted: Line = { indent: itemIndent, text: rest, no: lines[i].no }
      lines[i] = shifted
      const parsed = parseMap(lines, i, itemIndent)
      items.push(parsed.value)
      i = parsed.next
      continue
    }
    items.push(parseFlowScalar(rest, lines[i].no))
    i++
  }
  return { value: items, next: i }
}

type YfValueList = YamlValue[]

function parseMap(lines: Line[], start: number, indent: number): { value: { [key: string]: YamlValue }; next: number } {
  const map: { [key: string]: YamlValue } = {}
  let lastKey = '?'
  let i = start
  for (;;) {
    i = nextMeaningful(lines, i)
    if (i >= lines.length || lines[i].indent !== indent) {
      if (i < lines.length && lines[i].indent > indent) {
        throw new Error(`yaml: строка ${lines[i].no}: неожиданный отступ после "${lastKey}"`)
      }
      break
    }
    const line = lines[i]
    if (line.text === '-' || line.text.startsWith('- ')) break
    if (!isKeyLine(line.text)) {
      throw new Error(`yaml: строка ${line.no}: ожидалось "ключ: значение", получено "${line.text}"`)
    }
    const colon = keyColon(line.text)
    const key = unquote(line.text.slice(0, colon).trim(), line.no)
    const rest = line.text.slice(colon + 1).trim()
    lastKey = key
    if (rest === '|' || rest === '|-') {
      const { value: text, next } = readBlockScalar(lines, i + 1, indent)
      map[key] = rest === '|-' ? text : text === '' ? '' : text + '\n'
      i = next
    } else if (rest === '') {
      const child = nextMeaningful(lines, i + 1)
      if (child < lines.length && lines[child].indent > indent) {
        const parsed = parseBlock(lines, child, lines[child].indent)
        map[key] = parsed.value
        i = parsed.next
      } else {
        map[key] = null
        i++
      }
    } else {
      map[key] = parseFlowScalar(rest, line.no)
      i++
    }
  }
  return { value: map, next: i }
}

/** Literal block body: deeper lines (and blanks inside), indentation relative to the first body line. */
function readBlockScalar(lines: Line[], from: number, parentIndent: number): { value: string; next: number } {
  const body: Line[] = []
  let j = from
  while (j < lines.length && (lines[j].text === '' || lines[j].indent > parentIndent)) {
    body.push(lines[j])
    j++
  }
  while (body.length > 0 && body[body.length - 1].text === '') body.pop()
  if (body.length === 0) return { value: '', next: j }
  const base = body[0].indent
  const value = body
    .map((l) => (l.text === '' ? '' : ' '.repeat(Math.max(0, l.indent - base)) + l.text))
    .join('\n')
  return { value, next: j }
}

/** Position of the `key:` separator (not inside quotes; `:` must end the key or be followed by a space). */
function keyColon(text: string): number {
  let quote: '"' | "'" | null = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === ':') {
      const next = text[i + 1]
      if (next === undefined || next === ' ') return i
    }
  }
  return -1
}

function isKeyLine(text: string): boolean {
  return keyColon(text) > 0
}

/** Parses a block value: a flow collection, a quoted scalar, or a plain scalar to end of line. */
function parseFlowScalar(text: string, no: number): YamlValue {
  const trimmed = text.trim()
  const first = trimmed[0]
  if (first !== '[' && first !== '{' && first !== '"' && first !== "'") {
    if (trimmed === 'null' || trimmed === '~') return null
    if (trimmed === 'true') return true
    if (trimmed === 'false') return false
    if (/^-?\d+$/.test(trimmed)) return Number(trimmed)
    return trimmed
  }
  const cursor = { pos: 0 }
  const value = parseFlow(text, cursor, no)
  skipSpaces(text, cursor)
  if (cursor.pos < text.length) {
    throw new Error(`yaml: строка ${no}: лишнее после значения: "${text.slice(cursor.pos)}"`)
  }
  return value
}

function skipSpaces(text: string, cursor: { pos: number }): void {
  while (cursor.pos < text.length && /\s/.test(text[cursor.pos])) cursor.pos++
}

function parseFlow(text: string, cursor: { pos: number }, no: number): YamlValue {
  skipSpaces(text, cursor)
  const c = text[cursor.pos]
  if (c === undefined) throw new Error(`yaml: строка ${no}: пустое значение`)
  if (c === '[') {
    cursor.pos++
    const items: YamlValue[] = []
    skipSpaces(text, cursor)
    if (text[cursor.pos] === ']') {
      cursor.pos++
      return items
    }
    for (;;) {
      items.push(parseFlow(text, cursor, no))
      skipSpaces(text, cursor)
      const d = text[cursor.pos]
      if (d === ',') {
        cursor.pos++
        skipSpaces(text, cursor)
        if (text[cursor.pos] === ']') {
          cursor.pos++
          return items
        }
      } else if (d === ']') {
        cursor.pos++
        return items
      } else {
        throw new Error(`yaml: строка ${no}: ожидалась "," или "]" в "${text.slice(cursor.pos)}"`)
      }
    }
  }
  if (c === '{') {
    cursor.pos++
    const map: { [key: string]: YamlValue } = {}
    skipSpaces(text, cursor)
    if (text[cursor.pos] === '}') {
      cursor.pos++
      return map
    }
    for (;;) {
      skipSpaces(text, cursor)
      const rest = text.slice(cursor.pos)
      const colon = keyColon(rest)
      if (colon <= 0) {
        throw new Error(`yaml: строка ${no}: ожидался "ключ: значение" в "${rest}"`)
      }
      const key = unquote(rest.slice(0, colon).trim(), no)
      cursor.pos += colon + 1
      map[key] = parseFlow(text, cursor, no)
      skipSpaces(text, cursor)
      const d = text[cursor.pos]
      if (d === ',') {
        cursor.pos++
      } else if (d === '}') {
        cursor.pos++
        return map
      } else {
        throw new Error(`yaml: строка ${no}: ожидалась "," или "}" в "${text.slice(cursor.pos)}"`)
      }
    }
  }
  if (c === '"' || c === "'") {
    cursor.pos++
    let out = ''
    while (cursor.pos < text.length && text[cursor.pos] !== c) {
      out += text[cursor.pos]
      cursor.pos++
    }
    if (cursor.pos >= text.length) throw new Error(`yaml: строка ${no}: незакрытая кавычка`)
    cursor.pos++
    return out
  }
  const start = cursor.pos
  while (cursor.pos < text.length && !FLOW_END.has(text[cursor.pos]) && !/\s/.test(text[cursor.pos])) {
    cursor.pos++
  }
  if (cursor.pos === start) throw new Error(`yaml: строка ${no}: пустое значение`)
  const raw = text.slice(start, cursor.pos)
  if (raw === 'null' || raw === '~') return null
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (/^-?\d+$/.test(raw)) return Number(raw)
  return raw
}

function unquote(text: string, no: number): string {
  if (text.startsWith('"') || text.startsWith("'")) return parseFlowScalar(text, no) as string
  return text
}
