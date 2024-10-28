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
 * @param basename - The base URL of the website (e.g., 'https://example.com')
 * @param distDirectory - Directory containing route files
 * @param options - Options for sitemap generation, including languages and default language
 * @returns Array of sitemap entries
 */
async function generateSitemap(
  basename: string,
  distDirectory: string,
  options: SiteMapOptions,
): Promise<Sitemap> {
  const sitemapSet = new Set<string>() // Unique paths for the final sitemap
  const pathMap: Record<string, number> = {} // Store paths with a flag (1 for include, 0 for exclude)

  // Process each path segment without modifying it
  function processPathSegments(path: string): void {
    // Skip non-.tsx files
    if (!path.endsWith('.tsx')) return

    // Initialize path in the map with an inclusion flag
    pathMap[path] = 1

    // Exclude paths containing '_'
    if (path.includes('_')) {
      pathMap[path] = 0 // Set to 0 if the path contains '_'
      console.log(`Excluded due to _: ${path}`)
      return // Exit early if excluded
    }

    console.log(`Path added to pathMap: ${path}, pathMap state:`, pathMap)
  }

  // Recursively collect all paths in the directory
  async function addDirectory(directory: string) {
    for await (const path of stableRecurseFiles(directory)) {
      console.log('Processing path:', path)
      processPathSegments(path)
    }
  }

  function arrayToObject(arr: string[]): Record<string, number> {
    const result: Record<string, number> = {}

    for (const segment of arr) {
      result[segment] = 1 // Set each segment as a key with value 1
    }

    return result
  }

  function checkSegments(
    pathMap: Record<string, number>,
  ): Record<string, number> {
    for (const key in pathMap) {
      if (key.startsWith('(') && key.endsWith(')')) {
        pathMap[key] = 0
      }
      if (key === 'routes') {
        pathMap[key] = 0
      }
    }
    return pathMap
  }

  await addDirectory(distDirectory)
  console.log('Initial pathMap after processing all segments:', pathMap)

  // Populate sitemap entries based on pathMap
  for (const path in pathMap) {
    if (pathMap[path] === 1) {
      const filePath = join(path) // Use original path for checking
      if (!(await exists(filePath))) {
        console.log(`File not found, skipping: ${filePath}`)
        continue // Skip if file does not exist
      }
      const { mtime } = await Deno.stat(filePath)

      // Clean the path for the sitemap
      const pathSegments = path.split(SEPARATOR)

      const segCheckObj = arrayToObject(pathSegments)

      const checkedSegments = checkSegments(segCheckObj)

      const neededSegmentsPath = pathSegments
        .filter((segment) => checkedSegments[segment] === 1)
        .join('/')

      const cleanedPath = neededSegmentsPath.replace(/\/index\.tsx$/, '')

      // Add the cleaned path to the sitemap if valid
      if (cleanedPath) {
        sitemapSet.add(
          JSON.stringify({
            loc: basename + cleanedPath,
            lastmod: (mtime ?? new Date()).toISOString(),
          }),
        )

        // Handle language variations for the sitemap
        options.languages?.forEach((lang) => {
          if (lang !== options.defaultLanguage) {
            sitemapSet.add(
              JSON.stringify({
                loc: `${basename}/${lang}${cleanedPath}`,
                lastmod: (mtime ?? new Date()).toISOString(),
              }),
            )
          }
        })
      }
    }
  }

  console.log('Final Sitemap Set:', sitemapSet)

  return Array.from(sitemapSet).map((entry) => JSON.parse(entry)) as Sitemap
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
