import { globToRegExp, join, normalize, SEPARATOR } from 'jsr:@std/path@0.224.0'
import { ensureFile, exists } from 'jsr:@std/fs@0.224.0'

export interface SiteMapEntry {
  loc: string
  lastmod: string
}

export type Sitemap = SiteMapEntry[]

export interface SiteMapOptions {
  include?: string
  exclude?: string
  languages?: string[]
  defaultLanguage?: string
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
 * Generates the robots.txt file content.
 * @param domain - The domain of the website (e.g., 'example.com')
 * @returns Generated robots.txt content
 */
function generateRobotsTxt(domain: string): string {
  return `# *
User-agent: *
Allow: /

# Host
Host: https://${domain}

# Sitemaps
Sitemap: https://${domain}/sitemap.xml
`
}

/**
 * Saves the generated sitemap XML and robots.txt to the specified file paths.
 * @param basename - The base URL of the website
 * @param distDirectory - Directory containing route files
 * @param articlesDirectory - Directory containing articles
 * @param sitemapPath - Path where sitemap.xml will be saved
 * @param robotsPath - Path where robots.txt will be saved
 * @param options - Options for sitemap generation
 */
export async function saveSitemapAndRobots(
  basename: string,
  distDirectory: string,
  articlesDirectory: string,
  sitemapPath: string,
  robotsPath: string,
  options: SiteMapOptions = {},
): Promise<void> {
  const domain = new URL(basename).hostname
  const sitemapXML = await generateSitemapXML(
    basename,
    distDirectory,
    articlesDirectory,
    options,
  )
  const robotsTxt = generateRobotsTxt(domain)

  await ensureFile(sitemapPath)
  await Deno.writeTextFile(sitemapPath, sitemapXML)

  await ensureFile(robotsPath)
  await Deno.writeTextFile(robotsPath, robotsTxt)
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
  const sitemapSet = new Set<string>() // To store unique paths
  const sitemap: Sitemap = []
  const include = options.include ? globToRegExp(options.include) : null
  const exclude = options.exclude ? globToRegExp(options.exclude) : null

  // Helper function to process and filter each path segment-wise as an object
  function processPathSegments(relPath: string): string | null {
    const segments = relPath.split(SEPARATOR).map((segment) => {
      // Ignore entire path if any segment starts with '_' or contains '_'
      if (segment.includes('_')) {
        return null
      }
      // Remove .tsx extension for remaining segments
      return segment.endsWith('.tsx') ? segment.slice(0, -4) : segment
    }).filter(Boolean) as string[] // Filter out null segments

    if (segments.length === 0) return null

    // Reconstruct the valid segments to a path
    const pathname = normalize(`/${segments.join('/')}`)

    // Check inclusion/exclusion conditions if provided
    if (
      (exclude instanceof RegExp && exclude.test(pathname)) ||
      (include instanceof RegExp && !include.test(pathname))
    ) {
      return null
    }
    return pathname
  }

  // Collect and process paths by directory
  async function addDirectory(directory: string) {
    for await (const path of stableRecurseFiles(directory)) {
      // Process only .tsx files
      if (!path.endsWith('.tsx')) continue
      const relPath = distDirectory === '.'
        ? path
        : path.substring(distDirectory.length)
      const pathname = processPathSegments(relPath)
      if (!pathname) continue // Skip if pathname is null

      const { mtime } = await Deno.stat(path)
      // Store each path as a unique JSON string
      sitemapSet.add(
        JSON.stringify({
          loc: basename + pathname,
          lastmod: (mtime ?? new Date()).toISOString(),
        }),
      )

      // Add paths for each specified language
      options.languages?.forEach((lang) => {
        if (lang !== options.defaultLanguage) {
          sitemapSet.add(
            JSON.stringify({
              loc: `${basename}/${lang}${pathname}`,
              lastmod: (mtime ?? new Date()).toISOString(),
            }),
          )
        }
      })
    }
  }

  await addDirectory(distDirectory)

  // Convert set entries back to objects for the final sitemap array
  for (const entry of sitemapSet) {
    sitemap.push(JSON.parse(entry))
  }

  return sitemap
}

/**
 * Generates sitemap entries for markdown articles, respecting language settings.
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

  if (!(await exists(articlesDirectory))) return sitemap

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
      ? languages.map((
        lang,
      ) => (lang === options.defaultLanguage
        ? pathname
        : `/${lang}${pathname}`)
      )
      : [pathname]

    for (const urlPath of urlPaths) {
      const { mtime } = await Deno.stat(path)
      sitemap.push({
        loc: basename.replace(/\/+$/, '') + urlPath,
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
