import { globToRegExp, join, normalize, SEPARATOR } from 'jsr:@std/path@0.224.0'
import { ensureFile, exists } from 'jsr:@std/fs@0.224.0'

export interface SiteMapEntry {
  loc: string
  lastmod: string
}

export type Sitemap = SiteMapEntry[]

export interface SiteMapOptions {
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
 * Logs each processing step to help debug filtering issues.
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
  const sitemapSet = new Set<string>() // Collects unique paths
  const pathMap: Record<string, number> = {} // Records path flags

  // Logs each path segment during processing
  function processPathSegments(path: string): void {
    if (!path.endsWith('.tsx')) return
    const relPath = distDirectory === '.'
      ? path
      : path.substring(distDirectory.length)
    const segments = relPath.split(SEPARATOR).map((segment) =>
      segment.replace(/\.tsx$/, '')
    )
    const normalizedPath = `/${segments.join('/')}`

    // Ignore paths with `_` or `()` segments
    if (
      segments.some((segment) =>
        segment.startsWith('_') || segment.includes('(')
      )
    ) {
      pathMap[normalizedPath] = 0
      console.log(
        `Excluded by filter (_ or ()): ${normalizedPath}, pathMap state:`,
        pathMap,
      )
      return
    }

    // Initialize path in pathMap and log it
    pathMap[normalizedPath] = 1
    console.log(
      `Path added to pathMap: ${normalizedPath}, pathMap state:`,
      pathMap,
    )
  }

  // Retrieves all paths and processes each segment
  async function addDirectory(directory: string) {
    for await (const path of stableRecurseFiles(directory)) {
      processPathSegments(path)
    }
  }

  await addDirectory(distDirectory)

  console.log('Initial pathMap after processing all segments:', pathMap)

  // Remove `index` as the last segment and log any adjustments
  for (const path in pathMap) {
    if (pathMap[path] === 1) {
      const cleanedPath = path.replace(/\/index$/, '')
      if (cleanedPath !== path) {
        pathMap[cleanedPath] = 1
        delete pathMap[path]
        console.log(
          `Adjusted for index removal: ${cleanedPath}, pathMap state:`,
          pathMap,
        )
      }
    }
  }

  console.log('PathMap after index removal:', pathMap)

  // Add unique paths to the Sitemap array, logging each addition
  for (const path in pathMap) {
    if (pathMap[path] === 1) {
      const filePath = join(distDirectory, path)
      if (!(await exists(filePath))) {
        console.log(`File not found, skipping: ${filePath}`)
        continue
      }
      const { mtime } = await Deno.stat(filePath)
      const sitemapEntry = JSON.stringify({
        loc: basename + path,
        lastmod: (mtime ?? new Date()).toISOString(),
      })
      sitemapSet.add(sitemapEntry)
      console.log(`Added to sitemapSet: ${sitemapEntry}`)

      options.languages?.forEach((lang) => {
        if (lang !== options.defaultLanguage) {
          const langSitemapEntry = JSON.stringify({
            loc: `${basename}/${lang}${path}`,
            lastmod: (mtime ?? new Date()).toISOString(),
          })
          sitemapSet.add(langSitemapEntry)
          console.log(
            `Added to sitemapSet for language '${lang}': ${langSitemapEntry}`,
          )
        }
      })
    }
  }

  console.log('Final pathMap:', pathMap)
  console.log('Final Sitemap Set:', Array.from(sitemapSet))

  const sitemapArray = Array.from(sitemapSet).map((entry) =>
    JSON.parse(entry)
  ) as Sitemap
  console.log('Final Sitemap Array:', sitemapArray)

  return sitemapArray
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
