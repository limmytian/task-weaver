// Shared output helpers

export function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2))
}

export function printTable(rows: Record<string, unknown>[], columns: string[]): void {
  if (rows.length === 0) {
    console.log('(no results)')
    return
  }
  const widths = columns.map(col =>
    Math.max(col.length, ...rows.map(r => String(r[col] ?? '').length))
  )
  const header = columns.map((col, i) => col.toUpperCase().padEnd(widths[i] ?? 0)).join('  ')
  const divider = widths.map(w => '-'.repeat(w ?? 0)).join('  ')
  console.log(header)
  console.log(divider)
  for (const row of rows) {
    console.log(columns.map((col, i) => String(row[col] ?? '').padEnd(widths[i] ?? 0)).join('  '))
  }
}

export function printKv(obj: Record<string, unknown>): void {
  const maxKey = Math.max(...Object.keys(obj).map(k => k.length))
  for (const [k, v] of Object.entries(obj)) {
    const val = typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')
    console.log(`${k.padEnd(maxKey)}  ${val}`)
  }
}

export type GraphNode = {
  id: string
  type: string
  label: string
  metadata?: Record<string, unknown>
}

export type GraphEdge = {
  source: string
  target: string
  sourceType?: string
  targetType?: string
  linkType: string
}

export type GraphData = {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

function graphNodeId(id: string): string {
  return `n${id.replace(/[^a-zA-Z0-9_]/g, '_')}`
}

function quoteMermaidLabel(label: string): string {
  return JSON.stringify(label.replace(/\s+/g, ' ').trim())
}

function quoteDot(value: string): string {
  return JSON.stringify(value)
}

export function printMermaidGraph(graph: GraphData, direction = 'LR'): void {
  console.log(`flowchart ${direction}`)
  for (const node of graph.nodes) {
    const status = typeof node.metadata?.status === 'string' ? ` (${node.metadata.status})` : ''
    const label = `${node.label}${status}`
    console.log(`  ${graphNodeId(node.id)}[${quoteMermaidLabel(`${node.type}: ${label}`)}]`)
  }
  for (const edge of graph.edges) {
    console.log(`  ${graphNodeId(edge.source)} -->|${edge.linkType}| ${graphNodeId(edge.target)}`)
  }
}

export function printDotGraph(graph: GraphData, name = 'task_weaver_graph'): void {
  console.log(`digraph ${name.replace(/[^a-zA-Z0-9_]/g, '_')} {`)
  console.log('  rankdir=LR;')
  for (const node of graph.nodes) {
    const status = typeof node.metadata?.status === 'string' ? ` (${node.metadata.status})` : ''
    console.log(`  ${quoteDot(node.id)} [label=${quoteDot(`${node.type}: ${node.label}${status}`)}];`)
  }
  for (const edge of graph.edges) {
    console.log(`  ${quoteDot(edge.source)} -> ${quoteDot(edge.target)} [label=${quoteDot(edge.linkType)}];`)
  }
  console.log('}')
}
