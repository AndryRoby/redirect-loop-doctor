// tests.mjs — plain Node test runner for doctor-loop.js (no external dependencies).
// Run with: node tests.mjs

import { diagnose, expectedValues } from './doctor-loop.js';

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(`${name}${detail ? ' — ' + detail : ''}`);
  }
}

function eq(name, actual, expected) {
  const condition = actual === expected;
  ok(name, condition, condition ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function has(name, arr, code) {
  const condition = Array.isArray(arr) && arr.some((p) => p.code === code);
  ok(name, condition, condition ? '' : `expected a problem with code "${code}", got codes [${(arr || []).map((p) => p.code).join(', ')}]`);
}

function lacks(name, arr, code) {
  const condition = Array.isArray(arr) && !arr.some((p) => p.code === code);
  ok(name, condition, condition ? '' : `did not expect a problem with code "${code}"`);
}

function severityOf(arr, code) {
  const p = (arr || []).find((x) => x.code === code);
  return p ? p.severity : undefined;
}

function fixOf(arr, code) {
  const p = (arr || []).find((x) => x.code === code);
  return p ? p.fix : undefined;
}

// ─────────────────────────────────────────────────────────────────────────
// 0. empty / minimal input
// ─────────────────────────────────────────────────────────────────────────

{
  const r = diagnose({});
  has('empty config: flags insufficient_input', r.problems, 'insufficient_input');
  eq('empty config: status is warn (not a silent pass)', r.status, 'warn');
}

{
  const r = diagnose({ url: 'https://example.com/' });
  lacks('url alone: no insufficient_input', r.problems, 'insufficient_input');
  eq('url alone, nothing else wrong: status pass', r.status, 'pass');
  ok('url alone: checklist has at least 3 entries', r.checklist.length >= 3);
  ok('url alone: fixes includes a curl verify command', r.fixes.some((f) => /curl -sIL/.test(f.value)));
}

{
  const r = diagnose({ url: 'not a url at all' });
  has('unparsable url: invalid_url', r.problems, 'invalid_url');
  eq('unparsable url: severity is medium', severityOf(r.problems, 'invalid_url'), 'medium');
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Cloudflare Flexible SSL + origin forces HTTPS
//    (developers.cloudflare.com/ssl/troubleshooting/too-many-redirects/)
// ─────────────────────────────────────────────────────────────────────────

{
  const r = diagnose({ url: 'https://example.com/', cloudflare: { sslMode: 'flexible' }, server: { forcesHttps: true } });
  has('flexible + server forces https: cloudflare_flexible_https_loop', r.problems, 'cloudflare_flexible_https_loop');
  eq('flexible + server forces https: severity high', severityOf(r.problems, 'cloudflare_flexible_https_loop'), 'high');
  eq('flexible + server forces https: overall status fail', r.status, 'fail');
}

{
  const r = diagnose({ url: 'https://example.com/', cloudflare: { sslMode: 'flexible' }, app: { forcesHttps: true } });
  has('flexible + app forces https: cloudflare_flexible_https_loop', r.problems, 'cloudflare_flexible_https_loop');
}

{
  const r = diagnose({ url: 'https://example.com/', cloudflare: { sslMode: 'flexible', alwaysHttps: true }, server: { forcesHttps: true } });
  const msg = r.problems.find((p) => p.code === 'cloudflare_flexible_https_loop').message;
  ok('flexible + alwaysHttps: message mentions Always Use HTTPS', /Always Use HTTPS/.test(msg));
}

{
  const r = diagnose({ url: 'https://example.com/', cloudflare: { sslMode: 'full-strict' }, server: { forcesHttps: true } });
  lacks('full-strict + server forces https: no flexible loop flagged', r.problems, 'cloudflare_flexible_https_loop');
}

{
  const r = diagnose({ url: 'https://example.com/', cloudflare: { sslMode: 'flexible' }, server: { forcesHttps: false }, app: { forcesHttps: false } });
  lacks('flexible, nothing forcing https: no flexible loop flagged', r.problems, 'cloudflare_flexible_https_loop');
}

// ─────────────────────────────────────────────────────────────────────────
// 2. Always Use HTTPS vs SSL mode Off
// ─────────────────────────────────────────────────────────────────────────

{
  const r = diagnose({ url: 'https://example.com/', cloudflare: { alwaysHttps: true, sslMode: 'off' } });
  has('alwaysHttps + sslMode off: cloudflare_always_https_ssl_off_conflict', r.problems, 'cloudflare_always_https_ssl_off_conflict');
  eq('alwaysHttps + off: severity medium', severityOf(r.problems, 'cloudflare_always_https_ssl_off_conflict'), 'medium');
}

{
  const r = diagnose({ url: 'https://example.com/', cloudflare: { alwaysHttps: true, sslMode: 'full-strict' } });
  lacks('alwaysHttps + full-strict: no off-conflict flagged', r.problems, 'cloudflare_always_https_ssl_off_conflict');
}

// ─────────────────────────────────────────────────────────────────────────
// 3. App forces HTTPS but server doesn't trust X-Forwarded-Proto
//    (docs.djangoproject.com/.../secure-proxy-ssl-header, nginx $scheme)
// ─────────────────────────────────────────────────────────────────────────

{
  const r = diagnose({ url: 'https://example.com/', cloudflare: { proxied: true }, server: { trustsXForwardedProto: false }, app: { forcesHttps: true } });
  has('app forces https + xfp untrusted + proxied: proxy_https_header_not_trusted', r.problems, 'proxy_https_header_not_trusted');
  eq('proxied true: severity high', severityOf(r.problems, 'proxy_https_header_not_trusted'), 'high');
}

{
  const r = diagnose({ url: 'https://example.com/', cloudflare: { proxied: null }, server: { trustsXForwardedProto: false }, app: { forcesHttps: true } });
  eq('proxied unknown: severity medium', severityOf(r.problems, 'proxy_https_header_not_trusted'), 'medium');
}

{
  const r = diagnose({ url: 'https://example.com/', server: { trustsXForwardedProto: true }, app: { forcesHttps: true } });
  lacks('xfp trusted: no proxy_https_header_not_trusted', r.problems, 'proxy_https_header_not_trusted');
}

{
  const r = diagnose({ url: 'https://example.com/', server: { trustsXForwardedProto: false }, app: { forcesHttps: true, type: 'wordpress' } });
  ok('wordpress fix mentions HTTP_X_FORWARDED_PROTO', /HTTP_X_FORWARDED_PROTO/.test(fixOf(r.problems, 'proxy_https_header_not_trusted')));
}

{
  const r = diagnose({ url: 'https://example.com/', server: { trustsXForwardedProto: false }, app: { forcesHttps: true, type: 'laravel' } });
  ok('laravel fix mentions trustProxies', /trustProxies/.test(fixOf(r.problems, 'proxy_https_header_not_trusted')));
}

{
  const r = diagnose({ url: 'https://example.com/', server: { trustsXForwardedProto: false }, app: { forcesHttps: true, type: 'django' } });
  ok('django fix mentions SECURE_PROXY_SSL_HEADER', /SECURE_PROXY_SSL_HEADER/.test(fixOf(r.problems, 'proxy_https_header_not_trusted')));
}

{
  const r = diagnose({ url: 'https://example.com/', server: { trustsXForwardedProto: false }, app: { forcesHttps: true, type: 'rails' } });
  ok('rails fix mentions force_ssl', /force_ssl/.test(fixOf(r.problems, 'proxy_https_header_not_trusted')));
}

{
  const r = diagnose({ url: 'https://example.com/', server: { trustsXForwardedProto: false }, app: { forcesHttps: true, type: 'nextjs' } });
  ok('nextjs fix mentions x-forwarded-proto', /x-forwarded-proto/i.test(fixOf(r.problems, 'proxy_https_header_not_trusted')));
}

// ─────────────────────────────────────────────────────────────────────────
// 4. app.siteUrl scheme vs. upstream expectation
// ─────────────────────────────────────────────────────────────────────────

{
  const r = diagnose({ url: 'https://example.com/', cloudflare: { alwaysHttps: true }, app: { siteUrl: 'http://example.com' } });
  has('siteUrl http while alwaysHttps on: siteurl_scheme_mismatch', r.problems, 'siteurl_scheme_mismatch');
  eq('siteurl_scheme_mismatch severity high', severityOf(r.problems, 'siteurl_scheme_mismatch'), 'high');
}

{
  const r = diagnose({ url: 'https://example.com/', server: { forcesHttps: true }, app: { siteUrl: 'http://example.com' } });
  has('siteUrl http while server forces https: siteurl_scheme_mismatch', r.problems, 'siteurl_scheme_mismatch');
}

{
  const r = diagnose({ url: 'https://example.com/', app: { siteUrl: 'http://example.com' } });
  lacks('siteUrl http, nothing upstream expecting https: no siteurl_scheme_mismatch', r.problems, 'siteurl_scheme_mismatch');
}

{
  const r = diagnose({ url: 'https://example.com/', server: { forcesHttps: true }, app: { siteUrl: 'http://example.com', type: 'wordpress' } });
  const fix = fixOf(r.problems, 'siteurl_scheme_mismatch');
  ok('wordpress siteurl scheme fix mentions wp option update', /wp option update siteurl/.test(fix));
}

{
  const r = diagnose({ url: 'https://example.com/', server: { forcesHttps: true }, app: { siteUrl: 'https://example.com' } });
  lacks('siteUrl already https: no siteurl_scheme_mismatch', r.problems, 'siteurl_scheme_mismatch');
}

// ─────────────────────────────────────────────────────────────────────────
// 5. app.siteUrl host vs. server.wwwRule
// ─────────────────────────────────────────────────────────────────────────

{
  const r = diagnose({ url: 'https://example.com/', server: { wwwRule: 'to-www' }, app: { siteUrl: 'https://example.com' } });
  has('server to-www + siteUrl apex: siteurl_www_mismatch', r.problems, 'siteurl_www_mismatch');
  eq('siteurl_www_mismatch severity high', severityOf(r.problems, 'siteurl_www_mismatch'), 'high');
}

{
  const r = diagnose({ url: 'https://example.com/', server: { wwwRule: 'to-apex' }, app: { siteUrl: 'https://www.example.com' } });
  has('server to-apex + siteUrl www: siteurl_www_mismatch', r.problems, 'siteurl_www_mismatch');
}

{
  const r = diagnose({ url: 'https://example.com/', server: { wwwRule: 'to-www' }, app: { siteUrl: 'https://www.example.com' } });
  lacks('server to-www + siteUrl already www: no mismatch', r.problems, 'siteurl_www_mismatch');
}

{
  const r = diagnose({ url: 'https://example.com/', server: { wwwRule: 'none' }, app: { siteUrl: 'https://example.com' } });
  lacks('server wwwRule none: no www mismatch check', r.problems, 'siteurl_www_mismatch');
}

{
  const r = diagnose({ app: { siteUrl: 'this is not a url' } });
  has('unparsable siteUrl: invalid_site_url', r.problems, 'invalid_site_url');
  eq('invalid_site_url severity low', severityOf(r.problems, 'invalid_site_url'), 'low');
}

// ─────────────────────────────────────────────────────────────────────────
// 6. Cloudflare Page Rule / Redirect Rule that forwards to itself
// ─────────────────────────────────────────────────────────────────────────

{
  const r = diagnose({ url: 'https://example.com/', cloudflare: { pageRules: 'Forwarding URL (301): example.com/* -> https://example.com/$1' } });
  has('bare-source page rule forwarding to https same host: page_rule_self_redirect', r.problems, 'page_rule_self_redirect');
  eq('page_rule_self_redirect severity high', severityOf(r.problems, 'page_rule_self_redirect'), 'high');
}

{
  const r = diagnose({ url: 'https://example.com/', cloudflare: { pageRules: 'www.example.com/* forwards to https://www.example.com/$1' } });
  has('"forwards to" phrasing also detected', r.problems, 'page_rule_self_redirect');
}

{
  const r = diagnose({ url: 'https://example.com/', cloudflare: { pageRules: 'Forwarding URL (301): http://example.com/* -> https://example.com/$1' } });
  lacks('scoped http:// source: not flagged as self-redirect', r.problems, 'page_rule_self_redirect');
}

{
  const r = diagnose({ url: 'https://example.com/', cloudflare: { pageRules: '' } });
  lacks('empty page rules: nothing flagged', r.problems, 'page_rule_self_redirect');
}

// ─────────────────────────────────────────────────────────────────────────
// 7. Pasted redirect chain: cycle detection
// ─────────────────────────────────────────────────────────────────────────

{
  const chain = 'HTTP/1.1 301 Moved Permanently\nLocation: https://example.com/\n';
  const r = diagnose({ url: 'https://example.com/', chain });
  has('URL redirects to itself: self_redirect_loop', r.problems, 'self_redirect_loop');
  eq('self_redirect_loop severity high', severityOf(r.problems, 'self_redirect_loop'), 'high');
}

{
  const chain = 'HTTP/1.1 301 Moved Permanently\nLocation: https://example.com/\n\nHTTP/1.1 301 Moved Permanently\nLocation: http://example.com/\n';
  const r = diagnose({ url: 'http://example.com/', chain });
  has('scheme flips back and forth: https_http_ping_pong', r.problems, 'https_http_ping_pong');
  eq('https_http_ping_pong severity high', severityOf(r.problems, 'https_http_ping_pong'), 'high');
}

{
  const chain = 'Location: https://www.example.com/\nLocation: https://example.com/\n';
  const r = diagnose({ url: 'https://example.com/', chain });
  has('host flips www <-> apex: www_apex_ping_pong', r.problems, 'www_apex_ping_pong');
}

{
  const chain = 'Location: https://example.com/foo/\nLocation: https://example.com/foo\n';
  const r = diagnose({ url: 'https://example.com/foo', chain });
  has('path flips trailing slash: trailing_slash_ping_pong', r.problems, 'trailing_slash_ping_pong');
}

{
  const chain = 'Location: https://example.com/x?a=2\nLocation: https://example.com/x?a=1\n';
  const r = diagnose({ url: 'https://example.com/x?a=1', chain });
  has('cycle with only a query-string difference falls back to generic code', r.problems, 'redirect_chain_cycle');
}

{
  const chain =
    'HTTP/1.1 301 Moved Permanently\nLocation: https://a.example.com/2\n\n' +
    'HTTP/1.1 301 Moved Permanently\nLocation: https://a.example.com/3\n';
  const r = diagnose({ url: 'https://a.example.com/1', chain });
  has('3 distinct hops, no repeat, no terminal status: redirect_chain_long_no_cycle', r.problems, 'redirect_chain_long_no_cycle');
}

{
  const chain =
    'HTTP/1.1 301 Moved Permanently\nLocation: https://a.example.com/2\n\n' +
    'HTTP/1.1 301 Moved Permanently\nLocation: https://a.example.com/3\n\n' +
    'HTTP/1.1 200 OK\n';
  const r = diagnose({ url: 'https://a.example.com/1', chain });
  lacks('chain that actually ends in 200: not flagged as unterminated', r.problems, 'redirect_chain_long_no_cycle');
}

{
  const r = diagnose({ url: 'https://example.com/', chain: 'nothing here looks like a url or a header' });
  has('chain text with no URLs: chain_unparsed', r.problems, 'chain_unparsed');
  eq('chain_unparsed severity low', severityOf(r.problems, 'chain_unparsed'), 'low');
}

{
  const r = diagnose({ url: 'https://example.com/' });
  lacks('no chain at all: no chain_unparsed', r.problems, 'chain_unparsed');
  lacks('no chain at all: no cycle codes', r.problems, 'redirect_chain_cycle');
}

// ─────────────────────────────────────────────────────────────────────────
// 8. sortProblems() — high always first, regardless of push order
// ─────────────────────────────────────────────────────────────────────────

{
  const r = diagnose({
    app: { siteUrl: 'not a url' }, // low, pushed early (siteUrl branch runs before chain branch)
    url: 'https://example.com/',
    cloudflare: { sslMode: 'flexible' },
    server: { forcesHttps: true }, // high, pushed later
  });
  eq('mixed severities: first problem is high', r.problems[0].severity, 'high');
  eq('mixed severities: last problem is low or medium, never before high', SEVERITY_RANK(r.problems[r.problems.length - 1].severity) >= SEVERITY_RANK(r.problems[0].severity), true);
  for (let k = 1; k < r.problems.length; k++) {
    ok(`problems sorted: index ${k} severity rank >= index ${k - 1}`, SEVERITY_RANK(r.problems[k].severity) >= SEVERITY_RANK(r.problems[k - 1].severity));
  }
}
function SEVERITY_RANK(s) {
  return { high: 0, medium: 1, low: 2 }[s];
}

// ─────────────────────────────────────────────────────────────────────────
// 9. status mapping and summary
// ─────────────────────────────────────────────────────────────────────────

{
  const r = diagnose({ url: 'https://example.com/', cloudflare: { alwaysHttps: true, sslMode: 'off' } });
  eq('only medium/low problems: status warn', r.status, 'warn');
  ok('warn summary mentions "worth checking"', /worth checking/.test(r.summary));
}

{
  const r = diagnose({ url: 'https://example.com/', cloudflare: { sslMode: 'flexible' }, server: { forcesHttps: true } });
  eq('a high problem present: status fail', r.status, 'fail');
  ok('fail summary states a likely cause', /likely cause/.test(r.summary));
}

{
  const r = diagnose({ url: 'https://example.com/' });
  eq('nothing wrong: status pass', r.status, 'pass');
  ok('pass summary mentions curl', /curl/.test(r.summary));
}

// ─────────────────────────────────────────────────────────────────────────
// 10. expectedValues() — computed context, independent of the full diagnosis
// ─────────────────────────────────────────────────────────────────────────

eq('expectedValues: flexible -> origin sees http', expectedValues({ cloudflare: { sslMode: 'flexible' } }).cloudflareToOriginScheme, 'http');
eq('expectedValues: off -> origin sees http', expectedValues({ cloudflare: { sslMode: 'off' } }).cloudflareToOriginScheme, 'http');
eq('expectedValues: full -> origin sees https', expectedValues({ cloudflare: { sslMode: 'full' } }).cloudflareToOriginScheme, 'https');
eq('expectedValues: full-strict -> origin sees https', expectedValues({ cloudflare: { sslMode: 'full-strict' } }).cloudflareToOriginScheme, 'https');
eq('expectedValues: no sslMode -> unknown', expectedValues({}).cloudflareToOriginScheme, 'unknown');

eq('expectedValues: wwwRule to-www -> canonical hint', expectedValues({ server: { wwwRule: 'to-www' } }).canonicalHostHint, 'www.<yourdomain>');
eq('expectedValues: wwwRule to-apex -> canonical hint', expectedValues({ server: { wwwRule: 'to-apex' } }).canonicalHostHint, '<yourdomain> (no www)');
eq('expectedValues: no wwwRule -> no hint', expectedValues({}).canonicalHostHint, null);

eq('expectedValues: verifyCommand uses config.url', expectedValues({ url: 'https://example.com/' }).verifyCommand, 'curl -sIL https://example.com/');
eq('expectedValues: verifyCommand falls back to app.siteUrl', expectedValues({ app: { siteUrl: 'https://foo.example/' } }).verifyCommand, 'curl -sIL https://foo.example/');
eq('expectedValues: verifyCommand falls back to first chain hop', expectedValues({ chain: 'Location: https://chained.example/' }).verifyCommand, 'curl -sIL https://chained.example/');
eq('expectedValues: verifyCommand default fallback', expectedValues({}).verifyCommand, 'curl -sIL https://example.com/');

eq('expectedValues: recommendedSslMode when proxied', expectedValues({ cloudflare: { proxied: true } }).recommendedSslMode, 'full (strict)');
eq('expectedValues: no recommendation with no cloudflare signal', expectedValues({}).recommendedSslMode, null);

{
  const e = expectedValues({ url: 'https://example.com/', chain: 'Location: https://example.com/' });
  eq('expectedValues: hopsParsed counts seed + chain hop', e.hopsParsed, 2);
  eq('expectedValues: loopFound true for a self-loop', e.loopFound, true);
}
{
  const e = expectedValues({ url: 'https://example.com/', chain: 'Location: https://example.com/other' });
  eq('expectedValues: loopFound false when hops differ', e.loopFound, false);
}

// ─────────────────────────────────────────────────────────────────────────
// 11. general shape / robustness
// ─────────────────────────────────────────────────────────────────────────

{
  const r = diagnose(null);
  ok('diagnose(null) does not throw and returns a status', ['pass', 'warn', 'fail'].includes(r.status));
}
{
  const r = diagnose({ cloudflare: 'not an object', server: 42, app: [] });
  ok('diagnose() with wrong-typed nested fields does not throw', ['pass', 'warn', 'fail'].includes(r.status));
}
{
  const r = diagnose({ url: 'https://example.com/' });
  ok('disclaimer is a non-empty string', typeof r.disclaimer === 'string' && r.disclaimer.length > 20);
  ok('every problem has severity/code/message', r.problems.every((p) => p.severity && p.code && p.message));
  ok('fixes is always an array', Array.isArray(r.fixes));
  ok('checklist is always an array with content', Array.isArray(r.checklist) && r.checklist.length > 0);
}

// A realistic, intentionally-broken combined scenario (the one used as the
// page's example input): Flexible SSL + WordPress siteurl still on http +
// server redirects to www while siteurl is apex + app doesn't trust XFP.
{
  const r = diagnose({
    url: 'https://example.com/wp-admin/',
    chain: 'HTTP/1.1 301 Moved Permanently\nLocation: http://example.com/wp-admin/\n\nHTTP/1.1 301 Moved Permanently\nLocation: https://example.com/wp-admin/\n',
    cloudflare: { proxied: true, sslMode: 'flexible', alwaysHttps: true, pageRules: '' },
    server: { type: 'nginx', forcesHttps: true, trustsXForwardedProto: false, wwwRule: 'to-www' },
    app: { type: 'wordpress', siteUrl: 'http://example.com', forcesHttps: true, trailingSlash: 'none' },
  });
  eq('combined broken scenario: status fail', r.status, 'fail');
  has('combined scenario: flexible loop', r.problems, 'cloudflare_flexible_https_loop');
  has('combined scenario: siteurl scheme mismatch', r.problems, 'siteurl_scheme_mismatch');
  has('combined scenario: siteurl www mismatch', r.problems, 'siteurl_www_mismatch');
  has('combined scenario: xfp not trusted', r.problems, 'proxy_https_header_not_trusted');
  ok('combined scenario: at least 4 problems found', r.problems.length >= 4);
}

// ─────────────────────────────────────────────────────────────────────────

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
} else {
  console.log('All tests passed.');
}
