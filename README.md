# Redirect Loop Doctor

A free tool that finds why a site throws `ERR_TOO_MANY_REDIRECTS` (Chrome), "The page isn't redirecting properly" (Firefox), or `ERR_TOO_MANY_REDIRECTS` / a redirect loop error in any other browser, and gives the exact fix for the layer that's causing it: Cloudflare, your web server, your app framework, or your hosting platform's redirect rules.

Live: https://arling.sk/redirect-loop-doctor/

You describe your setup (Cloudflare or not and which SSL/TLS mode, what's in front of your app, whether WordPress is involved, whether you're on Vercel or Netlify, and what your redirect rules actually say), and the tool walks through the same layers a human would check by hand, in the order they're actually the cause most often, and tells you which one is looping and what to change.

## What it checks

Each item below is a documented cause of a redirect loop, verified against the vendor's own docs (see Sources).

- **Cloudflare SSL/TLS mode set to Flexible, origin also redirects HTTP to HTTPS.** Flexible mode means Cloudflare talks to your origin over plain HTTP, even though the visitor's connection to Cloudflare is HTTPS. If your origin server (nginx, Apache, your app) also force-redirects HTTP to HTTPS, it sees Cloudflare's HTTP request and 301s it, Cloudflare turns that into another HTTPS-to-your-visitor hop, and the origin sees plain HTTP again. Classic loop. Fix: switch the encryption mode to Full (strict) and install a certificate on the origin (Let's Encrypt or Cloudflare Origin CA), rather than removing the origin's HTTPS redirect.
- **Cloudflare's "Always Use HTTPS" is on while the encryption mode is Off.** The edge redirects every visitor to `https://`, but Off means neither hop, visitor-to-Cloudflare nor Cloudflare-to-origin, is actually encrypted, so the `https://` URL the edge just redirected to can't be served. Fix: raise the encryption mode to at least Flexible (Full/Full strict once the origin has a certificate).
- **App behind a reverse proxy or load balancer doesn't trust `X-Forwarded-Proto` and force-redirects to HTTPS unconditionally.** The proxy (nginx, a cloud load balancer, a tunnel) terminates TLS and forwards to the app over plain HTTP. If the app decides "this request is HTTP, redirect to HTTPS" without reading the forwarded-proto header, it redirects on every single request it ever receives from the proxy, because from the app's point of view every request really is HTTP. Fix is framework-specific:
  - **WordPress**: add an `HTTP_X_FORWARDED_PROTO` check to `wp-config.php`, setting `$_SERVER['HTTPS'] = 'on'` when the proxy reports `https`, before `wp-settings.php` loads.
  - **Laravel**: enable `Illuminate\Http\Middleware\TrustProxies` for the load balancer's IPs (or `'*'` behind a cloud LB with unknown IPs) and include `X-Forwarded-Proto` in the trusted headers.
  - **Django**: set `SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')`, only once the proxy is trusted to control that header itself.
  - **Rails**: `config.assume_ssl = true` (or confirm `ActionDispatch::SSL` reads the forwarded proto correctly) alongside `config.force_ssl = true`, with the load balancer listed in `config.action_dispatch.trusted_proxies`.
  - **nginx as the reverse proxy itself**: forward the real scheme with `proxy_set_header X-Forwarded-Proto $scheme;`, and never write `return 301 $scheme://...` on the plain-HTTP `server` block, since `$scheme` is always `http` there; hardcode `https://` on that redirect instead.
- **WordPress Address (URL) and Site Address (URL) mismatch.** Different schemes (one `http`, one `https`) or a stale `WP_HOME` / `WP_SITEURL` left in `wp-config.php` from a migration sends WordPress redirecting between the two values, neither of which matches what the visitor actually requested.
- **www and apex redirecting to each other.** A DNS/host-panel rule sends `www` to the apex domain while the app or a platform rule sends the apex back to `www` (or a CDN-level rule and a platform-level rule disagree about which is canonical). Each hop flips the host back.
- **Trailing-slash normalization loop.** A redirect rule that targets a URL that's equivalent to its own source once the platform's own URL normalization runs (Netlify's Pretty URLs, for instance) redirects to itself forever; trailing-slash differences can't be fixed with a redirect rule on these platforms, only with the platform's own normalization settings.
- **Cloudflare Page Rule / Redirect Rule that forwards to itself.** A rule whose source pattern has no scheme (matching both `http://` and `https://`) but whose destination is a hardcoded `https://` URL on the same host loops forever once the request is already `https://`, entirely inside Cloudflare, before it reaches your origin.

## What it does not do

- It does not call your site, so it cannot see your actual redirect chain, only what you tell it about your setup.
- It does not replace `curl -v -L` against your own URL. If you can run that, do it first; the output (each `Location:` header) is exactly what pins down which layer is looping.
- It does not send, store, or log your configuration anywhere. There is no account, no login, and no payment wall.
- It does not cover every CDN or hosting platform in existence, only the ones listed above; if your stack isn't there, the general "which layer forces HTTPS, and does the next layer undo it" logic still applies by hand.

## How it works

Everything runs in your browser. The page calls a single pure diagnosis function with the values you fill in and renders the result as a plain-language report. Nothing about your configuration is sent anywhere; the only network activity is loading the page's own static assets and anonymous Umami analytics events (see Privacy).

## Run locally

No build step, no dependencies.

```bash
git clone https://github.com/AndryRoby/redirect-loop-doctor.git
cd redirect-loop-doctor
python -m http.server
# or just open index.html directly in a browser
```

## Tests

```bash
node tests.mjs
```

## Privacy

Everything runs client-side; nothing you type into the form is sent anywhere, ever. Product analytics (page views, "run check" clicked) go to a self-hosted Umami instance with no cookies and no personal data, event name and count only. Joining the "tell me about new tools" email list on the page is entirely optional and separate from using the tool. Full policy: https://arling.sk/privacy/.

## Sources

The rules this tool checks are drawn from:

- Cloudflare: [Troubleshooting ERR_TOO_MANY_REDIRECTS](https://developers.cloudflare.com/ssl/troubleshooting/too-many-redirects/)
- Cloudflare: [SSL/TLS encryption modes](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/)
- WordPress: [Settings General screen (WordPress Address / Site Address)](https://wordpress.org/documentation/article/settings-general-screen/)
- WordPress core Trac: [#15733, WordPress behind a reverse proxy / SSL redirect loop](https://core.trac.wordpress.org/ticket/15733)
- nginx: [`$scheme` core variable](https://nginx.org/en/docs/http/ngx_http_core_module.html#var_scheme)
- nginx: [`proxy_set_header` directive](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header)
- Django: [`SECURE_PROXY_SSL_HEADER` setting](https://docs.djangoproject.com/en/stable/ref/settings/#secure-proxy-ssl-header)
- Laravel: [Configuring Trusted Proxies](https://laravel.com/docs/11.x/requests#configuring-trusted-proxies)
- Ruby on Rails: [Configuring Rails Applications (`force_ssl`, `assume_ssl`, `trusted_proxies`)](https://guides.rubyonrails.org/configuring.html)
- Vercel: [Configuration redirects](https://vercel.com/docs/routing/redirects/configuration-redirects)
- Netlify: [Redirect options](https://docs.netlify.com/manage/routing/redirects/redirect-options/)

## Report a problem

Found an `ERR_TOO_MANY_REDIRECTS` cause this tool doesn't catch, or a check that flags something that's actually fine? Open an issue: https://github.com/AndryRoby/redirect-loop-doctor/issues, or write to andrej@arling.sk. Please redact anything sensitive (real domains, internal IPs) before posting; issues are public.

## License

All rights reserved, see [LICENSE-NOTICE.md](LICENSE-NOTICE.md). Reading the source and learning from it is fine; deploying your own copy of it as a competing product is not.

---

ARLing s. r. o., Bratislava, Slovakia. andrej@arling.sk

Hub (more free tools): https://arling.sk/

Sibling tools:
- Google OAuth redirect_uri_mismatch: https://arling.sk/google-oauth-redirect-doctor/
- Supabase Auth on Expo / React Native: https://arling.sk/expo-supabase-auth-doctor/
- Supabase Auth on the web (Next.js / Vite / SvelteKit): https://arling.sk/supabase-redirect-doctor/
- Supabase Auth on Flutter: https://arling.sk/flutter-supabase-doctor/
- Expo Universal Links / App Links: https://arling.sk/expo-universal-links-doctor/
- SEPA pain.001 for Slovak banks: https://arling.sk/sepa-pain001-doctor/
- BookApp: https://arling.sk/bookapp/
