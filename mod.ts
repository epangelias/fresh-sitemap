import { join, SEPARATOR } from 'jsr:@std/path@0.224.0'
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
 * Generates a sitemap XML string from specified directories and a base URL.
 * @param basename - The base URL of the website (e.g., 'https://example.com')
 * @param distDirectory - The directory containing route files
 * @param articlesDirectory - The directory containing articles in markdown format
 * @param options - Options for sitemap generation, including languages and default language
 * @returns The generated sitemap as an XML string
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
 * Generates content for the robots.txt file, including site and sitemap details.
 * @param domain - The domain of the website (e.g., 'example.com')
 * @returns The generated robots.txt file content
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
 * Saves the generated sitemap XML and robots.txt files to specified file paths.
 * @param basename - The base URL of the website
 * @param distDirectory - The directory containing route files
 * @param articlesDirectory - The directory containing articles
 * @param sitemapPath - Path where sitemap.xml will be saved
 * @param robotsPath - Path where robots.txt will be saved
 * @param options - Options for sitemap generation, including languages and default language
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
 * Converts an array of strings to an object where each string becomes a key with a default value of 1.
 * @param arr - Array of strings
 * @returns Object with each string in arr as a key set to 1
 */
function arrayToObject(arr: string[]): Record<string, number> {
  const result: Record<string, number> = {}

  for (const segment of arr) {
    result[segment] = 1
  }

  return result
}

/**
 * Filters path segments based on specific criteria for sitemap inclusion.
 * Sets the value to 0 for paths containing grouping indicators like parentheses or square brackets.
 * @param pathMap - Object containing path segments with inclusion flags
 * @returns Filtered pathMap with updated inclusion flags
 */
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
  const sitemapSet = new Set<string>()
  const pathMap: Record<string, number> = {}

  // Processes each path segment without modification
  function processPathSegments(path: string): void {
    if (!path.endsWith('.tsx')) return

    pathMap[path] = 1

    if (path.includes('_')) {
      pathMap[path] = 0
      return
    }
    if (path.includes('[...slug]')) {
      pathMap[path] = 0
      return
    }
  }

  async function addDirectory(directory: string) {
    for await (const path of stableRecurseFiles(directory)) {
      processPathSegments(path)
    }
  }

  await addDirectory(distDirectory)

  for (const path in pathMap) {
    if (pathMap[path] === 1) {
      const filePath = join(path)
      if (!(await exists(filePath))) {
        continue
      }
      const { mtime } = await Deno.stat(filePath)

      const pathSegments = path.split(SEPARATOR)

      const segCheckObj = arrayToObject(pathSegments)
      const checkedSegments = checkSegments(segCheckObj)

      const neededSegmentsPath = pathSegments
        .filter((segment) => checkedSegments[segment] === 1)
        .join('/')

      const cleanedPath = neededSegmentsPath.replace(/\.tsx$/, '').replace(
        /\index$/,
        '',
      )

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
    const relPath = path.replace(/\.md$/, '')
    const segments = relPath.split(SEPARATOR)
    const articleType = segments[1]
    const articleRoute = await findFolderPathRecursively(
      './routes',
      articleType,
    )
    if (!articleRoute) return

    const routeSegments = articleRoute.replace('./routes', '').split(
      SEPARATOR,
    )

    const segCheckObj = arrayToObject(routeSegments)
    const checkedSegments = checkSegments(segCheckObj)

    const neededSegmentsPath = routeSegments
      .filter((segment) => checkedSegments[segment] === 1)
      .join('/')

    const slugSegmentsPath = segments.slice(3).join('/')
    const pathname = neededSegmentsPath + '/' + slugSegmentsPath

    const urlPaths = languages.length > 0
      ? languages.map((lang) => `/${lang}${pathname}`)
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
