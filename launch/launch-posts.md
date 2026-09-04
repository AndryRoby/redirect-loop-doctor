# Launch posts, Redirect Loop Doctor

Research date: 2026-09-06. Tool: https://arling.sk/redirect-loop-doctor/

Method: GitHub REST search API (`api.github.com/search/issues`) for the error
strings and framing this tool covers (`ERR_TOO_MANY_REDIRECTS`, `X-Forwarded-Proto`
+ "redirect loop", "too many redirects" + nginx/cloudflare/wordpress/vercel/netlify),
plus direct issue and comment fetches to read full context. Stack Overflow was not
queried, per instructions. Every thread below was actually fetched; nothing here is
invented. Dates are UTC, from each thread's own API data.

**Rule applied:** closed issue with its last activity more than 12 months ago
skip. Open issues/threads judged on relevance and whether a reply would look
welcome (a live troubleshooting thread with the root cause still unknown) versus
unwelcome (an internal task tracker on the reporter's own infrastructure, or a case
the OP already root-caused alone).

---

## 1. Findings

### 1.1 Broad search: `ERR_TOO_MANY_REDIRECTS is:issue`, sorted by updated

| Repo / issue | State | Last activity (UTC) | Recommendation |
|---|---|---|---|
| [supabase/supabase#49847](https://github.com/supabase/supabase/issues/49847) — "Dashboard sign-in impossible: auth.supabase.io/auth/v1/authorize answers 301 to itself" | open, 12 comments | 2026-09-03 | Skip — verified in full. This is Supabase's own auth-gateway infrastructure looping on its own domain (a stale `NEXT_PUBLIC_GOTRUE_URL` env var pointing Studio at a retired subdomain), not a site owner's Cloudflare/nginx/WordPress config. Supabase's own engineers are already mid-investigation in the thread; an outside tool link would be noise on a vendor incident, not help. |
| [Untrivial-ai/agent-orchestrator#2817](https://github.com/Untrivial-ai/agent-orchestrator/issues/2817) — "Landing page footer doc links cause ERR_TOO_MANY_REDIRECTS" | closed | 2026-09-03 | Skip — closed. |
| [ikhsan3adi/absensi-sekolah-qr-code#234](https://github.com/ikhsan3adi/absensi-sekolah-qr-code/issues/234) — "[BUG] - ERR_TOO_MANY_REDIRECTS" | open, 0 comments | 2026-08-30 | Skip — verified in full: OP already root-caused it themselves (a CodeIgniter `URIProtocol` setting, `PATH_INFO` vs `REQUEST_URI`) and documented the fix in the same report. Nothing left to add. |

### 1.2 Targeted search: `"X-Forwarded-Proto" "redirect loop" is:issue`

| Repo / issue | State | Last activity | Recommendation |
|---|---|---|---|
| [pgadmin-org/pgadmin4#10334](https://github.com/pgadmin-org/pgadmin4/issues/10334) — "Unable to run pgadmin4 web version with reverse proxy using Caddy" | open, 19 comments | 2026-09-03 | Not checked in depth — Caddy-specific, and pgAdmin isn't one of the stacks this tool gives an exact fix for; a generic reply would be weaker than what the thread's own maintainers are already providing. |
| [pkp/pkp-lib#6851](https://github.com/pkp/pkp-lib/issues/6851) — "Let OJS honor HTTP_X_FORWARDED_PROTO instead of trying to discover it" | open, 21 comments | 2026-08-31 | Skip — verified in full. A maintainer-filed feature request (label `Housekeeping:1:Todo`, open since 2021) to add proxy-header support to OJS core itself. It's a roadmap item for the project, not a user asking for help diagnosing their own instance right now. |

### 1.3 Targeted search: `"too many redirects" nginx is:issue is:open`, `"redirect loop" vercel is:issue`, `"redirect loop" netlify is:issue`, `"Flexible" cloudflare "redirect loop" is:issue`

| Repo / issue | State | Last activity | Recommendation |
|---|---|---|---|
| [AudioBooth/AudioBooth#348](https://github.com/AudioBooth/AudioBooth/issues/348) — "Too many http redirect" | **open**, 1 comment | 2026-08-31 | **Post** (see 2.1). Live, unresolved, small repo, exactly the failure mode this tool targets. |
| [NginxProxyManager/nginx-proxy-manager#3365](https://github.com/NginxProxyManager/nginx-proxy-manager/issues/3365) — "force ssl with cloudflared not working" | open, 13 comments | 2026-08-17 | Skip — verified in full. Real thread on exactly this pattern (nginx's `force-ssl.conf` checks `$scheme` instead of `$http_x_forwarded_proto` behind `cloudflared`), but the root cause was already identified by the community back in 2024 (`realies`, comment 3) and the maintainer (`jc21`) is mid-testing a code fix in a dev build as of January 2026. Two automated "stale" bot notices since. A tool-link reply now would land on a software bug tracker mid-fix, not a user stuck without a diagnosis. |
| [PipraPay/PipraPay#42](https://github.com/PipraPay/PipraPay/issues/42) — "Infinite redirect loop on /login under nginx" | open, 0 comments | 2026-06-09 | Skip — verified in full. OP already fully root-caused it themselves (an `.htaccess` rewrite rule that only works under Apache `mod_rewrite`, proven with two `curl` calls) and filed it as a bug report for the maintainers to patch in code. Nothing to add. |
| [performant-software/core-data-places#786](https://github.com/performant-software/core-data-places/issues/786) — "redirect.ts loops when PUBLIC_DOMAIN and ADMIN_DOMAIN are the same host, or when the public domain is the netlify.app name" | open, 0 comments | 2026-09-02 | Skip — verified in full. Maintainer's own internal task on their own production migration (`jamiefolsom`, references their own `gwc.performant.studio` cutover), already fully diagnosed with a suggested code fix attached. Internal backlog item, not a public question. |
| [survos/docker#7](https://github.com/survos/docker/issues/7) — "Cloudflare Flexible SSL on packages/zm/kpa: apps publish http:// URLs behind HTTPS" | open, 0 comments | 2026-08-18 | Skip — verified in full. Maintainer's own infrastructure issue (`tacman`, own `survos.com` subdomains, own `dokku` deploy commands), already root-caused (Cloudflare Flexible mode + Symfony `trusted_proxies` correctly trusting an honestly-reported `http`) with the fix specified. Internal task, not a question. |
| [cloudflare/cloudflared#1720](https://github.com/cloudflare/cloudflared/issues/1720) — "cloudflared 2026.8.0 breaks reverse-proxied app with self-redirect loop" | open, 1 comment | 2026-08-23 | Skip — verified in full. A `cloudflared` version regression (rolling back to the prior release fixed it immediately); the cause is a bug in the tunnel client itself, not a config layer this tool diagnoses. |

### 1.4 Targeted search: `wordpress "ERR_TOO_MANY_REDIRECTS" is:issue`

Dominated by unrelated matches (a security-scoped issue, weekly bot-generated
audit reports, closed issues from 2025 and earlier). The closest genuine
WordPress-plus-redirect-loop threads found (`Automattic/wp-codebox#2178`,
`bonny/WordPress-Simple-History#639`, `roots/trellis#1594`, `coollabsio/coolify#5218`,
`getdokan/dokan#2413`) are all **closed**, most more than 12 months inactive.
No open WordPress-specific candidate this round.

**Stack Overflow:** not queried, per instructions.

---

## 2. Drafted reply (first person, as Andrej)

Post only where the thread is still open for replies. Ends with exactly one
sentence pointing at the tool.

### 2.1 -> https://github.com/AudioBooth/AudioBooth/issues/348

> Same shape as most "too many redirects behind a Cloudflare Tunnel" cases I've seen: the tunnel is doing the HTTP-to-HTTPS redirect at the edge like you said, but if nginx (or whatever's sitting between the tunnel and the Docker container) *also* has its own force-https rule, that's the loop. Two things worth checking, in order:
>
> 1. Curl the app directly on your internal nginx, not through the tunnel: `curl -v http://internal-host/` and see if nginx itself answers with a 301 to `https://`. If it does, that's a second redirect layer fighting the tunnel's, since cloudflared already terminates TLS and forwards to nginx over plain HTTP internally, which is completely normal, and nginx redirecting that plain-HTTP request straight back to HTTPS is what loops.
> 2. If nginx is meant to trust the tunnel for the scheme, check whether its force-ssl logic reads `$scheme` (which is always `http` on that internal hop) instead of the `X-Forwarded-Proto` header the tunnel sets; that exact bug has shown up in a few reverse-proxy setups in front of cloudflared for the same reason.
>
> If it's not nginx at all and it's audiobookshelf's own base-URL / reverse-proxy setting redirecting once more on top of both of those, that'd be a third layer doing the same thing.
>
> I put together a small free tool that walks through exactly this stack of layers (Cloudflare, the proxy in front, the app itself) and points at which one's still looping: https://arling.sk/redirect-loop-doctor/

---

## 3. Facts for the owner's own post (8 points)

1. Free tool, no signup, no payment wall: paste your setup, get the exact layer causing `ERR_TOO_MANY_REDIRECTS` and the fix, live at https://arling.sk/redirect-loop-doctor/.
2. Covers 8 documented causes across 3 layers: the CDN/edge (Cloudflare SSL/TLS modes, Always Use HTTPS, HSTS), the app/framework (WordPress, Laravel, Django, Rails, plus nginx acting as the reverse proxy itself), and the hosting platform (WordPress siteurl mismatches, www/apex conflicts, Vercel/Netlify redirect rules).
3. Every rule is sourced from the vendor's own documentation, 11 official pages cited: 2 from Cloudflare, 2 from WordPress.org (plus a WordPress core Trac ticket), 2 from nginx.org, one each from Django, Laravel, Ruby on Rails, Vercel, and Netlify.
4. 100% client-side: one HTML page, one dependency-free JavaScript engine, no backend, no account, nothing typed into the form is ever sent anywhere.
5. Built and shipped in a single day, 2026-09-06, the sixth tool in the "Doctor" family after the Google OAuth redirect_uri_mismatch checker, three Supabase Auth variants (web, Expo, Flutter), and the Expo Universal Links checker.
6. Source code is public on GitHub (https://github.com/AndryRoby/redirect-loop-doctor); hosted use is free for any purpose, reading the source to verify what it does is welcome, rehosting it as a competing product is not.
7. The only analytics are anonymous event counts on a self-hosted Umami instance, no cookies, no personal data; full privacy policy at https://arling.sk/privacy/.
8. While researching launch threads, found a live, still-unresolved GitHub issue (AudioBooth, opened August 2026) hitting exactly this failure mode, a Cloudflare Tunnel doing the HTTPS redirect at the edge while nginx behind it redirects again, confirming the problem this tool targets is actively tripping people up right now, not a solved-and-forgotten one.

---

## 4. Article outline (dev.to)

**Working title:** *ERR_TOO_MANY_REDIRECTS: the layer that's actually looping, not just "check your SSL settings"*

1. **The hook.** The browser error tells you there's a loop, never which of the (often three or four) layers between the visitor and your app is causing it. This is a checklist for finding that layer fast, ranked by how often each one turns out to be the real cause.
2. **Why it's a loop and not just a redirect.** A single HTTP-to-HTTPS redirect is normal and not a bug. A loop specifically means two layers each independently decide "this request is in the wrong scheme" and hand it back to the other, forever, each individually behaving "correctly" from its own point of view.
3. **The CDN/edge layer, Cloudflare specifically.** Flexible mode plus an origin that force-redirects HTTP to HTTPS, the single most common cause; Always Use HTTPS plus an origin that redirects HTTPS back to HTTP; HSTS plus encryption mode Off. Cite: `developers.cloudflare.com/ssl/troubleshooting/too-many-redirects/`, `developers.cloudflare.com/ssl/origin-configuration/ssl-modes/`.
4. **The proxy/load-balancer layer.** TLS terminated upstream, forwarded to the app over plain HTTP (completely normal), the app force-redirects because it doesn't trust `X-Forwarded-Proto`. One code snippet per stack: WordPress (`wp-config.php`), Laravel (`TrustProxies`), Django (`SECURE_PROXY_SSL_HEADER`), Rails (`assume_ssl`), and nginx-as-the-proxy's own `$scheme`-vs-`X-Forwarded-Proto` trap. Cite: `nginx.org` (`$scheme`, `proxy_set_header`), `docs.djangoproject.com`, `laravel.com/docs`, `guides.rubyonrails.org`.
5. **The app-config layer.** WordPress Address (URL) vs Site Address (URL) mismatches and stale `WP_HOME`/`WP_SITEURL` constants from a migration. Cite: `wordpress.org/documentation/article/settings-general-screen/`, WordPress core Trac #15733.
6. **The platform-rules layer.** www/apex fighting each other; Netlify's trailing-slash normalization (a redirect rule can't add or remove a trailing slash, only Pretty URLs can); a Vercel/Netlify rule whose destination lands back on its own source. Cite: `docs.netlify.com/manage/routing/redirects/redirect-options/`, `vercel.com/docs/routing/redirects/configuration-redirects`.
7. **The five-minute manual diagnosis.** `curl -v -L` against your own URL, read every `Location:` header in order, that sequence of hops is the actual loop, not what a cached browser tab is showing you.
8. **The checklist, or the free tool that automates asking the right question at each layer** (link at the end, not before): https://arling.sk/redirect-loop-doctor/
9. **Sources.** Link every official doc cited in steps 3 through 6, so the article holds up to scrutiny on its own.
