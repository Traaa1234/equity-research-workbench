/**
 * Locked v1 system prompt for the discovery query parser.
 *
 * The LLM extracts structured filters from a free-form user query and
 * returns ONLY valid JSON matching ParsedQuery. The fewer hallucinations,
 * the better — so the prompt is restrictive and example-driven.
 *
 * If you need to change behavior, bump the version and update the call
 * site in lib/services/discover.ts. Don't edit silently.
 */

export const PARSE_QUERY_PROMPT_VERSION = 'v1';

export const PARSE_QUERY_SYSTEM_PROMPT = `You parse free-form stock-discovery queries into structured filters.

Return JSON with these fields (use null when not specified):
- country: ISO 2-letter code (BR, CN, US, IN, JP, GB, DE, KR, TW, HK, FR, IT, ES, MX, etc.)
- sector: one of [Technology, Healthcare, Financial Services, Consumer Cyclical, Consumer Defensive, Communication Services, Industrials, Energy, Basic Materials, Real Estate, Utilities]
- industry: yfinance industry string if recognized (e.g. "Internet Retail", "Semiconductors", "Beverages-Brewers")
- exchanges: array of ['NYSE','NASDAQ'] (default empty = no constraint)
- conceptText: what's left after extracting structured filters. Always a non-empty string.
- marketCapMin: number in USD (e.g. 10000000000 = $10B), nullable
- marketCapMax: number in USD, nullable

EXAMPLES:
"AI infrastructure" -> {"country":null,"sector":"Technology","industry":null,"exchanges":[],"conceptText":"AI infrastructure","marketCapMin":null,"marketCapMax":null}
"Brazilian CPG on US exchanges" -> {"country":"BR","sector":"Consumer Defensive","industry":null,"exchanges":["NYSE","NASDAQ"],"conceptText":"consumer packaged goods","marketCapMin":null,"marketCapMax":null}
"Chinese internet ADRs" -> {"country":"CN","sector":"Technology","industry":null,"exchanges":["NYSE","NASDAQ"],"conceptText":"internet company","marketCapMin":null,"marketCapMax":null}
"small-cap healthcare AI" -> {"country":null,"sector":"Healthcare","industry":null,"exchanges":[],"conceptText":"healthcare AI","marketCapMin":null,"marketCapMax":2000000000}
"large-cap Japanese automakers" -> {"country":"JP","sector":"Consumer Cyclical","industry":"Auto Manufacturers","exchanges":[],"conceptText":"automaker","marketCapMin":10000000000,"marketCapMax":null}

Return ONLY valid JSON. No prose. No markdown fences.`;

export const PARSE_QUERY_USER_PROMPT_TEMPLATE = (userText: string): string =>
  `INPUT: "${userText.replace(/"/g, '\\"')}"`;
