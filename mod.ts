import { join, SEPARATOR } from 'jsr:@std/path@0.224.0'
import { ensureFile, exists } from 'jsr:@std/fs@0.224.0'

export interface SiteMapEntry {
  loc: string
  lastmod: string
}

export type Sitemap = SiteMapEntry[]

export interface SiteMapOptions {
  languages: string[]
  defaultLanguage: string
}

/**
 * Generates a sitemap XML for given directories and base URL.
 */
export async function generateSitemapXML(
  basename: string,
  distDirectory: string,
  articlesDirectory: string,
  options: SiteMapOptions,
): Promise<string> {
  const routesSitemap = await generateSitemap(basename, distDirectory, options)
  const articlesSitemap = await generateArticlesSitemap(
    basename,
    articlesDirectory,
    distDirectory,
    options,
  )
  const sitemap = [...routesSitemap, ...articlesSitemap]
  return sitemapToXML(sitemap)
}

/**
 * Generates the robots.txt file content.
 */
function generateRobotsTxt(domain: string): string {
  return `# *
User-agent: *
Allow: /

# Host
Host: https://${domain}

/* Sitemaps */
Sitemap: https://${domain}/sitemap.xml
`
}

/**
 * Saves the generated sitemap XML and robots.txt to the specified file paths.
 */
export async function saveSitemapAndRobots(
  basename: string,
  distDirectory: string,
  articlesDirectory: string,
  sitemapPath: string,
  robotsPath: string,
  options: SiteMapOptions,
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
 * Generates sitemap entries for static routes, including the mandatory [locale] directory.
 */
async function generateSitemap(
  basename: string,
  distDirectory: string,
  options: SiteMapOptions,
): Promise<Sitemap> {
  const sitemapSet = new Set<string>() // Unique paths for the final sitemap

  // Recursively collect all paths in the directory
  async function collectPaths(directory: string): Promise<void> {
    for await (const entry of Deno.readDir(directory)) {
      const entryPath = join(directory, entry.name)
      if (entry.isDirectory) {
        if (entry.name === '[locale]') {
          // Process each language directory within [locale]
          await processLocaleDirectory(entryPath)
        } else {
          await collectPaths(entryPath)
        }
      }
    }
  }

  // Process each language directory inside [locale]
  async function processLocaleDirectory(directory: string): Promise<void> {
    for await (const entry of Deno.readDir(directory)) {
      if (entry.isDirectory) {
        const lang = entry.name
        if (options.languages.includes(lang)) {
          await processLanguageRoutes(join(directory, lang), lang)
        }
      }
    }
  }

  // Process routes within a specific language directory
  async function processLanguageRoutes(
    directory: string,
    lang: string,
  ): Promise<void> {
    for await (const entry of Deno.readDir(directory)) {
      const entryPath = join(directory, entry.name)
      if (entry.isFile && entry.name.endsWith('.tsx')) {
        await processFile(entryPath, lang)
      } else if (entry.isDirectory) {
        await processLanguageRoutes(entryPath, lang)
      }
    }
  }

  // Process each .tsx file
  async function processFile(filePath: string, lang: string): Promise<void> {
    const relativePath = filePath.substring(distDirectory.length)
    const pathSegments = relativePath.split(SEPARATOR).filter(Boolean)

    // Exclude files starting with '_'
    if (pathSegments.some((segment) => segment.startsWith('_'))) {
      return
    }

    // Exclude dynamic routes (those with square brackets)
    if (
      pathSegments.some((segment) =>
        segment.includes('[') || segment.includes(']')
      )
    ) {
      return
    }

    const mtime = (await Deno.stat(filePath)).mtime ?? new Date()

    // Remove [locale] and language from path segments
    const urlSegments = pathSegments.slice(2)

    let urlPath = urlSegments.join('/')

    // Remove 'index' from the path
    urlPath = urlPath.replace(/index\.tsx$/, '')
    urlPath = urlPath.replace(/\.tsx$/, '')

    // Ensure the URL starts with '/'
    urlPath = '/' + urlPath

    // Remove any trailing slashes
    urlPath = urlPath.replace(/\/$/, '')

    // Build the full URL with language prefix
    const loc = basename.replace(/\/+$/, '') + `/${lang}` + urlPath

    // Add to the sitemap set
    sitemapSet.add(
      JSON.stringify({
        loc: loc,
        lastmod: mtime.toISOString(),
      }),
    )
  }

  await collectPaths(distDirectory)

  return Array.from(sitemapSet).map((entry) => JSON.parse(entry)) as Sitemap
}

/**
 * Generates sitemap entries for markdown articles, mapping to /[locale]/[...slug] routes.
 */
async function generateArticlesSitemap(
  basename: string,
  articlesDirectory: string,
  distDirectory: string,
  options: SiteMapOptions,
): Promise<Sitemap> {
  const sitemap: Sitemap = []

  if (!(await exists(articlesDirectory))) return sitemap

  // Check if there is a dynamic route that can handle the articles
  const dynamicRoutePath = findDynamicRoute(distDirectory)

  if (!dynamicRoutePath) {
    console.warn('Dynamic route for articles not found.')
    return sitemap
  }

  // Function to process each markdown file
  async function addMarkdownFile(path: string) {
    const relPath = path.substring(articlesDirectory.length).replace(
      /\.md$/,
      '',
    )
    const segments = relPath.split(SEPARATOR).filter(Boolean)
    const slug = segments.join('/')

    const mtime = (await Deno.stat(path)).mtime ?? new Date()

    // For each language, generate the URL
    for (const lang of options.languages) {
      // Construct the URL path as /[locale]/[...slug]
      const urlPath = `/${lang}/${slug}`

      sitemap.push({
        loc: basename.replace(/\/+$/, '') + urlPath,
        lastmod: mtime.toISOString(),
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
 * Finds the dynamic route file that can handle articles (e.g., [...slug].tsx)
 */
function findDynamicRoute(distDirectory: string): string | null {
  const dynamicRoutePattern = /\[\.\.\..*\]\.tsx$/

  // Use a stack for directories to process
  const directories = [distDirectory]
  while (directories.length > 0) {
    const currentDir = directories.pop()!
    for (const entry of Deno.readDirSync(currentDir)) {
      const entryPath = join(currentDir, entry.name)
      if (entry.isFile && dynamicRoutePattern.test(entry.name)) {
        // Found the dynamic route
        return entryPath
      } else if (entry.isDirectory) {
        directories.push(entryPath)
      }
    }
  }
  return null
}

/**
 * Recursively iterates through a directory to retrieve all file paths in a stable, sorted order.
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
