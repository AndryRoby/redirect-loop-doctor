// doctor-loop.js: Redirect Loop Doctor (ERR_TOO_MANY_REDIRECTS) core logic.
//
// Pure, deterministic, 100% client-side: given the URL that loops, an
// optional pasted redirect chain (curl -IL output, or a list of Location:
// headers / bare URLs from a browser's Network tab), your Cloudflare
// SSL/TLS settings, your web server's HTTPS/www behaviour, and your app's
// site URL / HTTPS / trailing-slash settings, finds the pair of rules that
// are fighting each other and reports the exact fix.
//
// Nothing in this file makes a network request. It never fetches the URL
// you're diagnosing; it only reads the object (and pasted text) you pass to
// diagnose().
//
// Rules implemented here are sourced from:
//  - https://developers.cloudflare.com/ssl/troubleshooting/too-many-redirects/
//      ("When encryption is set to Flexible, Cloudflare sends unencrypted
//      requests to your origin server over HTTP." A loop forms if the origin
//      then redirects that HTTP request back to HTTPS; fix: "remove HTTPS
//      redirects from your origin server or update your SSL/TLS Encryption
//      Mode to be Full or higher." Conversely with Full/Full (strict), "if
//      your origin redirects all HTTPS requests back to HTTP" a loop forms
//      the other way. "Always Use HTTPS... redirects all http requests to
//      https for all subdomains and hosts": if the origin then downgrades
//      back to HTTP, that loops too. "Redirect loops can also occur if you
//      have conflicting URL redirects": review Page Rules / Redirect Rules.)
//  - https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/
//      (the four SSL/TLS modes: Off = no encryption on either hop; Flexible
//      = visitor-to-Cloudflare can be HTTPS, Cloudflare-to-origin is always
//      HTTP; Full = Cloudflare-to-origin is HTTPS but the origin's
//      certificate isn't validated; Full (strict) = same, but the origin
//      certificate must be valid/trusted. Cloudflare "strongly recommends"
//      Full or Full (strict).)
//  - https://nginx.org/en/docs/http/ngx_http_core_module.html#var_scheme
//      ($scheme reflects the scheme of the connection nginx itself received,
//      not the original client connection: behind a proxy/load balancer that
//      terminates TLS, nginx sees plain HTTP even for an originally-HTTPS
//      visit, so `if ($scheme = "http") { return 301 https://...; }` loops
//      forever unless it instead checks $http_x_forwarded_proto.)
//  - https://docs.djangoproject.com/en/5.2/ref/settings/#secure-proxy-ssl-header
//      ("If turning SECURE_SSL_REDIRECT to True causes infinite redirects,
//      it probably means your site is running behind a proxy and can't tell
//      which requests are secure. Your proxy likely sets a header to
//      indicate secure requests; you can correct the problem by configuring
//      SECURE_PROXY_SSL_HEADER appropriately", e.g.
//      SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https"), and
//      only when the proxy strips/sets that header itself.)
//  - https://laravel.com/docs/11.x/requests#configuring-trusted-proxies
//      (behind a TLS-terminating load balancer, Laravel "does not know it
//      should generate secure links" unless the TrustProxies middleware is
//      configured via ->withMiddleware(fn ($m) => $m->trustProxies(at: [...],
//      headers: Request::HEADER_X_FORWARDED_PROTO | ...)) in bootstrap/app.php.)
//  - https://vercel.com/docs/routing/redirects
//      (domain-level www-to-apex/apex-to-www redirects are configured once,
//      centrally, in the Domains dashboard; "Prioritize HTTPS: use redirects
//      to enforce HTTPS for all requests to your domain" is meant to be the
//      only layer doing that job.)
//  - https://docs.netlify.com/manage/routing/redirects/rewrites-proxies/
//      ("Infinitely looping rules, where the 'from' and 'to' resolve to the
//      same location, are incorrect and will be ignored" by Netlify itself,
//      i.e. Netlify's own redirect engine can't loop on itself; a loop
//      reported for a Netlify site therefore always involves the app's own
//      redirect logic or an upstream proxy, not netlify.toml alone.)
//
// Works as an ES module (import { diagnose, expectedValues } from
// './doctor-loop.js') and, when loaded with <script type="module">, also
// publishes window.RedirectLoopDoctor = { diagnose, expectedValues } for
// console/debug use.

// ───────────────────────── small string helpers ─────────────────────────

function safeStr(v) {
  return typeof v === 'string' ? v : '';
}

function trimTrailingSlash(s) {
  return safeStr(s).trim().replace(/\/+$/, '');
}

function stripWww(host) {
  return safeStr(host).replace(/^www\./i, '');
}

function hasWww(host) {
  return /^www\./i.test(safeStr(host));
}

// ───────────────────────── URL parsing ─────────────────────────

function parseUri(raw) {
  const s = safeStr(raw).trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    return {
      raw: s,
      scheme: u.protocol.replace(/:$/, '').toLowerCase(),
      host: u.hostname.toLowerCase(),
      port: u.port || '',
      path: u.pathname || '/',
      search: u.search || '',
      hash: u.hash || '',
      invalid: false,
    };
  } catch (e) {
    return { raw: s, invalid: true };
  }
}

function hopKey(p) {
  return `${p.scheme}://${p.host}${p.port ? ':' + p.port : ''}${p.path}${p.search}`;
}

// Compares two successive hops and explains what changed between them.
function compareHops(a, b) {
  const diffs = [];
  if (a.scheme !== b.scheme) {
    diffs.push({ type: 'scheme', detail: `scheme flips from "${a.scheme}" to "${b.scheme}"` });
  }
  if (a.host !== b.host) {
    if (stripWww(a.host) === stripWww(b.host)) {
      diffs.push({ type: 'www_apex', detail: `host flips from "${a.host}" to "${b.host}": a www vs. apex mismatch` });
    } else {
      diffs.push({ type: 'host', detail: `host changes from "${a.host}" to "${b.host}"` });
    }
  }
  const aNoSlash = a.path.replace(/\/+$/, '') || '/';
  const bNoSlash = b.path.replace(/\/+$/, '') || '/';
  const aTrail = a.path.endsWith('/') && a.path !== '/';
  const bTrail = b.path.endsWith('/') && b.path !== '/';
  if (aNoSlash === bNoSlash && aTrail !== bTrail) {
    diffs.push({ type: 'trailing_slash', detail: `path flips between "${a.path}" and "${b.path}": a trailing-slash mismatch` });
  } else if (aNoSlash !== bNoSlash) {
    diffs.push({ type: 'path', detail: `path changes from "${a.path}" to "${b.path}"` });
  }
  if (a.search !== b.search) {
    diffs.push({ type: 'query', detail: `query string changes from "${a.search || '(none)'}" to "${b.search || '(none)'}"` });
  }
  return diffs;
}

function dominantDiffType(diffs) {
  const order = ['scheme', 'www_apex', 'trailing_slash', 'host', 'path', 'query'];
  for (const t of order) if (diffs.some((d) => d.type === t)) return t;
  return null;
}

// ───────────────────────── redirect-chain parsing ─────────────────────────
// Accepts curl -IL output (status lines + "Location: <url>" headers) or a
// plain list of URLs, one per line (e.g. copy-pasted from a browser's
// Network tab). Anything else on a line is ignored.

function parseChainText(text, seedUrl) {
  const hops = [];
  const seed = parseUri(seedUrl);
  if (seed && !seed.invalid) hops.push(seed);

  const lines = safeStr(text).split(/\r?\n/);
  const statusCodes = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const statusMatch = /^HTTP\/\S+\s+(\d{3})/i.exec(line);
    if (statusMatch) {
      statusCodes.push(Number(statusMatch[1]));
      continue;
    }
    let candidate = null;
    const locMatch = /^location\s*:\s*(.+)$/i.exec(line);
    if (locMatch) {
      candidate = locMatch[1].trim();
    } else if (/^https?:\/\//i.test(line)) {
      candidate = line;
    }
    if (!candidate) continue;
    candidate = candidate.replace(/^['"`]+|['"`]+$/g, '');
    const parsed = parseUri(candidate);
    if (parsed && !parsed.invalid) hops.push(parsed);
  }
  return { hops, statusCodes };
}

// Finds the first exact repeat in a hop sequence: the smallest (j, i) with
// j < i and hops[j] === hops[i] (same scheme+host+port+path+query). That
// range is the loop.
function findCycle(hops) {
  const seen = new Map();
  for (let i = 0; i < hops.length; i++) {
    const key = hopKey(hops[i]);
    if (seen.has(key)) {
      return { j: seen.get(key), i };
    }
    seen.set(key, i);
  }
  return null;
}

// ───────────────────────── Cloudflare Page Rule / Redirect Rule heuristic ─────────────────────────
// Classic self-loop shape: a Forwarding URL / Redirect Rule whose SOURCE
// pattern has no scheme (so it matches both http:// and https:// requests)
// but whose DESTINATION is hard-coded to https:// the same host. A request
// that is already https:// matches the rule again and gets "forwarded" to
// the exact same URL, forever. A source that already starts with http://
// (correctly scoped to only the insecure request) does not have this bug.
function findSelfForwardingPageRule(text) {
  const s = safeStr(text);
  if (!s.trim()) return null;
  const re = /((?:https?:\/\/)?[a-z0-9*][a-z0-9.*-]*\.[a-z]{2,}\/\S*)\s*(?:->|=>|forward(?:ing|s)?(?:\s+to)?:?|redirects?\s+to)\s*(https?:\/\/\S+)/gi;
  let m;
  while ((m = re.exec(s))) {
    const rawSource = m[1];
    const rawDest = m[2];
    if (/^https?:\/\//i.test(rawSource)) continue; // already scoped to one scheme: not the classic bug
    if (!/^https:\/\//i.test(rawDest)) continue; // only bare-source -> https-dest is the classic bug
    const sourceHost = rawSource.replace(/^\*+/, '').split('/')[0].replace(/^www\./i, '').toLowerCase();
    const destHost = rawDest.replace(/^https:\/\//i, '').split('/')[0].replace(/^www\./i, '').toLowerCase();
    if (sourceHost && sourceHost === destHost) {
      return { raw: m[0].trim(), source: rawSource, destination: rawDest };
    }
  }
  return null;
}

// ───────────────────────── per-app-type fixes for X-Forwarded-Proto ─────────────────────────

const XFP_FIX_BY_APP_TYPE = {
  wordpress:
    "In wp-config.php, before the \"That's all, stop editing!\" line:\nif (isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https') {\n  $_SERVER['HTTPS'] = 'on';\n}",
  laravel:
    "In bootstrap/app.php:\n->withMiddleware(function ($middleware) {\n  $middleware->trustProxies(at: '*', headers: Request::HEADER_X_FORWARDED_PROTO | Request::HEADER_X_FORWARDED_FOR | Request::HEADER_X_FORWARDED_HOST);\n})",
  django:
    "In settings.py:\nSECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')\nOnly set this once you've confirmed your proxy always sets (and strips any client-supplied) X-Forwarded-Proto.",
  rails:
    "config.force_ssl = true in config/environments/production.rb, and confirm config.action_dispatch.trusted_proxies includes your load balancer/Cloudflare so Rack trusts its X-Forwarded-Proto header.",
  nextjs:
    "In middleware.ts, branch on the proxy header instead of the request's own protocol:\nif (req.headers.get('x-forwarded-proto') !== 'https') { return NextResponse.redirect(`https://${req.headers.get('host')}${req.nextUrl.pathname}`); }\n(not req.nextUrl.protocol, which reflects what your server received, not what the visitor sent.)",
  other:
    "Whatever forces HTTPS in your app must branch on the X-Forwarded-Proto header your proxy sends, not on the scheme of the request the app process itself received (which is plain HTTP once anything in front of it terminates TLS).",
};

// ───────────────────────── computeExpected() ─────────────────────────

function computeExpected(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const cloudflare = c.cloudflare && typeof c.cloudflare === 'object' ? c.cloudflare : {};
  const server = c.server && typeof c.server === 'object' ? c.server : {};
  const app = c.app && typeof c.app === 'object' ? c.app : {};

  const sslMode = ['off', 'flexible', 'full', 'full-strict'].includes(cloudflare.sslMode) ? cloudflare.sslMode : '';
  const targetUrl = safeStr(c.url).trim() || safeStr(app.siteUrl).trim() || '';
  const parsedChain = parseChainText(safeStr(c.chain), targetUrl);
  const firstHop = parsedChain.hops[0] || null;
  const verifyTarget = targetUrl || (firstHop && !firstHop.invalid ? firstHop.raw : 'https://example.com/');

  let cloudflareToOriginScheme = 'unknown';
  if (sslMode === 'off' || sslMode === 'flexible') cloudflareToOriginScheme = 'http';
  else if (sslMode === 'full' || sslMode === 'full-strict') cloudflareToOriginScheme = 'https';

  let canonicalHostHint = null;
  if (server.wwwRule === 'to-www') canonicalHostHint = 'www.<yourdomain>';
  else if (server.wwwRule === 'to-apex') canonicalHostHint = '<yourdomain> (no www)';

  const cycle = findCycle(parsedChain.hops);

  return {
    sslMode: sslMode || null,
    cloudflareToOriginScheme,
    recommendedSslMode: cloudflare.proxied || sslMode ? 'full (strict)' : null,
    canonicalHostHint,
    verifyCommand: `curl -sIL ${verifyTarget}`,
    hopsParsed: parsedChain.hops.length,
    loopFound: !!cycle,
  };
}

// ───────────────────────── diagnose() ─────────────────────────

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

function sortProblems(problems) {
  return problems
    .map((p, idx) => ({ p, idx }))
    .sort((a, b) => (SEVERITY_ORDER[a.p.severity] - SEVERITY_ORDER[b.p.severity]) || (a.idx - b.idx))
    .map((x) => x.p);
}

function pushProblem(problems, { severity, code, message, path, value, fix }) {
  problems.push({ severity, code, message, path: path || null, value: value == null ? null : value, fix: fix || null, where: path || null });
}

/**
 * @param {object} config
 * @param {string} [config.url] The URL that shows ERR_TOO_MANY_REDIRECTS.
 * @param {string} [config.chain] Pasted redirect chain: curl -IL output, or one URL per line.
 * @param {{proxied?:boolean|null, sslMode?:'off'|'flexible'|'full'|'full-strict'|'', alwaysHttps?:boolean|null, pageRules?:string}} [config.cloudflare]
 * @param {{type?:string, forcesHttps?:boolean|null, trustsXForwardedProto?:boolean|null, wwwRule?:'to-www'|'to-apex'|'none'|''}} [config.server]
 * @param {{type?:string, siteUrl?:string, forcesHttps?:boolean|null, trailingSlash?:'add'|'remove'|'none'|''}} [config.app]
 * @returns {{status:'pass'|'warn'|'fail', summary:string, expected:object, problems:Array, fixes:Array, checklist:string[], disclaimer:string}}
 */
export function diagnose(config) {
  const cfg = config && typeof config === 'object' ? config : {};
  const cloudflare = cfg.cloudflare && typeof cfg.cloudflare === 'object' ? cfg.cloudflare : {};
  const server = cfg.server && typeof cfg.server === 'object' ? cfg.server : {};
  const app = cfg.app && typeof cfg.app === 'object' ? cfg.app : {};

  const problems = [];
  const fixes = [];
  const checklist = [];

  const url = safeStr(cfg.url).trim();
  const chainText = safeStr(cfg.chain);
  const sslMode = ['off', 'flexible', 'full', 'full-strict'].includes(cloudflare.sslMode) ? cloudflare.sslMode : '';
  const proxied = cloudflare.proxied === true || cloudflare.proxied === false ? cloudflare.proxied : null;
  const alwaysHttps = cloudflare.alwaysHttps === true || cloudflare.alwaysHttps === false ? cloudflare.alwaysHttps : null;
  const serverForcesHttps = server.forcesHttps === true || server.forcesHttps === false ? server.forcesHttps : null;
  const trustsXfp = server.trustsXForwardedProto === true || server.trustsXForwardedProto === false ? server.trustsXForwardedProto : null;
  const wwwRule = ['to-www', 'to-apex', 'none'].includes(server.wwwRule) ? server.wwwRule : '';
  const appForcesHttps = app.forcesHttps === true || app.forcesHttps === false ? app.forcesHttps : null;
  const appType = ['wordpress', 'nextjs', 'laravel', 'django', 'rails', 'other'].includes(app.type) ? app.type : '';
  const siteUrl = safeStr(app.siteUrl).trim();
  const trailingSlash = ['add', 'remove', 'none'].includes(app.trailingSlash) ? app.trailingSlash : '';

  const expected = computeExpected(cfg);

  // ── 0. is there anything at all to work with? ───────────────────────
  const hasAnySignal =
    url || chainText.trim() || sslMode || proxied != null || alwaysHttps != null ||
    safeStr(cloudflare.pageRules).trim() || server.type || serverForcesHttps != null ||
    trustsXfp != null || wwwRule || appType || siteUrl || appForcesHttps != null || trailingSlash;
  if (!hasAnySignal) {
    pushProblem(problems, {
      severity: 'low',
      code: 'insufficient_input',
      message: 'Nothing filled in yet. Paste at least the looping URL and, ideally, the output of curl -sIL <url> as the redirect chain: that alone is usually enough to spot the exact loop.',
      path: 'url',
    });
  }

  if (url) {
    const parsedUrl = parseUri(url);
    if (!parsedUrl || parsedUrl.invalid) {
      pushProblem(problems, {
        severity: 'medium',
        code: 'invalid_url',
        message: `"${url}" doesn't parse as a URL. Include the scheme, e.g. https://example.com/.`,
        path: 'url',
        value: url,
      });
    }
  }

  // ── 1. Cloudflare Flexible SSL vs. an origin that forces HTTPS ──────
  // developers.cloudflare.com/ssl/troubleshooting/too-many-redirects/:
  // Flexible sends Cloudflare -> origin as plain HTTP; if the origin (web
  // server or app) then redirects that request to HTTPS, Cloudflare re-sends
  // it as HTTP again, forever.
  if (sslMode === 'flexible' && (serverForcesHttps === true || appForcesHttps === true)) {
    const forcer = serverForcesHttps === true && appForcesHttps === true ? 'your web server and your app both' :
      serverForcesHttps === true ? 'your web server' : 'your app';
    pushProblem(problems, {
      severity: 'high',
      code: 'cloudflare_flexible_https_loop',
      message: `SSL/TLS mode is Flexible: Cloudflare sends every request to your origin as plain HTTP, no matter what the visitor used. But ${forcer} redirect${forcer === 'your app' || forcer === 'your web server' ? 's' : ''} HTTP to HTTPS. Cloudflare gets that redirect, sends the next request as HTTP again, and the two sides bounce forever.${alwaysHttps === true ? ' "Always Use HTTPS" makes this happen on every single request, not just ones you explicitly type as https://.' : ''}`,
      path: 'cloudflare.sslMode',
      value: sslMode,
      fix: 'Switch SSL/TLS encryption mode to Full (strict) once your origin has a valid TLS certificate (Full works with a self-signed one). Do not remove the origin\'s HTTP->HTTPS redirect: Full/Full (strict) needs it gone the other way round only if the origin ALSO redirects HTTPS->HTTP.',
    });
    fixes.push({ title: 'Cloudflare -> SSL/TLS -> Overview: set encryption mode', value: 'Full (strict)', where: 'Cloudflare dashboard' });
  }

  // ── 2. Always Use HTTPS turned on with SSL mode Off ─────────────────
  // A narrow, self-contradictory combination: nothing between visitor and
  // Cloudflare is encrypted in Off mode, so an HTTPS visit to the zone
  // itself doesn't work as the toggle implies.
  if (alwaysHttps === true && sslMode === 'off') {
    pushProblem(problems, {
      severity: 'medium',
      code: 'cloudflare_always_https_ssl_off_conflict',
      message: '"Always Use HTTPS" redirects every visitor to https://, but SSL/TLS mode is Off: no encryption happens on either hop (visitor<->Cloudflare or Cloudflare<->origin), so the https:// Cloudflare just redirected to cannot actually be served.',
      path: 'cloudflare.sslMode',
      value: sslMode,
      fix: 'Set SSL/TLS mode to at least Flexible (Full or Full (strict) once your origin can do TLS).',
    });
  }

  // ── 3. App forces HTTPS but the web server doesn't trust X-Forwarded-Proto ──
  // nginx.org: $scheme reflects the hop nginx itself received, not the
  // visitor's original scheme, once something in front of it terminates
  // TLS. Django/Laravel docs: the fix is to read X-Forwarded-Proto (via
  // SECURE_PROXY_SSL_HEADER / TrustProxies) instead of the local scheme.
  if (appForcesHttps === true && trustsXfp === false) {
    const fixSnippet = appType && XFP_FIX_BY_APP_TYPE[appType] ? XFP_FIX_BY_APP_TYPE[appType] : XFP_FIX_BY_APP_TYPE.other;
    pushProblem(problems, {
      severity: proxied === true ? 'high' : 'medium',
      code: 'proxy_https_header_not_trusted',
      message: `Your app forces HTTPS, but your web server/proxy is marked as not trusting X-Forwarded-Proto.${proxied === true ? ' With Cloudflare proxying the connection, your origin only ever receives plain HTTP on that hop.' : ''} The app sees an HTTP request, redirects to HTTPS, the redirect arrives at the same proxy that again forwards it as HTTP: infinite loop, entirely inside your own stack, invisible to Cloudflare.`,
      path: 'server.trustsXForwardedProto',
      value: false,
      fix: fixSnippet,
    });
    fixes.push({ title: `Trust X-Forwarded-Proto in your app${appType ? ' (' + appType + ')' : ''}`, value: fixSnippet, where: appType ? `${appType} config` : 'app config' });
  }

  // ── 4/5. app.siteUrl vs. cloudflare/server's idea of scheme and host ──
  if (siteUrl) {
    const parsedSite = parseUri(siteUrl);
    if (!parsedSite || parsedSite.invalid) {
      pushProblem(problems, {
        severity: 'low',
        code: 'invalid_site_url',
        message: `app.siteUrl "${siteUrl}" doesn't parse as a URL.`,
        path: 'app.siteUrl',
        value: siteUrl,
      });
    } else {
      const httpsIsExpected = alwaysHttps === true || sslMode === 'full' || sslMode === 'full-strict' || serverForcesHttps === true || appForcesHttps === true;
      if (parsedSite.scheme === 'http' && httpsIsExpected) {
        const wpNote = appType === 'wordpress'
          ? ' In WordPress this is the "siteurl"/"home" options: WordPress itself will 301 every request to whichever scheme those options say, regardless of what Cloudflare or your server already decided.'
          : '';
        pushProblem(problems, {
          severity: 'high',
          code: 'siteurl_scheme_mismatch',
          message: `Your app's own site URL is set to http://, but something upstream (Cloudflare and/or your server) already expects https://.${wpNote} Every request bounces between the scheme your app insists on and the scheme the layer in front of it insists on.`,
          path: 'app.siteUrl',
          value: siteUrl,
          fix: appType === 'wordpress'
            ? `wp option update siteurl 'https://${parsedSite.host}' && wp option update home 'https://${parsedSite.host}'  (or Settings -> General in wp-admin, or define WP_HOME/WP_SITEURL in wp-config.php)`
            : `Update your app's configured site/base URL to https://${parsedSite.host}.`,
        });
      }
      if (wwwRule && wwwRule !== 'none') {
        const siteHasWww = hasWww(parsedSite.host);
        const conflicts = (wwwRule === 'to-www' && !siteHasWww) || (wwwRule === 'to-apex' && siteHasWww);
        if (conflicts) {
          const serverWants = wwwRule === 'to-www' ? `www.${stripWww(parsedSite.host)}` : stripWww(parsedSite.host);
          pushProblem(problems, {
            severity: 'high',
            code: 'siteurl_www_mismatch',
            message: `Your server redirects to ${wwwRule === 'to-www' ? 'the www subdomain' : 'the apex domain (no www)'}, but your app's own site URL host is "${parsedSite.host}": the opposite convention. Each request that starts on your app's host gets bounced to the server's preferred host, and back again.`,
            path: 'app.siteUrl',
            value: siteUrl,
            fix: appType === 'wordpress'
              ? `wp option update siteurl 'https://${serverWants}' && wp option update home 'https://${serverWants}'  (match whichever host your server rule already picks)`
              : `Update your app's configured site/base URL to https://${serverWants}, so it matches your server's www/apex rule.`,
          });
        }
      }
    }
  }

  // ── 6. Cloudflare Page Rule / Redirect Rule that forwards to itself ──
  const selfRule = findSelfForwardingPageRule(cloudflare.pageRules);
  if (selfRule) {
    pushProblem(problems, {
      severity: 'high',
      code: 'page_rule_self_redirect',
      message: `The rule "${selfRule.raw}" has a source pattern with no scheme (so it matches both http:// and https:// requests) forwarding to an explicit https:// destination on the same host. A request that is already https:// matches the rule again and gets "forwarded" to the exact same URL: an infinite loop entirely inside Cloudflare, before it ever reaches your origin.`,
      path: 'cloudflare.pageRules',
      value: selfRule.raw,
      fix: `Scope the rule's source to http:// only (e.g. http://${selfRule.source.replace(/^\*+/, '')}), or delete it and use the "Always Use HTTPS" toggle instead of a manual Forwarding URL rule for this.`,
    });
  }

  // ── 7/8. Parsed redirect chain: find the actual repeating pair ──────
  const { hops, statusCodes } = parseChainText(chainText, url);
  if (hops.length >= 2) {
    const cycle = findCycle(hops);
    if (cycle) {
      const { j, i } = cycle;
      const cycleHops = hops.slice(j, i + 1).map((h) => h.raw);
      const pairDescription = cycleHops.join(' -> ');
      if (i === j + 1) {
        pushProblem(problems, {
          severity: 'high',
          code: 'self_redirect_loop',
          message: `"${hops[j].raw}" redirects to itself, byte for byte. Look for a Cloudflare Redirect Rule/Page Rule, a .htaccess RewriteRule, an nginx rewrite, or an app route whose destination evaluates back to its own exact URL.`,
          path: 'chain',
          value: hops[j].raw,
          fix: `curl -sIL ${hops[j].raw}  (confirm, then remove or fix whichever rule produced that Location header)`,
        });
      } else {
        const diffs = compareHops(hops[j], hops[j + 1]);
        const dominant = dominantDiffType(diffs);
        const CODE_BY_DOMINANT = {
          scheme: 'https_http_ping_pong',
          www_apex: 'www_apex_ping_pong',
          trailing_slash: 'trailing_slash_ping_pong',
        };
        const code = CODE_BY_DOMINANT[dominant] || 'redirect_chain_cycle';
        const detailText = diffs.length ? diffs.map((d) => d.detail).join('; ') : 'the exact same URL is requested again';
        let extra = '';
        if (dominant === 'scheme') {
          extra = ' One layer (Cloudflare, your server, or your app) is forcing this to https, and another is sending it back to http. Check SSL/TLS mode against what your origin does with an incoming http vs https request, and whether your app trusts X-Forwarded-Proto.';
        } else if (dominant === 'www_apex') {
          extra = ' One layer redirects to the www host, another redirects to the apex (or vice versa). Pick exactly one canonical host and make every layer (DNS/Cloudflare rule, server config, app site URL) agree on it.';
        } else if (dominant === 'trailing_slash') {
          extra = ' One layer adds a trailing slash, another strips it. Pick one convention and make your server and your app (its trailingSlash / APPEND_SLASH-style setting) agree.';
        }
        pushProblem(problems, {
          severity: 'high',
          code,
          message: `The pasted chain loops: ${pairDescription}. Exact difference at the repeating step: ${detailText}.${extra}`,
          path: 'chain',
          value: pairDescription,
          fix: `curl -sIL ${hops[j].raw}  (re-run after each config change until it ends in a 200, not another 30x)`,
        });
      }
      fixes.push({ title: 'Verify the fix', value: `curl -sIL ${hops[j].raw}`, where: 'terminal' });
    } else {
      const lastStatus = statusCodes.length ? statusCodes[statusCodes.length - 1] : null;
      const looksUnterminated = lastStatus == null || (lastStatus >= 300 && lastStatus < 400);
      if (looksUnterminated && hops.length >= 3) {
        pushProblem(problems, {
          severity: 'medium',
          code: 'redirect_chain_long_no_cycle',
          message: `No exact repeat found across the ${hops.length} hops you pasted, and the chain doesn't clearly end in a 2xx response either. Either paste more of it (curl -IL follows redirects on its own and stops once it hits a real loop or --max-redirs), or the loop involves something that changes on every hop (a session token, a cache-buster, a redirect counter in the URL) that never repeats exactly.`,
          path: 'chain',
        });
      }
    }
  } else if (chainText.trim()) {
    pushProblem(problems, {
      severity: 'low',
      code: 'chain_unparsed',
      message: "Couldn't find any URLs or Location: headers in the pasted chain. Paste the output of curl -sIL <url> directly, or one URL per line.",
      path: 'chain',
    });
  }

  // ── checklist (always) ───────────────────────────────────────────────
  if (!fixes.some((f) => f.value === expected.verifyCommand)) {
    fixes.push({ title: 'See every hop and status code', value: expected.verifyCommand, where: 'terminal' });
  }
  checklist.push(`Run curl -sIL against the real URL and paste the output as the chain: it shows every hop's status code and Location header, which is the fastest way to see exactly where the loop is.`);
  checklist.push('Test in an incognito/private window, or curl, not your normal browser tab: browsers cache 301 redirects, so an already-fixed server can still "loop" in an old tab until that cache is cleared.');
  checklist.push('Change one layer at a time (Cloudflare SSL mode, then server config, then app config) and re-run curl after each change: fixing two layers at once hides which one actually caused it.');
  if (trailingSlash && trailingSlash !== 'none' && !hops.length) {
    checklist.push(`app.trailingSlash is set to "${trailingSlash}": if your reverse proxy (nginx/Apache) also has its own trailing-slash rule, paste a curl -sIL chain to confirm they agree with each other.`);
  }

  const sorted = sortProblems(problems);
  const highCount = sorted.filter((p) => p.severity === 'high').length;
  const medCount = sorted.filter((p) => p.severity === 'medium').length;
  const lowCount = sorted.filter((p) => p.severity === 'low').length;

  let status = 'pass';
  if (highCount > 0) status = 'fail';
  else if (medCount > 0 || lowCount > 0) status = 'warn';

  let summary;
  if (status === 'fail') {
    const top = sorted.find((p) => p.severity === 'high');
    summary = `${highCount} likely cause${highCount > 1 ? 's' : ''} found. Most likely: ${top.message}`;
  } else if (status === 'warn') {
    const top = sorted[0];
    summary = `Nothing conclusive, but ${medCount + lowCount} thing${medCount + lowCount > 1 ? 's' : ''} worth checking. Top of the list: ${top.message}`;
  } else {
    summary = 'No known loop pattern found in what you entered. If you are still seeing ERR_TOO_MANY_REDIRECTS, paste the output of curl -sIL as the chain for a precise diagnosis, or check the checklist below.';
  }

  return {
    status,
    summary,
    expected,
    problems: sorted,
    fixes,
    checklist,
    disclaimer:
      'Read-only, client-side analysis of the values and redirect chain you entered. This tool never fetches your URL itself. Always re-verify with curl -sIL (or your browser\'s Network tab) after each change. Not affiliated with Cloudflare, WordPress, Nginx, Apache, Vercel, or Netlify.',
  };
}

/**
 * Standalone helper: just the computed expected values for a config,
 * without running the full diagnostic. Handy for a live-updating preview.
 */
export function expectedValues(config) {
  const cfg = config && typeof config === 'object' ? config : {};
  return computeExpected(cfg);
}

// Also expose as a plain browser global when loaded via <script type="module">.
if (typeof window !== 'undefined') {
  window.RedirectLoopDoctor = { diagnose, expectedValues };
}
