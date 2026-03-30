// OmniMap — Infoway Terminology Gateway FHIR Client
//
// Uses Canada Health Infoway's FHIR Terminology Server (SNOMED CT Canadian Edition).
// Auth: OAuth 2.0 client credentials, token cached until near-expiry.
//
// Base URL:  https://terminologystandardsservice.ca/fhir
// Token URL: https://terminologystandardsservice.ca/authorisation/auth/realms/terminology/protocol/openid-connect/token
//
// Required env vars (backend/.env):
//   INFOWAY_CLIENT_ID      — from System Access Request Form
//   INFOWAY_CLIENT_SECRET  — from System Access Request Form
//   INFOWAY_FHIR_BASE_URL  — defaults to https://terminologystandardsservice.ca/fhir
//   INFOWAY_TOKEN_URL      — defaults to the standard realm token URL
//
// If INFOWAY_CLIENT_ID is not set, all functions return empty results (corpus fallback).

const FHIR_BASE = process.env.INFOWAY_FHIR_BASE_URL
  ?? 'https://terminologystandardsservice.ca/fhir';

const TOKEN_URL = process.env.INFOWAY_TOKEN_URL
  ?? 'https://terminologystandardsservice.ca/authorisation/auth/realms/terminology/protocol/openid-connect/token';

// SNOMED CT system URI (FHIR canonical)
const SNOMED_SYSTEM = 'http://snomed.info/sct';

// ValueSet URL for all active SNOMED CT concepts
// Using the implicit "all SNOMED CT" ValueSet supported by Ontoserver
const SNOMED_VS = `${SNOMED_SYSTEM}?fhir_vs`;

// -----------------------------------------------------------------
// Token cache (module-level singleton)
// -----------------------------------------------------------------

interface TokenCache {
  accessToken: string;
  expiresAt:   number;  // Unix ms
}

let tokenCache: TokenCache | null = null;

async function getAccessToken(): Promise<string> {
  const clientId     = process.env.INFOWAY_CLIENT_ID;
  const clientSecret = process.env.INFOWAY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Infoway credentials not configured (INFOWAY_CLIENT_ID / INFOWAY_CLIENT_SECRET)');
  }

  // Return cached token if still valid (with 60-second buffer)
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.accessToken;
  }

  const params = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    params.toString(),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Infoway token request failed (${res.status}): ${body}`);
  }

  const json = await res.json() as { access_token: string; expires_in: number };
  tokenCache = {
    accessToken: json.access_token,
    expiresAt:   Date.now() + json.expires_in * 1000,
  };

  return tokenCache.accessToken;
}

// -----------------------------------------------------------------
// FHIR request helper
// -----------------------------------------------------------------

async function fhirGet<T>(path: string): Promise<T> {
  const token = await getAccessToken();
  const res   = await fetch(`${FHIR_BASE}${path}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept':        'application/fhir+json',
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Infoway FHIR ${path} failed (${res.status}): ${body}`);
  }

  return res.json() as Promise<T>;
}

// -----------------------------------------------------------------
// Response types
// -----------------------------------------------------------------

interface FhirDesignation {
  use?:   { code?: string; display?: string };
  value:  string;
}

interface FhirValueSetExpansion {
  resourceType: string;
  expansion?: {
    total?:   number;
    contains?: Array<{
      system:        string;
      code:          string;
      display:       string;
      abstract?:     boolean;
      designation?:  FhirDesignation[];
    }>;
  };
}

// CodeSystem/$lookup response shape (FHIR Parameters resource)
interface FhirLookupParam {
  name:           string;
  valueString?:   string;
  valueBoolean?:  boolean;
  valueCoding?:   { system?: string; code?: string; display?: string };
  valueCode?:     string;
  part?:          FhirLookupParam[];
}
interface FhirLookupResponse {
  resourceType: string;
  parameter?:   FhirLookupParam[];
}

// -----------------------------------------------------------------
// Public API
// -----------------------------------------------------------------

export interface SnomedConcept {
  code:    string;
  display: string;
}

/**
 * Enriched concept info returned alongside search results.
 * parents    — immediate parent concepts in the SNOMED IS-A hierarchy
 * semanticTag — SNOMED semantic tag extracted from the FSN, e.g. "disorder", "finding"
 */
export interface SnomedConceptInfo extends SnomedConcept {
  parents:     Array<{ code: string; display: string }>;
  semanticTag: string | null;
}

// Module-level cache: concept code → enriched info (stable for SNOMED release lifetime)
const conceptInfoCache = new Map<string, SnomedConceptInfo>();

/** Whether the Infoway integration is configured. */
export function isInfowayConfigured(): boolean {
  return !!(process.env.INFOWAY_CLIENT_ID && process.env.INFOWAY_CLIENT_SECRET);
}

// SNOMED designation use codes
const FSN_USE_CODE = '900000000000003001';  // Fully Specified Name

/**
 * Fetch enriched concept info for a single SNOMED code.
 * Returns parent concepts and semantic tag (extracted from FSN).
 * Results are cached in-process — stable for a SNOMED release.
 * Never throws; returns a minimal stub on failure.
 */
export async function getSnomedConceptInfo(code: string): Promise<SnomedConceptInfo> {
  if (conceptInfoCache.has(code)) return conceptInfoCache.get(code)!;

  const stub: SnomedConceptInfo = { code, display: code, parents: [], semanticTag: null };

  if (!isInfowayConfigured()) return stub;

  try {
    const qs = new URLSearchParams({ system: SNOMED_SYSTEM, code, property: 'parent' });
    const data = await fhirGet<FhirLookupResponse>(`/CodeSystem/$lookup?${qs.toString()}`);

    const parents: Array<{ code: string; display: string }> = [];
    let semanticTag: string | null = null;
    let display = stub.display;

    for (const param of data.parameter ?? []) {
      // Top-level display (Preferred Term)
      if (param.name === 'display' && param.valueString) {
        display = param.valueString;
      }

      // FSN designation → extract semantic tag from trailing "(xxx)"
      if (param.name === 'designation') {
        const usePart   = param.part?.find(p => p.name === 'use');
        const valuePart = param.part?.find(p => p.name === 'value');
        if (
          usePart?.valueCoding?.code === FSN_USE_CODE &&
          valuePart?.valueString
        ) {
          const m = valuePart.valueString.match(/\(([^)]+)\)$/);
          if (m) semanticTag = m[1];
        }
      }

      // Property: parent
      if (param.name === 'property') {
        const codePart  = param.part?.find(p => p.name === 'code');
        const valuePart = param.part?.find(p => p.name === 'value');
        if (codePart?.valueCode === 'parent' && valuePart?.valueCoding?.code) {
          parents.push({
            code:    valuePart.valueCoding.code,
            display: valuePart.valueCoding.display ?? '',
          });
        }
      }
    }

    const info: SnomedConceptInfo = { code, display, parents, semanticTag };
    conceptInfoCache.set(code, info);
    return info;
  } catch {
    // Cache the stub so we don't retry on every search
    conceptInfoCache.set(code, stub);
    return stub;
  }
}

/**
 * Search SNOMED CT Canadian Edition by display text.
 * Returns up to `limit` matching concepts.
 * Falls back silently to [] if Infoway is not configured.
 */
export async function searchSnomedConcepts(
  query: string,
  limit = 20,
): Promise<SnomedConcept[]> {
  if (!isInfowayConfigured()) return [];

  const qs = new URLSearchParams({
    url:        SNOMED_VS,
    filter:     query.trim(),
    count:      String(limit * 2),   // fetch extra to absorb duplicates before slicing
    activeOnly: 'true',              // exclude retired/inactive concepts
  });

  const data = await fhirGet<FhirValueSetExpansion>(`/ValueSet/$expand?${qs.toString()}`);
  const contains = data.expansion?.contains ?? [];

  // Deduplicate by code — Infoway can return the same concept multiple times
  // when the filter matches both FSN and a synonym
  const seen = new Set<string>();
  const results: SnomedConcept[] = [];

  for (const c of contains) {
    if (c.abstract || !c.code || !c.display) continue;
    if (seen.has(c.code)) continue;
    seen.add(c.code);
    results.push({ code: c.code, display: c.display });
    if (results.length >= limit) break;
  }

  return results;
}

/**
 * Look up a single SNOMED CT concept by code.
 * Returns null if not found or Infoway is not configured.
 */
export async function lookupSnomedCode(code: string): Promise<SnomedConcept | null> {
  if (!isInfowayConfigured()) return null;

  const qs = new URLSearchParams({ system: SNOMED_SYSTEM, code });

  try {
    const data = await fhirGet<{ resourceType: string; display?: string; parameter?: Array<{ name: string; valueString?: string }> }>(
      `/CodeSystem/$lookup?${qs.toString()}`,
    );
    // Extract display from parameters array
    const displayParam = data.parameter?.find(p => p.name === 'display');
    const display = displayParam?.valueString ?? data.display ?? null;
    if (!display) return null;
    return { code, display };
  } catch {
    return null;
  }
}

/**
 * Find a SNOMED CT concept whose FSN, Preferred Term, or any synonym exactly
 * matches `term` (case-insensitive). Used by automatch (Node 4).
 * Returns null if no exact match found.
 */
export async function findExactTerm(term: string): Promise<SnomedConcept | null> {
  if (!isInfowayConfigured()) return null;

  const trimmed = term.trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();

  const qs = new URLSearchParams({
    url:                SNOMED_VS,
    filter:             trimmed,
    count:              '10',
    includeDesignations: 'true',
  });

  const data = await fhirGet<FhirValueSetExpansion>(`/ValueSet/$expand?${qs.toString()}`);
  const contains = data.expansion?.contains ?? [];

  const match = contains.find(c => {
    if (c.abstract) return false;
    // Check Preferred Term (display)
    if (c.display?.toLowerCase() === lower) return true;
    // Check FSN and synonyms in designation array
    return c.designation?.some(d => d.value?.toLowerCase() === lower) ?? false;
  });

  return match ? { code: match.code, display: match.display } : null;
}

/** @deprecated Use findExactTerm — matches PT + synonyms, not FSN only. */
export const findExactFsn = findExactTerm;
