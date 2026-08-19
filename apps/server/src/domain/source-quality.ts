import { isPrimarySource, type SourceClass } from '@mac/protocol';

/**
 * How much weight a source's ORIGIN earns it (Phase 4 Part E §18).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS AND IS NOT CLAIMING
 *
 * It classifies WHERE something came from. It says nothing about whether the
 * content is correct — a vendor's own documentation can be wrong, and a forum
 * post can be the only accurate account of a known bug.
 *
 * What it buys is the ability to say, mechanically, "this critical technical
 * conclusion rests entirely on a forum thread", which is a thing a reader
 * genuinely wants to know and which no amount of reading the conclusion itself
 * would reveal. Spec §10's source-of-truth hierarchy is the same idea applied
 * to PAC's internal systems; this is it applied outward.
 *
 * Deliberately conservative. An unrecognised host is `unknown`, not
 * `industry_publication`, because the failure mode that matters is a source
 * being credited with authority it was never checked for.
 * ---------------------------------------------------------------------------
 */

/**
 * Suffixes that identify a government or regulator anywhere Mac is likely to
 * look. Matched on the registrable suffix, never by substring.
 */
const GOVERNMENT_SUFFIXES = [
  'gov',
  'gov.au',
  'gov.uk',
  'gov.nz',
  'govt.nz',
  'gc.ca',
  'europa.eu',
  'mil',
];

/**
 * Standards bodies, by exact host or parent domain.
 *
 * A short and deliberately incomplete list. The cost of a missing entry is that
 * a standard is classified `unknown` and a criterion requiring a primary source
 * is not satisfied — visible, and one settings edit away from being fixed. The
 * cost of a wrong entry is a claim credited to a standards body that never made
 * it, which nobody would notice.
 */
const STANDARDS_HOSTS = [
  'iso.org',
  'iec.ch',
  'ieee.org',
  'ietf.org',
  'rfc-editor.org',
  'w3.org',
  'standards.org.au',
  'standards.iteh.ai',
  'ansi.org',
  'nist.gov',
  'cenelec.eu',
  'cen.eu',
  'itu.int',
  'opcfoundation.org',
  'odva.org',
  'profibus.com',
  'modbus.org',
  'fieldbus.org',
];

/**
 * Vendors whose own domains are their primary documentation.
 *
 * Industrial automation first, because that is what PAC does — but the same
 * rule applies to any vendor: a claim about how a product behaves is best
 * sourced from whoever makes it.
 */
const VENDOR_DOC_HOSTS = [
  'siemens.com',
  'automation.siemens.com',
  'rockwellautomation.com',
  'ab.rockwellautomation.com',
  'schneider-electric.com',
  'se.com',
  'mitsubishielectric.com',
  'omron.com',
  'beckhoff.com',
  'phoenixcontact.com',
  'wago.com',
  'pilz.com',
  'sick.com',
  'ifm.com',
  'endress.com',
  'emerson.com',
  'honeywell.com',
  'abb.com',
  'yokogawa.com',
  'festo.com',
  'sew-eurodrive.com',
  'danfoss.com',
  'microsoft.com',
  'learn.microsoft.com',
  'docs.microsoft.com',
  'oracle.com',
  'redhat.com',
  'canonical.com',
  'ubuntu.com',
  'postgresql.org',
  'nodejs.org',
  'python.org',
  'docker.com',
  'kubernetes.io',
  'anthropic.com',
  'docs.anthropic.com',
];

/**
 * Path fragments that mark a vendor page as documentation rather than marketing.
 *
 * A vendor's `/products/` page is a sales page; its `/docs/` tree is the thing
 * an engineer should be citing. Both live on the same host, so the host alone
 * cannot tell them apart.
 */
const DOC_PATH_HINTS = ['/doc', '/docs/', '/documentation', '/manual', '/reference', '/support/', '/kb/', '/api/', '/developer'];

/** Hosts whose content is user-generated discussion. */
const FORUM_HOSTS = [
  'stackoverflow.com',
  'stackexchange.com',
  'superuser.com',
  'serverfault.com',
  'reddit.com',
  'quora.com',
  'news.ycombinator.com',
  'plctalk.net',
  'control.com',
  'eng-tips.com',
  'github.com/discussions',
  'discourse.org',
  'medium.com',
  'substack.com',
  'dev.to',
];

/** Recognised trade and technical press. */
const INDUSTRY_PUBLICATION_HOSTS = [
  'controleng.com',
  'automationworld.com',
  'isa.org',
  'plantengineering.com',
  'theregister.com',
  'arstechnica.com',
  'ieee-spectrum.org',
  'spectrum.ieee.org',
  'infoq.com',
  'processonline.com.au',
  'ferret.com.au',
];

const NEWS_HOSTS = [
  'reuters.com',
  'bloomberg.com',
  'bbc.co.uk',
  'bbc.com',
  'abc.net.au',
  'afr.com',
  'theguardian.com',
  'nytimes.com',
  'ft.com',
];

/** Exact host, or a subdomain of it. Never a suffix substring match. */
function hostMatches(host: string, domain: string): boolean {
  const clean = domain.toLowerCase().replace(/^\./, '');
  // `endsWith(domain)` alone would let `evil-siemens.com` match `siemens.com`,
  // which is precisely the mistake a source classifier must not make.
  return host === clean || host.endsWith(`.${clean}`);
}

const inList = (host: string, list: readonly string[]): boolean =>
  list.some((entry) => hostMatches(host, entry.split('/')[0]!));

/**
 * Classifies a URL.
 *
 * `vendorDomains` lets an administrator name PAC's own suppliers without a code
 * change, which matters because the vendor list above can never be complete and
 * a wrong classification is the sort of thing an engineer notices once and then
 * wants fixed by lunchtime.
 */
export function classifySource(
  url: string,
  options: { vendorDomains?: readonly string[]; companyDomains?: readonly string[] } = {},
): SourceClass {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'unknown';
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const path = parsed.pathname.toLowerCase();

  // An administrator's own vendor list wins over every built-in rule, including
  // the forum list — if PAC says a host is their supplier's documentation, that
  // is a decision about PAC's supply chain and not one for a table in here.
  if (options.vendorDomains?.some((d) => hostMatches(host, d))) return 'official_vendor_docs';

  if (inList(host, STANDARDS_HOSTS)) return 'standards_body';

  if (GOVERNMENT_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
    // NIST is both, and the standards list is checked first on purpose: a
    // citation of a NIST publication is a citation of a standard, and calling
    // it "a government website" understates it.
    return 'government';
  }

  if (inList(host, VENDOR_DOC_HOSTS)) {
    /*
     * A vendor host is only DOCUMENTATION on a documentation path.
     *
     * Otherwise it is the company's website, which is a weaker thing: a product
     * landing page is marketing, and a conclusion about how something behaves
     * should not rest on one.
     */
    return DOC_PATH_HINTS.some((hint) => path.includes(hint)) ? 'official_vendor_docs' : 'company_website';
  }

  if (inList(host, FORUM_HOSTS)) return 'forum_community';
  if (inList(host, INDUSTRY_PUBLICATION_HOSTS)) return 'industry_publication';
  if (inList(host, NEWS_HOSTS)) return 'secondary_reporting';

  if (options.companyDomains?.some((d) => hostMatches(host, d))) return 'company_website';

  /*
   * A documentation path on an unrecognised host.
   *
   * `unknown` rather than `official_vendor_docs`: anybody can serve a /docs/
   * path, and the whole value of the primary/secondary split is that it cannot
   * be claimed by the source itself.
   */
  return 'unknown';
}

/**
 * Whether a set of retrieved sources contains a primary one.
 *
 * The question acceptance verification asks when a brief requires that a
 * critical conclusion rest on something better than commentary.
 */
export const hasPrimarySource = (classes: readonly SourceClass[]): boolean => classes.some(isPrimarySource);

/**
 * One sentence explaining the evidence base, for the artefact and the report.
 *
 * Written so that the weak case reads as weak. "Based on 4 sources" is the kind
 * of sentence that makes thin evidence sound thorough, which is exactly what a
 * research report must not do.
 */
export function describeSourceMix(classes: readonly SourceClass[]): string {
  if (classes.length === 0) return 'No external sources were retrieved.';

  const counts = new Map<SourceClass, number>();
  for (const klass of classes) counts.set(klass, (counts.get(klass) ?? 0) + 1);

  const primary = classes.filter(isPrimarySource).length;
  const parts = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([klass, count]) => `${count} ${klass.replace(/_/g, ' ')}`);

  const basis =
    primary === 0
      ? 'None of them is a primary source, so technical conclusions drawn from them are second-hand.'
      : `${primary} of them ${primary === 1 ? 'is a primary source' : 'are primary sources'}.`;

  return `${classes.length} external source(s): ${parts.join(', ')}. ${basis}`;
}
