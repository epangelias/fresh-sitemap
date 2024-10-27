import { globToRegExp, join, normalize, SEPARATOR } from 'jsr:@std/path@0.224.0'
import { ensureFile, exists } from 'jsr:@std/fs@0.224.0'

export interface SiteMapEntry {
  loc: string // URL location included in the <loc> tag
  lastmod: string // Last modification date in ISO format for the <lastmod> tag
}

export type Sitemap = SiteMapEntry[]

export interface SiteMapOptions {
  include?: string // Glob pattern for files to include
  exclude?: string // Glob pattern for files to exclude
  languages?: string[] // Array of supported language codes
  defaultLanguage?: string // Default language for URLs without language prefix
}

/**
 * Generates a sitemap XML for given directories and base URL.
 * @param basename - The base URL of the website (e.g., 'https://example.com')
 * @param distDirectory - The directory containing route files
 * @param articlesDirectory - The directory containing articles in markdown format
 * @param options - Options for sitemap generation
 * @returns Generated sitemap as an XML string
 */
export async function generateSitemapXML(
  basename: string,
  distDirectory: string,
  articlesDirectory: string,
  options: SiteMapOptions = {},
): Promise<string> {
  const routesSitemap = await generateSitemap(basename, distDirectory, options)
  const articlesSitemap = await generateArticlesSitemap(
    basename,
    articlesDirectory,
    options,
  )
  const sitemap = [...routesSitemap, ...articlesSitemap]
  return sitemapToXML(sitemap)
}

/**
 * Saves the generated sitemap XML to a specified file path.
 * @param basename - The base URL of the website
 * @param distDirectory - Directory containing route files
 * @param articlesDirectory - Directory containing articles
 * @param outputPath - Path where sitemap.xml will be saved
 * @param options - Options for sitemap generation
 */
export async function saveSitemap(
  basename: string,
  distDirectory: string,
  articlesDirectory: string,
  outputPath: string,
  options: SiteMapOptions = {},
): Promise<void> {
  const sitemapXML = await generateSitemapXML(
    basename,
    distDirectory,
    articlesDirectory,
    options,
  )
  await ensureFile(outputPath)
  await Deno.writeTextFile(outputPath, sitemapXML)
}

/**
 * Generates sitemap entries for static routes, excluding dynamic and grouping directories.
 * @param basename - The base URL
 * @param distDirectory - Directory containing routes
 * @param options - Options for sitemap generation
 * @returns Array of sitemap entries
 */
async function generateSitemap(
  basename: string,
  distDirectory: string,
  options: SiteMapOptions,
): Promise<Sitemap> {
  const sitemap: Sitemap = []
  const include = options.include && globToRegExp(options.include)
  const exclude = options.exclude && globToRegExp(options.exclude)

  async function addDirectory(directory: string) {
    for await (const path of stableRecurseFiles(directory)) {
      const relPath = distDirectory === '.'
        ? path
        : path.substring(distDirectory.length)
      const pathname = normalize(`/${relPath}`).split(SEPARATOR).join('/')

      // Ignore grouping directories and dynamic routes
      if (pathname.includes('(') || pathname.includes('[')) continue

      // Apply include/exclude filters if specified
      const isExcluded = exclude && exclude.test(pathname.substring(1))
      const isIncluded = !include || include.test(pathname.substring(1))
      if (isExcluded || !isIncluded) continue

      const { mtime } = await Deno.stat(path)
      sitemap.push({
        loc: basename + pathname,
        lastmod: (mtime ?? new Date()).toISOString(),
      })

      // Add paths for each specified language
      options.languages?.forEach((lang) => {
        if (lang !== options.defaultLanguage) {
          sitemap.push({
            loc: `${basename}/${lang}${pathname}`,
            lastmod: (mtime ?? new Date()).toISOString(),
          })
        }
      })
    }
  }

  await addDirectory(distDirectory)
  return sitemap
}

/**
 * Generates sitemap entries for markdown articles, respecting language settings.
 * Checks if the articles directory exists before processing.
 * @param basename - The base URL
 * @param articlesDirectory - Directory containing article markdown files
 * @param options - Options for sitemap generation, including languages
 * @returns Array of sitemap entries for articles
 */
async function generateArticlesSitemap(
  basename: string,
  articlesDirectory: string,
  options: SiteMapOptions,
): Promise<Sitemap> {
  const sitemap: Sitemap = []
  const languages = options.languages || []

  // Check if articlesDirectory exists; if not, return an empty sitemap
  if (!(await exists(articlesDirectory))) {
    return sitemap
  }

  async function addMarkdownFile(path: string) {
    const relPath = path.substring(articlesDirectory.length).replace(
      /\.md$/,
      '',
    )
    const segments = relPath.split(SEPARATOR).map((segment) =>
      segment.replace(/^en\//, '')
    )
    const pathname = normalize(`/${segments.join('/')}`).replace(/\/index$/, '')

    const urlPaths = languages.length > 0
      ? languages.map((lang) =>
        lang === options.defaultLanguage ? pathname : `/${lang}${pathname}`
      )
      : [pathname]

    for (const urlPath of urlPaths) {
      const { mtime } = await Deno.stat(path)
      sitemap.push({
        loc: basename + urlPath,
        lastmod: (mtime ?? new Date()).toISOString(),
      })
    }
  }

  for await (const path of stableRecurseFiles(articlesDirectory)) {
    if (path.endsWith('.md')) {
      await addMarkdownFile(path)
    }
  }

  return sitemap
}

/**
 * Recursively iterates through a directory to retrieve all file paths in a stable, sorted order.
 * @param directory - Directory path to recurse
 * @returns Generator of file paths
 */
async function* stableRecurseFiles(directory: string): AsyncGenerator<string> {
  const itr = Deno.readDir(directory)
  const files: Deno.DirEntry[] = []
  for await (const entry of itr) {
    files.push(entry)
  }
  const sorted = files.sort(({ name: n0 }, { name: n1 }) =>
    n0.localeCompare(n1)
  )
  for (const entry of sorted) {
    const path = join(directory, entry.name)
    if (entry.isFile) {
      yield path
    } else if (entry.isDirectory) {
      yield* stableRecurseFiles(path)
    }
  }
}

/**
 * Converts a Sitemap array to an XML string in the required format.
 * @param sitemap - Array of sitemap entries
 * @returns Generated XML string
 */
function sitemapToXML(sitemap: Sitemap): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${
    sitemap
      .map(({ loc, lastmod }) =>
        `<url><loc>${loc}</loc><lastmod>${lastmod}</lastmod></url>`
      )
      .join('\n')
  }
</urlset>`
}
