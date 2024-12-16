# Fresh Sitemap Plugin

This plugin generates a sitemap for a Deno Fresh v2 project. It scans the routes
and articles directories to generate an XML sitemap, supporting multiple
languages and a default language without a language prefix.

## Features

- **Automatic Sitemap Generation**: Scans the `routes` and `articles`
  directories for valid pages.
- **Multi-language Support**: Specify an array of languages; the default
  language is included without a language prefix.
- **Customizable Options**: Choose to include/exclude files based on glob
  patterns and remove .html extensions if desired.

## Installation and Usage

1. **Install the Plugin**

   Import the functions from the module to use within your Fresh project.

   ```typescript
   import { saveSitemapAndRobots } from 'jsr:@elsoul/fresh-sitemap'
   ```

2. **Run the Plugin**

   Use the `saveSitemap` function in your build script to generate `sitemap.xml`
   after your Fresh routes and articles are compiled.

   ```typescript
   // Example usage
   await saveSitemapAndRobots({
     basename: `https://${appInfo.domain}`,
     distDirectory: 'routes',
     postsDirectory: 'posts',
     sitemapPath: 'static/sitemap.xml',
     robotsPath: 'static/robots.txt',
     options: { languages: ['en', 'ja'], defaultLanguage: 'en' },
   })
   ```

**Options**

- `languages`: Array of languages, such as `["en", "ja"]`.
- `defaultLanguage`: Default Language.

## Contributing

Bug reports and pull requests are welcome on GitHub at
https://github.com/elsoul/fresh-sitemap. This project is intended to be a safe,
welcoming space for collaboration, and contributors are expected to adhere to
the [Contributor Covenant](http://contributor-covenant.org) code of conduct.

## License

The package is available as open source under the terms of the
[Apache-2.0 License](https://www.apache.org/licenses/LICENSE-2.0).

## Code of Conduct

Everyone interacting in the SKEET project’s codebases, issue trackers, chat
rooms, and mailing lists is expected to follow the
[code of conduct](https://github.com/elsoul/skeet/blob/master/CODE_OF_CONDUCT.md).
