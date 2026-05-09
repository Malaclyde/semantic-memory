import Embedder from "./kb/embedder";
import Reranker from "./kb/reranker";
import DB, { Concept } from './kb/db';

const EMBEDDING_MODEL = { name: 'Xenova/all-MiniLM-L6-v2', numDimensions: 384 };
const RERANKER_TOKENIZER = 'Xenova/bge-reranker-base';
const RERANKER_MODEL = 'Xenova/bge-reranker-base';

interface ChunkDef {
    text: string;
    concepts: ConceptDef[];
}

interface ConceptDef {
    name: string;
    description?: string;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function findOrCreateConcept(db: DB, concept: ConceptDef, conceptCache: Map<string, number>): Promise<number> {
    const key = concept.name.toLowerCase().trim();

    if (conceptCache.has(key)) {
        return conceptCache.get(key)!;
    }

    try {
        const results = await db.conceptCombinedSearch(concept.name, concept.description || "", 3);

        if (results && results.length > 0 && results[0].score > 0.85) {
            const existingId = Number(results[0].concept.id);
            conceptCache.set(key, existingId);
            console.log(`  [REUSE] Concept "${concept.name}" found with id=${existingId} (score=${results[0].score.toFixed(2)})`);
            return existingId;
        }
    } catch (err) {
        console.log(`  [SEARCH] Concept "${concept.name}" search failed, creating new.`);
    }

    // Return sentinel: -1 means "create new concept"
    conceptCache.set(key, -1);
    return -1;
}

const chunks: ChunkDef[] = [
    // ===== INSTALLATION & SETUP =====
    {
        text: "Crawl4AI is an open-source LLM-friendly web crawler and scraper. You can install it using pip with the command pip install crawl4ai. After installation, run crawl4ai-setup to install required browser dependencies. This setup command performs OS-level checks and confirms your environment is ready to crawl.",
        concepts: [
            { name: "Installation", description: "Installing Crawl4AI via pip and running initial setup" },
            { name: "AsyncWebCrawler", description: "Main asynchronous web crawler class in Crawl4AI" }
        ]
    },
    {
        text: "To verify your installation, you can run the diagnostics command crawl4ai-doctor. This checks Python version compatibility, verifies Playwright installation, and inspects environment variables. If any issues arise, follow its suggestions and re-run crawl4ai-setup.",
        concepts: [
            { name: "Installation", description: "Installing Crawl4AI via pip and running initial setup" },
            { name: "Diagnostics", description: "crawl4ai-doctor command for verifying installation" }
        ]
    },
    {
        text: "For advanced features like text clustering with PyTorch, install with pip install crawl4ai[torch]. For Hugging Face transformers support, use pip install crawl4ai[transformer]. To install everything, use pip install crawl4ai[all]. These bring in larger dependencies that increase disk usage and memory load.",
        concepts: [
            { name: "Installation", description: "Installing Crawl4AI via pip and running initial setup" },
            { name: "PyTorch", description: "PyTorch-based features including cosine similarity and semantic chunking" },
            { name: "Transformers", description: "Hugging Face transformers for summarization and generation strategies" }
        ]
    },
    {
        text: "Docker support is available experimentally with docker pull unclecode/crawl4ai:basic. You can then make POST requests to http://localhost:11235/crawl to perform crawls. Production usage is discouraged until a stable Docker release is available, planned for early 2025.",
        concepts: [
            { name: "Docker", description: "Docker support for Crawl4AI deployment" },
            { name: "Deployment", description: "Deployment options for Crawl4AI including Docker and local server" }
        ]
    },
    {
        text: "You can optionally pre-fetch models using crawl4ai-download-models. This step caches large models locally if needed. Only do this if your workflow requires them. The core library installs without any advanced features like transformers or PyTorch included.",
        concepts: [
            { name: "Installation", description: "Installing Crawl4AI via pip and running initial setup" },
            { name: "Model caching", description: "Pre-fetching and caching ML models for offline use" }
        ]
    },
    {
        text: "A minimal Python script to verify your setup uses AsyncWebCrawler. You create an instance with async with AsyncWebCrawler() as crawler, then call await crawler.arun(url=https://www.example.com). The result contains markdown, HTML, and extracted content from the page.",
        concepts: [
            { name: "AsyncWebCrawler", description: "Main asynchronous web crawler class in Crawl4AI" },
            { name: "Quick Start", description: "Getting started with basic crawling in Crawl4AI" }
        ]
    },

    // ===== QUICK START =====
    {
        text: "The asynchronous crawler AsyncWebCrawler is the main entry point for crawling. Browser behavior is configured via BrowserConfig with options like headless mode and user agent. Each crawl run is configured via CrawlerRunConfig with caching, extraction, timeouts, and hooking options.",
        concepts: [
            { name: "AsyncWebCrawler", description: "Main asynchronous web crawler class in Crawl4AI" },
            { name: "BrowserConfig", description: "Configuration for browser behavior including headless mode and user agent" },
            { name: "CrawlerRunConfig", description: "Configuration for each crawl run including caching and extraction" }
        ]
    },
    {
        text: "Crawl4AI automatically converts HTML to Markdown using DefaultMarkdownGenerator. You can optionally apply content filters like PruningContentFilter to remove low-value sections. The result includes both raw_markdown for unfiltered content and fit_markdown for filtered content.",
        concepts: [
            { name: "Markdown generation", description: "Converting HTML to clean Markdown output" },
            { name: "PruningContentFilter", description: "Content filter that scores nodes by text density and removes low-value sections" },
            { name: "Content filtering", description: "Filtering and pruning content to extract relevant text" }
        ]
    },
    {
        text: "Crawl4AI can extract structured data as JSON using CSS or XPath selectors via JsonCssExtractionStrategy. This is useful for repetitive page structures like item listings or articles. No AI usage or costs are involved, making it ideal for high-volume extraction.",
        concepts: [
            { name: "JsonCssExtractionStrategy", description: "CSS-based structured JSON extraction without LLM" },
            { name: "Extraction strategies", description: "Methods for extracting structured data from web pages" }
        ]
    },
    {
        text: "A utility is available to automatically generate extraction schemas using an LLM. This is a one-time cost that produces a reusable schema for fast, LLM-free extractions afterwards. You can use OpenAI models with an API token or Ollama with open-source models and no token needed.",
        concepts: [
            { name: "Schema generation", description: "Automatically generating extraction schemas using LLM" },
            { name: "LLM integration", description: "Using language models for extraction and schema generation" },
            { name: "Extraction strategies", description: "Methods for extracting structured data from web pages" }
        ]
    },
    {
        text: "For complex or irregular pages, LLM-based extraction can parse text intelligently into a defined structure. Crawl4AI supports both open-source models via Ollama and closed-source models via OpenAI. The LLMExtractionStrategy accepts a Pydantic schema and custom instructions.",
        concepts: [
            { name: "LLMExtractionStrategy", description: "LLM-based extraction strategy for complex unstructured content" },
            { name: "LLM integration", description: "Using language models for extraction and schema generation" },
            { name: "Extraction strategies", description: "Methods for extracting structured data from web pages" }
        ]
    },
    {
        text: "For multi-URL concurrency, use arun_many() with a list of URLs. By default it employs a MemoryAdaptiveDispatcher that adjusts concurrency based on system resources. You can use streaming mode with stream=True to process results as they become available.",
        concepts: [
            { name: "Concurrent crawling", description: "Crawling multiple URLs in parallel with arun_many" },
            { name: "MemoryAdaptiveDispatcher", description: "Auto-adjusts concurrency based on system memory resources" }
        ]
    },
    {
        text: "Dynamic pages that require clicking buttons or JavaScript updates can be handled with BrowserConfig and CrawlerRunConfig. You can provide js_code to click Load More buttons and wait_for conditions to wait for new content. This enables crawling of JavaScript-heavy single-page applications.",
        concepts: [
            { name: "Page interaction", description: "JavaScript execution and dynamic content handling" },
            { name: "Session management", description: "Reusing browser sessions across multiple crawl steps" }
        ]
    },
    {
        text: "Adaptive crawling is a new feature that intelligently determines when sufficient information has been gathered. It uses confidence scoring to know how complete your information is. The AdaptiveCrawler follows only relevant links and stops automatically when enough data is collected.",
        concepts: [
            { name: "Adaptive crawling", description: "Intelligent crawling that knows when to stop based on information sufficiency" },
            { name: "Confidence scoring", description: "Measuring how complete gathered information is during adaptive crawling" }
        ]
    },

    // ===== SIMPLE CRAWLING =====
    {
        text: "Basic usage involves setting up BrowserConfig and CrawlerRunConfig defaults. The async with AsyncWebCrawler(config=browser_config) as crawler pattern creates a crawler session. Results are returned as CrawlResult objects with markdown, HTML, and other properties.",
        concepts: [
            { name: "AsyncWebCrawler", description: "Main asynchronous web crawler class in Crawl4AI" },
            { name: "BrowserConfig", description: "Configuration for browser behavior including headless mode and user agent" },
            { name: "CrawlerRunConfig", description: "Configuration for each crawl run including caching and extraction" }
        ]
    },
    {
        text: "The CrawlResult object provides several useful properties. result.markdown contains the raw markdown output, result.fit_markdown contains filtered content. result.success indicates whether the crawl succeeded, and result.status_code gives the HTTP status code. result.media and result.links provide access to extracted media and links.",
        concepts: [
            { name: "CrawlResult", description: "Result object returned by the crawler with markdown, media, and links" }
        ]
    },
    {
        text: "You can customize crawls with options in CrawlerRunConfig like word_count_threshold for minimum words per content block. exclude_external_links removes external links from results. remove_overlay_elements removes popups and modals. process_iframes merges iframe content into the output.",
        concepts: [
            { name: "CrawlerRunConfig", description: "Configuration for each crawl run including caching and extraction" },
            { name: "Content filtering", description: "Filtering and pruning content to extract relevant text" }
        ]
    },
    {
        text: "Always check if the crawl was successful by verifying result.success. If it failed, result.error_message contains the error details and result.status_code provides the HTTP status. This is important for robust error handling in production crawls.",
        concepts: [
            { name: "CrawlResult", description: "Result object returned by the crawler with markdown, media, and links" },
            { name: "Error handling", description: "Handling crawl errors and failures gracefully" }
        ]
    },
    {
        text: "Enable verbose logging in BrowserConfig by setting verbose=True. This provides detailed output about what the browser and crawler are doing. It is useful for debugging crawl issues and understanding the crawling pipeline.",
        concepts: [
            { name: "BrowserConfig", description: "Configuration for browser behavior including headless mode and user agent" },
            { name: "Debugging", description: "Debugging and logging for crawl issues" }
        ]
    },
    {
        text: "For comprehensive usage, combine content filtering with word_count_threshold and excluded_tags. You can exclude specific HTML tags like form and header. Cache control with CacheMode.ENABLED uses cached content when available. Processing images in result.media gives access to all found images.",
        concepts: [
            { name: "CrawlerRunConfig", description: "Configuration for each crawl run including caching and extraction" },
            { name: "Cache modes", description: "Caching strategies for crawl results" },
            { name: "Content filtering", description: "Filtering and pruning content to extract relevant text" }
        ]
    },

    // ===== DEEP CRAWLING =====
    {
        text: "Deep crawling explores websites beyond a single page using configurable strategies. BFSDeepCrawlStrategy uses breadth-first search, exploring all links at one depth before moving deeper. Parameters include max_depth for crawl depth, include_external for cross-domain links, and max_pages to limit total pages.",
        concepts: [
            { name: "Deep crawling", description: "Crawling multiple pages beyond a single URL with configurable strategies" },
            { name: "BFSDeepCrawlStrategy", description: "Breadth-first search deep crawl strategy" }
        ]
    },
    {
        text: "DFSDeepCrawlStrategy uses a depth-first approach, exploring as far down a branch as possible before backtracking. This is useful for deep exploration of specific content paths. Parameters include max_depth, include_external, max_pages, and score_threshold for minimum URL scores.",
        concepts: [
            { name: "Deep crawling", description: "Crawling multiple pages beyond a single URL with configurable strategies" },
            { name: "DFSDeepCrawlStrategy", description: "Depth-first search deep crawl strategy" }
        ]
    },
    {
        text: "BestFirstCrawlingStrategy is the recommended deep crawl strategy. It evaluates discovered URLs based on scorer criteria and visits higher-scoring pages first. This focuses crawl resources on the most relevant content. It works well with KeywordRelevanceScorer for prioritizing relevant pages.",
        concepts: [
            { name: "BestFirstCrawlingStrategy", description: "Recommended deep crawl strategy prioritizing pages by relevance scores" },
            { name: "KeywordRelevanceScorer", description: "Scores URLs based on keyword relevance for prioritized crawling" }
        ]
    },
    {
        text: "Streaming mode with stream=True returns results as an async iterator, processing each result as it becomes available. Non-streaming mode waits for all results to complete. Streaming is better for real-time applications and reduces memory pressure when handling many pages.",
        concepts: [
            { name: "Streaming mode", description: "Processing crawl results as they become available" },
            { name: "Concurrent crawling", description: "Crawling multiple URLs in parallel with arun_many" }
        ]
    },
    {
        text: "Filter chains allow combining multiple filters for sophisticated URL targeting. URLPatternFilter matches URL patterns using wildcard syntax. DomainFilter controls which domains to include or exclude. ContentTypeFilter filters based on HTTP Content-Type. SEOFilter evaluates SEO elements like meta tags and headers.",
        concepts: [
            { name: "Filter chains", description: "Combining multiple filters for URL targeting in deep crawling" },
            { name: "URLPatternFilter", description: "Filters URLs by wildcard patterns" },
            { name: "DomainFilter", description: "Controls which domains to include or exclude during crawling" }
        ]
    },
    {
        text: "ContentRelevanceFilter analyzes actual page content for semantic similarity to a query. It uses BM25-based relevance filtering on head section content. SEOFilter helps identify pages with strong SEO characteristics by evaluating meta tags and headers against keywords.",
        concepts: [
            { name: "ContentRelevanceFilter", description: "Filters pages by semantic similarity to a query" },
            { name: "SEOFilter", description: "Evaluates SEO elements to identify high-quality pages" }
        ]
    },
    {
        text: "Crash recovery is available for long-running production crawls. The crawler can resume from where it left off if interrupted. Prefetch mode enables fast URL discovery by extracting links before crawling. You can also combine deep crawling with content scraping strategies like LXMLWebScrapingStrategy.",
        concepts: [
            { name: "Deep crawling", description: "Crawling multiple pages beyond a single URL with configurable strategies" },
            { name: "Content scraping", description: "Strategies for scraping and processing page content" }
        ]
    },

    // ===== ADAPTIVE CRAWLING =====
    {
        text: "Adaptive crawling introduces intelligence into the crawling process using a three-layer scoring system. Coverage measures how well collected pages cover query terms. Consistency checks whether information is coherent across pages. Saturation detects when new pages are not adding new information.",
        concepts: [
            { name: "Adaptive crawling", description: "Intelligent crawling that knows when to stop based on information sufficiency" },
            { name: "Coverage", description: "How well collected pages cover the query terms in adaptive crawling" },
            { name: "Consistency", description: "Whether information is coherent across crawled pages" }
        ]
    },
    {
        text: "The statistical strategy uses pure information theory and term-based analysis. It is fast and efficient with no API calls or model loading required. It analyzes query term presence and distribution across pages. Best for well-defined queries with specific terminology.",
        concepts: [
            { name: "Statistical strategy", description: "Term-based analysis strategy for adaptive crawling" },
            { name: "Adaptive crawling", description: "Intelligent crawling that knows when to stop based on information sufficiency" }
        ]
    },
    {
        text: "The embedding strategy uses semantic embeddings for deeper understanding beyond exact term matches. It captures meaning and automatically generates query variations. It identifies semantic gaps in knowledge and uses held-out queries to validate coverage. Best for complex queries and ambiguous topics.",
        concepts: [
            { name: "Embedding strategy", description: "Semantic embedding strategy for adaptive crawling with deeper understanding" },
            { name: "Query expansion", description: "Automatically generating query variations for better coverage" }
        ]
    },
    {
        text: "Adaptive configuration includes confidence_threshold to stop when sufficient confidence is reached. max_pages limits total pages crawled. top_k_links controls links to follow per page. min_gain_threshold sets the minimum expected gain to continue crawling additional pages.",
        concepts: [
            { name: "Adaptive crawling", description: "Intelligent crawling that knows when to stop based on information sufficiency" },
            { name: "Confidence scoring", description: "Measuring how complete gathered information is during adaptive crawling" }
        ]
    },
    {
        text: "The embedding strategy can detect when a query is completely unrelated to the content. It will stop quickly with low confidence in such cases. The result includes an is_irrelevant flag in metrics. This prevents wasting resources on irrelevant content.",
        concepts: [
            { name: "Embedding strategy", description: "Semantic embedding strategy for adaptive crawling with deeper understanding" },
            { name: "Adaptive crawling", description: "Intelligent crawling that knows when to stop based on information sufficiency" }
        ]
    },
    {
        text: "Persistence and resumption allow saving and restoring crawl progress. Use save_state=True and specify a state_path to auto-save progress. Resuming a crawl is done with resume_from pointing to the saved state file. The knowledge base can be exported to JSONL format for later use.",
        concepts: [
            { name: "Persistence", description: "Saving and resuming crawl progress" },
            { name: "Knowledge base export", description: "Exporting collected data to JSONL format" }
        ]
    },
    {
        text: "Adaptive crawling is perfect for research tasks, question answering, and knowledge base building. It is not recommended for full site archiving where every page is needed regardless of content. It also should not be used for structured data extraction targeting specific known page patterns.",
        concepts: [
            { name: "Adaptive crawling", description: "Intelligent crawling that knows when to stop based on information sufficiency" },
            { name: "Use cases", description: "Appropriate and inappropriate use cases for adaptive crawling" }
        ]
    },
    {
        text: "The output confidence score ranges from 0 to 1. 0.0-0.3 means insufficient information needing more crawling. 0.3-0.6 provides partial information that may answer basic queries. 0.6-0.7 offers good coverage for most queries. 0.7-1.0 means excellent coverage with comprehensive information.",
        concepts: [
            { name: "Confidence scoring", description: "Measuring how complete gathered information is during adaptive crawling" }
        ]
    },
    {
        text: "Best practices for adaptive crawling include using specific descriptive queries. Start with default confidence threshold of 0.7 for general use. Lower to 0.5-0.6 for exploratory crawling. Raise to 0.8 and above for exhaustive coverage. Use appropriate max_pages limits and adjust top_k_links based on site structure.",
        concepts: [
            { name: "Adaptive crawling", description: "Intelligent crawling that knows when to stop based on information sufficiency" },
            { name: "Best practices", description: "Best practices for effective adaptive crawling" }
        ]
    },

    // ===== MARKDOWN GENERATION =====
    {
        text: "DefaultMarkdownGenerator converts HTML to clean markdown preserving headings, code blocks, and bullet points. It removes scripts and styles that do not add meaningful content. Options like ignore_links remove hyperlinks, body_width wraps text at N characters, and escape_html handles HTML entities.",
        concepts: [
            { name: "Markdown generation", description: "Converting HTML to clean Markdown output" },
            { name: "DefaultMarkdownGenerator", description: "Default markdown generator with configurable options" }
        ]
    },
    {
        text: "Content filters like BM25ContentFilter and PruningContentFilter can be injected into DefaultMarkdownGenerator. BM25 focuses on textual relevance using a user query. Pruning scores each node by text density, link density, and tag importance, discarding those below a threshold.",
        concepts: [
            { name: "Content filtering", description: "Filtering and pruning content to extract relevant text" },
            { name: "BM25ContentFilter", description: "BM25-based content filter for query-relevant text extraction" },
            { name: "PruningContentFilter", description: "Content filter that scores nodes by text density and removes low-value sections" }
        ]
    },
    {
        text: "The content_source parameter controls which HTML is used for markdown generation. cleaned_html uses processed HTML from the scraping strategy (default). raw_html uses the original webpage HTML. fit_html uses HTML preprocessed for schema extraction. Choose based on whether you need balance, completeness, or structural optimization.",
        concepts: [
            { name: "Markdown generation", description: "Converting HTML to clean Markdown output" },
            { name: "HTML source options", description: "Options for which HTML variant to use for markdown generation" }
        ]
    },
    {
        text: "BM25ContentFilter parameters include user_query for the search term, bm25_threshold to control strictness, and language for stemming. Higher threshold means fewer chunks but more relevant results. If no query is provided, BM25 tries to glean context from page metadata.",
        concepts: [
            { name: "BM25ContentFilter", description: "BM25-based content filter for query-relevant text extraction" },
            { name: "Content filtering", description: "Filtering and pruning content to extract relevant text" }
        ]
    },
    {
        text: "PruningContentFilter parameters include min_word_threshold to discard short blocks. threshold_type can be fixed for direct score comparison or dynamic for data-driven adjustment. The algorithm considers text density, link density, tag importance, and structural context like nesting depth.",
        concepts: [
            { name: "PruningContentFilter", description: "Content filter that scores nodes by text density and removes low-value sections" },
            { name: "Text density analysis", description: "Analyzing text density to identify important content blocks" }
        ]
    },
    {
        text: "LLMContentFilter uses language models to generate high-quality filtered markdown while preserving meaning. You can provide custom instructions to focus on specific content types. It handles large documents by processing chunks in parallel. Use smaller chunk_token_threshold for better parallel performance.",
        concepts: [
            { name: "LLMContentFilter", description: "LLM-based content filter for intelligent markdown generation" },
            { name: "Markdown generation", description: "Converting HTML to clean Markdown output" }
        ]
    },
    {
        text: "The MarkdownGenerationResult object provides rich output. raw_markdown is the direct HTML-to-markdown conversion. markdown_with_citations moves links to reference-style footnotes. fit_markdown is the filtered version from content filters. fit_html is the corresponding HTML snippet for debugging.",
        concepts: [
            { name: "MarkdownGenerationResult", description: "Result object with raw, fit, and citation markdown variants" },
            { name: "Markdown generation", description: "Converting HTML to clean Markdown output" }
        ]
    },
    {
        text: "When no content filter is specified, you typically see only the raw markdown output. PruningContentFilter adds around 50ms in processing time. For best results, combine content filters with excluded_tags and word_count_threshold for multi-level filtering of the output.",
        concepts: [
            { name: "Content filtering", description: "Filtering and pruning content to extract relevant text" },
            { name: "PruningContentFilter", description: "Content filter that scores nodes by text density and removes low-value sections" }
        ]
    },

    // ===== CONTENT SELECTION & FILTERING =====
    {
        text: "CSS-based selection with css_selector limits crawl results to a specific page region. The target_elements parameter provides more flexibility by targeting multiple elements while preserving full page context. With target_elements, markdown focuses on those elements but links and media are still extracted from the full page.",
        concepts: [
            { name: "CSS selection", description: "Selecting specific page regions using CSS selectors" },
            { name: "Content selection", description: "Selecting and filtering content from crawled pages" }
        ]
    },
    {
        text: "Content exclusion options include word_count_threshold to ignore short blocks. excluded_tags removes entire HTML tags. exclude_external_links strips external links. exclude_social_media_links removes known social media domains. exclude_domains blocks custom domains. exclude_external_images discards off-domain images.",
        concepts: [
            { name: "Content filtering", description: "Filtering and pruning content to extract relevant text" },
            { name: "Link filtering", description: "Filtering external links, social media links, and specific domains" }
        ]
    },
    {
        text: "Shadow DOM flattening with flatten_shadow_dom=True extracts content from Web Components. It walks all shadow trees, resolves slot projections, and produces a single flat HTML document. It also force-opens closed shadow roots by patching Element.prototype.attachShadow.",
        concepts: [
            { name: "Shadow DOM", description: "Flattening shadow DOM trees to extract Web Component content" },
            { name: "Web Components", description: "Handling Stencil, Lit, Shoelace components with shadow DOM" }
        ]
    },
    {
        text: "Iframe handling with process_iframes=True merges iframe content into the final output. remove_overlay_elements removes floating overlays. remove_consent_popups removes GDPR and cookie consent popups from known CMP providers like OneTrust and Cookiebot.",
        concepts: [
            { name: "Iframe handling", description: "Processing and merging iframe content into the main document" },
            { name: "Content selection", description: "Selecting and filtering content from crawled pages" }
        ]
    },
    {
        text: "The default scraping strategy is LXMLWebScrapingStrategy for excellent performance with large HTML documents. You can create custom scraping strategies by inheriting from ContentScrapingStrategy and implementing the scrap method. The strategy returns a ScrapingResult with cleaned HTML, media, and links.",
        concepts: [
            { name: "LXMLWebScrapingStrategy", description: "Default high-performance LXML-based scraping strategy" },
            { name: "Content scraping", description: "Strategies for scraping and processing page content" }
        ]
    },

    // ===== PAGE INTERACTION =====
    {
        text: "JavaScript execution via js_code in CrawlerRunConfig runs on the fully-loaded page after wait_for completes. Use js_code_before_wait to run JavaScript before wait_for, for triggering content loading. Multiple JS commands can be provided as an array for complex interaction sequences.",
        concepts: [
            { name: "JavaScript execution", description: "Running custom JavaScript during page crawling" },
            { name: "Page interaction", description: "JavaScript execution and dynamic content handling" }
        ]
    },
    {
        text: "Wait conditions support CSS-based waiting with wait_for=css:selector. JavaScript-based waiting uses wait_for=js:expression where the function must return true. This enables waiting for dynamic content like items loaded after scrolling or pagination clicks.",
        concepts: [
            { name: "Wait conditions", description: "Waiting for CSS selectors or JavaScript conditions before capturing content" },
            { name: "Page interaction", description: "JavaScript execution and dynamic content handling" }
        ]
    },
    {
        text: "Multi-step interaction enables clicking Load More buttons and filling forms. The session_id parameter keeps the same page across multiple arun() calls. js_only=True means do not re-navigate, only run JavaScript in the existing page. This is essential for single-page applications.",
        concepts: [
            { name: "Session management", description: "Reusing browser sessions across multiple crawl steps" },
            { name: "Page interaction", description: "JavaScript execution and dynamic content handling" }
        ]
    },
    {
        text: "Form interaction can be achieved by using js_code to fill input fields and submit forms. Set the value of input elements with document.querySelector and submit the form programmatically. Combine with wait_for to wait for results to appear after submission.",
        concepts: [
            { name: "Form interaction", description: "Filling forms and submitting them during crawling" },
            { name: "Page interaction", description: "JavaScript execution and dynamic content handling" }
        ]
    },
    {
        text: "Timing control parameters include page_timeout in milliseconds for overall page load limits. delay_before_return_html adds extra wait time before capturing HTML. mean_delay and max_range add random pauses between requests when crawling multiple URLs with arun_many.",
        concepts: [
            { name: "Timing control", description: "Controlling timeouts and delays during crawling" },
            { name: "CrawlerRunConfig", description: "Configuration for each crawl run including caching and extraction" }
        ]
    },
    {
        text: "Virtual scrolling is supported for sites like Twitter where content is replaced rather than appended. Use VirtualScrollConfig with container_selector, scroll_count, scroll_by, and wait_after_scroll parameters. This is different from JavaScript scrolling which uses window.scrollTo commands.",
        concepts: [
            { name: "Virtual scrolling", description: "Handling virtual scrolling sites like Twitter where content replaces as you scroll" },
            { name: "Page interaction", description: "JavaScript execution and dynamic content handling" }
        ]
    },

    // ===== CACHE MODES =====
    {
        text: "Crawl4AI uses a CacheMode enum replacing old boolean flags. CacheMode.ENABLED enables normal caching with read and write. CacheMode.DISABLED disables all caching. CacheMode.READ_ONLY only reads from cache without writing. CacheMode.WRITE_ONLY only writes to cache without reading. CacheMode.BYPASS skips cache for the operation.",
        concepts: [
            { name: "Cache modes", description: "Caching strategies for crawl results" },
            { name: "CacheMode.ENABLED", description: "Normal caching with read and write operations" }
        ]
    },
    {
        text: "The old system used multiple boolean flags like bypass_cache, disable_cache, no_cache_read, and no_cache_write. These have been replaced by the single CacheMode enum for more intuitive cache control and predictable behavior. CacheMode.BYPASS is the default to have fresh content.",
        concepts: [
            { name: "Cache modes", description: "Caching strategies for crawl results" },
            { name: "CacheMode.BYPASS", description: "Skip cache for this operation to get fresh content" }
        ]
    },

    // ===== LLM-FREE EXTRACTION =====
    {
        text: "Schema-based extraction with JsonCssExtractionStrategy defines a base selector and fields. The base selector identifies container elements. Fields define CSS selectors and types like text, attribute, html, or regex. Nested structures use nested or nested_list types for hierarchical data.",
        concepts: [
            { name: "JsonCssExtractionStrategy", description: "CSS-based structured JSON extraction without LLM" },
            { name: "Schema-based extraction", description: "Defining schemas with selectors for structured data extraction" }
        ]
    },
    {
        text: "XPath extraction with JsonXPathExtractionStrategy uses XPath selectors instead of CSS. It works with the raw:// scheme for passing dummy HTML directly without network requests. This is useful for testing extraction schemas locally before running on live sites.",
        concepts: [
            { name: "JsonXPathExtractionStrategy", description: "XPath-based structured JSON extraction strategy" },
            { name: "Extraction strategies", description: "Methods for extracting structured data from web pages" }
        ]
    },
    {
        text: "Advanced schemas support nested and list types for hierarchical structures. baseFields extract attributes from container elements. transforms can lower case, strip whitespace, or run custom functions. The schema captures categories with products containing features, reviews, and related items.",
        concepts: [
            { name: "Schema-based extraction", description: "Defining schemas with selectors for structured data extraction" },
            { name: "Nested extraction", description: "Extracting nested hierarchical data structures from web pages" }
        ]
    },
    {
        text: "RegexExtractionStrategy provides lightning-fast extraction of common data types using pre-compiled regular expressions. Built-in patterns include Email, PhoneUS, Url, Currency, Date, and Time. Multiple patterns can be combined using bitwise OR operators like Email | PhoneUS | Url.",
        concepts: [
            { name: "RegexExtractionStrategy", description: "Fast regex-based extraction for common data patterns" },
            { name: "Extraction strategies", description: "Methods for extracting structured data from web pages" }
        ]
    },
    {
        text: "LLM-assisted pattern generation optionally uses an LLM once to generate optimized regex patterns. These patterns can then be reused without further LLM calls for fast production extraction. Custom patterns can be added for domain-specific extraction needs.",
        concepts: [
            { name: "Schema generation", description: "Automatically generating extraction schemas using LLM" },
            { name: "RegexExtractionStrategy", description: "Fast regex-based extraction for common data patterns" }
        ]
    },

    // ===== LLM-BASED EXTRACTION =====
    {
        text: "LLM-based extraction uses any model supported by LiteLLM including Ollama, OpenAI, Claude, and more. You define a schema with Pydantic models for structured output. Custom instructions guide the model on what to extract. Content is automatically chunked to handle token limits.",
        concepts: [
            { name: "LLMExtractionStrategy", description: "LLM-based extraction strategy for complex unstructured content" },
            { name: "LLM integration", description: "Using language models for extraction and schema generation" }
        ]
    },
    {
        text: "The LLM extraction flow starts with optional chunking of HTML or markdown into smaller segments. Then a prompt is constructed with instructions and schema for each chunk. LLM inference runs on each chunk in parallel or sequentially. Results from all chunks are merged and parsed into JSON.",
        concepts: [
            { name: "LLM extraction flow", description: "Chunking, prompting, and merging pipeline for LLM extraction" },
            { name: "LLMExtractionStrategy", description: "LLM-based extraction strategy for complex unstructured content" }
        ]
    },
    {
        text: "Key LLM extraction parameters include llm_config for provider and model selection. schema defines the JSON structure using Pydantic. extraction_type can be schema for structured JSON or block for freeform text. instruction provides the prompt. chunk_token_threshold controls chunk size for large content.",
        concepts: [
            { name: "LLM configuration", description: "Configuring LLM provider, model, and extraction parameters" },
            { name: "LLM integration", description: "Using language models for extraction and schema generation" }
        ]
    },
    {
        text: "The input_format parameter determines which crawler result is passed to the LLM. Options include markdown for standard markdown output, fit_markdown for filtered content, and html for raw or cleaned HTML. This choice significantly impacts extraction quality based on the page structure.",
        concepts: [
            { name: "Input format", description: "Choosing markdown, fit_markdown, or HTML as LLM input" },
            { name: "LLM extraction flow", description: "Chunking, prompting, and merging pipeline for LLM extraction" }
        ]
    },
    {
        text: "Token usage tracking is available through show_usage method which prints a usage report. usages list tracks per-chunk token usage. total_usage provides the sum of all chunk calls. This helps monitor costs when using paid LLM providers like OpenAI.",
        concepts: [
            { name: "Token usage tracking", description: "Monitoring token consumption and costs for LLM extraction" },
            { name: "LLM integration", description: "Using language models for extraction and schema generation" }
        ]
    },
    {
        text: "Knowledge graph extraction is possible by defining Pydantic schemas for entities and relationships. The LLM extracts entities with names and descriptions, then identifies relationships between them. This enables building structured knowledge bases from unstructured web content.",
        concepts: [
            { name: "Knowledge graph", description: "Extracting entities and relationships for knowledge base construction" },
            { name: "LLMExtractionStrategy", description: "LLM-based extraction strategy for complex unstructured content" }
        ]
    },
    {
        text: "Best practices for LLM extraction include using chunking when pages exceed the model context window. Well-crafted instructions dramatically improve output reliability. Consider cost and latency trade-offs versus schema-based approaches. Post-validate outputs with Pydantic to catch malformed JSON.",
        concepts: [
            { name: "Best practices", description: "Best practices for effective adaptive crawling" },
            { name: "LLM integration", description: "Using language models for extraction and schema generation" }
        ]
    },

    // ===== FIT MARKDOWN DETAILS =====
    {
        text: "Fit Markdown is a specialized filtered version of your page markdown focusing on the most relevant content. By default, Crawl4AI converts the entire HTML into broad raw markdown. With fit markdown, a content filter algorithm applies pruning or BM25 ranking to remove low-value sections.",
        concepts: [
            { name: "Fit Markdown", description: "Filtered markdown with only the most relevant content" },
            { name: "Markdown generation", description: "Converting HTML to clean Markdown output" }
        ]
    },
    {
        text: "PruningContentFilter scores each node by text density, link density, and tag importance. Nodes below a threshold are discarded. It is great for broad cleanup without a user query. The algorithm penalizes sections that are mostly links and encourages blocks with higher text-to-content ratio.",
        concepts: [
            { name: "PruningContentFilter", description: "Content filter that scores nodes by text density and removes low-value sections" },
            { name: "Text density analysis", description: "Analyzing text density to identify important content blocks" }
        ]
    },
    {
        text: "BM25ContentFilter focuses on textual relevance using BM25 ranking with a user query. It identifies text chunks that best match the query. It is perfect for query-based extraction or searching within pages. Apply BM25 when you need content relevant to a specific topic or question.",
        concepts: [
            { name: "BM25ContentFilter", description: "BM25-based content filter for query-relevant text extraction" },
            { name: "Content filtering", description: "Filtering and pruning content to extract relevant text" }
        ]
    },
    {
        text: "Custom filters can be created by subclassing RelevantContentFilter and implementing filter_content. This allows specialized ML models or site-specific heuristics. The custom filter is then injected into DefaultMarkdownGenerator for use in the crawling pipeline.",
        concepts: [
            { name: "Custom filters", description: "Creating custom content filters by subclassing RelevantContentFilter" },
            { name: "Content filtering", description: "Filtering and pruning content to extract relevant text" }
        ]
    },
    {
        text: "Multi-level filtering combines exclusions with content filters. First, excluded_tags remove specific HTML tags from the HTML. Then the content filter prunes or ranks remaining text blocks. The final fit content is generated in result.markdown.fit_markdown for use in AI pipelines.",
        concepts: [
            { name: "Multi-level filtering", description: "Combining tag exclusions with content filters for refined output" },
            { name: "Fit Markdown", description: "Filtered markdown with only the most relevant content" }
        ]
    },
    {
        text: "Fit Markdown is crucial for summaries to quickly get important text from cluttered pages. Combine with BM25 for search to produce content relevant to a query. For AI pipelines, filter out boilerplate so LLM-based extraction runs on denser text with fewer tokens.",
        concepts: [
            { name: "Fit Markdown", description: "Filtered markdown with only the most relevant content" },
            { name: "Content filtering", description: "Filtering and pruning content to extract relevant text" }
        ]
    },
];

async function seed() {
    const e = new Embedder(EMBEDDING_MODEL.name, EMBEDDING_MODEL.numDimensions);
    const r = new Reranker(RERANKER_TOKENIZER, RERANKER_MODEL);
    const db = new DB(e, r);

    console.log("Starting seed with", chunks.length, "chunks...\n");

    const conceptCache = new Map<string, number>();

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        console.log(`[${i + 1}/${chunks.length}] Processing chunk...`);

        const existingConceptIds: number[] = [];
        const newConcepts: Concept[] = [];

        for (const concept of chunk.concepts) {
            const id = await findOrCreateConcept(db, concept, conceptCache);
            if (id === -1) {
                newConcepts.push(concept);
            } else {
                existingConceptIds.push(id);
            }
        }

        // Assign new concept IDs in cache after insert
        const result = await db.insertChunk(chunk.text, newConcepts, existingConceptIds);

        // Cache newly created concept IDs
        for (let j = 0; j < newConcepts.length; j++) {
            const key = newConcepts[j].name.toLowerCase().trim();
            if (!conceptCache.has(key) || conceptCache.get(key) === -1) {
                conceptCache.set(key, Number(result.concepts[j].id));
                console.log(`  [CREATE] Concept "${newConcepts[j].name}" created with id=${result.concepts[j].id}`);
            }
        }

        console.log(`  [OK] Chunk inserted (id=${result.chunk.id})`);

        await sleep(100);
    }

    console.log("\nSeed complete!");
    console.log(`Total concepts: ${conceptCache.size}`);
    console.log(`Total chunks seeded: ${chunks.length}`);
}

seed().catch(err => {
    console.error("Seed failed:", err);
    process.exit(1);
});
