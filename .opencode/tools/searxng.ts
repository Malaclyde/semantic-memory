import { tool } from "@opencode-ai/plugin"

const DEFAULT_INSTANCE = process.env.SEARXNG_INSTANCE_URL ?? "http://localhost:9000"

function safeInt(val: unknown, fallback: number): number {
  const n = typeof val === "number" && !Number.isNaN(val) ? val : Number(val)
  return Number.isFinite(n) ? n : fallback
}

interface SearxngResult {
  url: string
  title: string
  content: string
  engine: string
  engines?: string[]
  publishedDate?: string
  thumbnail?: string
  img_src?: string
  template?: string
  positions?: number[]
}

interface SearxngInfobox {
  id?: string
  content?: string
  engine?: string
  engines?: string[]
  attributes?: { label: string; value: string }[]
  urls?: { title: string; url: string }[]
  img_src?: string
  title?: string
  infobox?: string
}

interface SearxngResponse {
  query: string
  number_of_results?: number
  results: SearxngResult[]
  infoboxes?: SearxngInfobox[]
  suggestions?: string[]
  answers?: string[]
  corrections?: string[]
  unresponsive_engines?: string[]
}

function formatResults(data: SearxngResponse): string {
  const lines: string[] = []

  if (data.answers?.length) {
    lines.push("Answers:")
    for (const a of data.answers) {
      lines.push(`  ${a}`)
    }
    lines.push("")
  }

  if (data.infoboxes?.length) {
    for (const ib of data.infoboxes) {
      if (ib.title && ib.content) {
        lines.push(`Infobox: ${ib.title}`)
        lines.push(`  ${ib.content}`)
      }
      if (ib.attributes?.length) {
        for (const attr of ib.attributes) {
          lines.push(`  ${attr.label}: ${attr.value}`)
        }
      }
      if (ib.urls?.length) {
        for (const u of ib.urls) {
          lines.push(`  ${u.title}: ${u.url}`)
        }
      }
      lines.push("")
    }
  }

  if (data.results?.length) {
    const total = data.number_of_results ?? data.results.length
    lines.push(`Results (${total} total):`)
    for (let i = 0; i < data.results.length; i++) {
      const r = data.results[i]
      lines.push(`${i + 1}. ${r.title}`)
      lines.push(`   URL: ${r.url}`)
      if (r.content) lines.push(`   ${r.content}`)
      if (r.publishedDate) lines.push(`   Published: ${r.publishedDate}`)
      lines.push(`   Engine: ${r.engine}`)
      lines.push("")
    }
  }

  if (!data.results?.length && !data.answers?.length && !data.infoboxes?.length) {
    lines.push("No results found.")
  }

  if (data.suggestions?.length) {
    lines.push("Suggestions: " + data.suggestions.join(", "))
  }
  if (data.corrections?.length) {
    lines.push("Did you mean: " + data.corrections.join(", "))
  }
  if (data.unresponsive_engines?.length) {
    lines.push("Unresponsive engines: " + data.unresponsive_engines.join(", "))
  }

  return lines.join("\n").trim()
}

export default tool({
  description: `Search the web using a SearXNG instance. Supports multiple engines, categories, language filtering, time ranges, and safe search.

Set SEARXNG_INSTANCE_URL env var to your instance (default: http://localhost:9000).

Examples:
  # Basic search
  {q:"latest AI research papers"}
  # Search with specific engines and time range
  {q:"climate change", engines:"google,brave", time_range:"year", language:"en-US"}
  # Search in a specific category
  {q:"rust programming", categories:"it"}`,
  args: {
    q: tool.schema.string().describe("Search query"),
    instance: tool.schema.string().optional().describe("SearXNG instance URL (default: SEARXNG_INSTANCE_URL env var or http://localhost:9000)"),
    categories: tool.schema.string().optional().describe("Comma-separated search categories, e.g. 'general,images,news,science,it,social media,files,map,video'"),
    engines: tool.schema.string().optional().describe("Comma-separated search engines, e.g. 'google,bing,wikipedia,duckduckgo,brave'"),
    language: tool.schema.string().optional().describe("Language code, e.g. 'en-US', 'de-DE', 'fr-FR'"),
    pageno: tool.schema.number().default(1).describe("Search page number"),
    time_range: tool.schema.string().optional().describe("Time range filter: 'day', 'month', or 'year'"),
    safesearch: tool.schema.number().default(0).describe("Safe search level: 0 (off), 1 (moderate), 2 (strict)"),
  },
  async execute(args) {
    const baseUrl = (args.instance || DEFAULT_INSTANCE).replace(/\/+$/, "")
    const params = new URLSearchParams()
    params.set("q", args.q)
    params.set("format", "json")
    params.set("pageno", String(safeInt(args.pageno, 1)))
    params.set("safesearch", String(safeInt(args.safesearch, 0)))
    if (args.categories) params.set("categories", args.categories)
    if (args.engines) params.set("engines", args.engines)
    if (args.language) params.set("language", args.language)
    if (args.time_range) params.set("time_range", args.time_range)

    const url = `${baseUrl}/search?${params.toString()}`

    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "opencode-searxng-tool/1.0",
        },
        signal: AbortSignal.timeout(30000),
      })

      if (!response.ok) {
        const body = await response.text().catch(() => "")
        let msg = `SearXNG returned HTTP ${response.status}`

        if (response.status === 403 && body.includes("format 'json' is not enabled")) {
          msg += `\n\nThe JSON format is not enabled on this instance. The instance admin must add 'json' to the 'search.formats' list in settings.yml.`
        } else if (response.status === 403) {
          msg += `\n\nAccess forbidden. The instance may have restrictions.`
        } else if (body) {
          msg += `\n${body.slice(0, 500)}`
        }

        return msg
      }

      const text = await response.text()
      const data: SearxngResponse = JSON.parse(text)
      return formatResults(data)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)

      if (message.includes("fetch")) {
        return `Connection error: ${message}\n\nEnsure your SearXNG instance is running at ${baseUrl}. Set SEARXNG_INSTANCE_URL env var or pass the instance parameter.`
      }
      if (err instanceof SyntaxError && message.includes("JSON")) {
        return `Non-JSON response from ${baseUrl}. Verify the instance is SearXNG and has JSON format enabled.`
      }

      return `Error: ${message}`
    }
  },
})
