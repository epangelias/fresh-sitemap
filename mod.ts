import { join, normalize, SEPARATOR } from 'jsr:@std/path@0.224.0'
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
    if (key.startsWith('[') && key.endsWith(']')) {
      pathMap[key] = 0
    }
    if (key === 'routes') {
      pathMap[key] = 0
    }
  }
  return pathMap
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
      return // Exit early if excluded
    }
    if (path.includes('[...slug]')) {
      pathMap[path] = 0 // Set to 0 if the path contains '_'
      return // Exit early if excluded
    }
  }

  // Recursively collect all paths in the directory
  async function addDirectory(directory: string) {
    for await (const path of stableRecurseFiles(directory)) {
      processPathSegments(path)
    }
  }

  await addDirectory(distDirectory)

  // Populate sitemap entries based on pathMap
  for (const path in pathMap) {
    if (pathMap[path] === 1) {
      const filePath = join(path) // Use original path for checking
      if (!(await exists(filePath))) {
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

      const cleanedPath = neededSegmentsPath.replace(/\.tsx$/, '')
        .replace(/\index$/, '')

      options.languages?.forEach((lang) => {
        sitemapSet.add(
          JSON.stringify({
            loc: `${basename}/${lang}${cleanedPath}`,
            lastmod: (mtime ?? new Date()).toISOString(),
          }),
        )
      })
    }
  }

  return Array.from(sitemapSet).map((entry) => JSON.parse(entry)) as Sitemap
}

/**
 * Recursively searches for a folder with a specific name within a given directory or its subdirectories.
 * @param baseDirectory - The directory to start searching within
 * @param targetFolderName - The name of the folder to search for
 * @returns The path to the folder if it exists in any subdirectory, otherwise null
 */
async function findFolderPathRecursively(
  baseDirectory: string,
  targetFolderName: string,
): Promise<string | null> {
  for await (const entry of Deno.readDir(baseDirectory)) {
    const entryPath = `${baseDirectory}/${entry.name}`

    if (entry.isDirectory) {
      if (entry.name === targetFolderName) {
        return entryPath
      } else {
        const foundInSubDir = await findFolderPathRecursively(
          entryPath,
          targetFolderName,
        )
        if (foundInSubDir) return foundInSubDir
      }
    }
  }
  return null
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
    const removedLocaleSegments = relPath.split(SEPARATOR).splice(2, 1)
    console.log(removedLocaleSegments)
    const articleType = removedLocaleSegments[1]
    const articleRoute = await findFolderPathRecursively(
      articleType,
      articlesDirectory,
    )
    if (!articleRoute) return

    const routeSegments = articleRoute.split(SEPARATOR)

    const segCheckObj = arrayToObject(routeSegments)

    const checkedSegments = checkSegments(segCheckObj)

    const neededSegmentsPath = routeSegments
      .filter((segment) => checkedSegments[segment] === 1)
      .join('/')

    const pathname = neededSegmentsPath

    console.log(pathname)

    const urlPaths = languages.length > 0
      ? languages.map((
        lang,
      ) => `/${lang}${pathname}`)
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
