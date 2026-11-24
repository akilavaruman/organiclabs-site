# Organic Labs: services and free tools

Static pages for organiclabs.ai, ready for GitHub Pages.

- `/services/` services hub, plus AI search optimization, SaaS SEO consultant, fractional SEO consultant and B2B SEO audit
- `/tools/` free tools hub, plus six free tools
- `/` redirects to `/services/`

## Publish on GitHub Pages

1. Push this folder to a repository.
2. In the repository: Settings > Pages > Build and deployment > Source: "Deploy from a branch", Branch: `main`, folder `/ (root)`.
3. The site appears at `https://<user>.github.io/<repo>/` within a minute or two.

## Notes

- Links between pages in this repo are rewritten to work on GitHub Pages. Links to pages that only exist on organiclabs.ai (research, case studies, work with us, full-service SEO, SEO content marketing) still point there.
- Canonical tags point to organiclabs.ai, so search engines treat organiclabs.ai as the main version.
- Tool features that fetch other websites (schema validator URL check, llms.txt sitemap reading, FAQ drafting from a URL, meta description URL check) and the email forms need a small server function. Everything else runs in the browser.
