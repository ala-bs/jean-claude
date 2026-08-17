import type { MobilePreviewNetworkRequest } from '@shared/mobile-simulator-types';

const NETWORK_FILTER_DEBUG_KEY = 'jc:debug-network-filter';

export function logNetworkFilterDebug(
  event: string,
  detail?: Record<string, unknown>,
) {
  try {
    if (window.localStorage.getItem(NETWORK_FILTER_DEBUG_KEY) !== '1') return;
  } catch {
    return;
  }

  console.info('[jc:network-filter]', event, detail ?? {});
}

export function formatNetworkClient(request: {
  clientAddress: string | null;
  clientPort: number | null;
}) {
  if (!request.clientAddress) return '-';
  if (request.clientPort === null) return request.clientAddress;
  return `${request.clientAddress}:${request.clientPort}`;
}

export type NetworkFilterKey = 'text' | 'method' | 'status' | 'path' | 'host';

export type NetworkFilterToken = {
  key: NetworkFilterKey;
  value: string;
  neg: boolean;
  exact?: boolean;
};

export type NetworkFilterSuggestion =
  | {
      kind: 'key';
      key: Exclude<NetworkFilterKey, 'text'>;
      label: string;
      hint: string;
      neg: boolean;
    }
  | {
      kind: 'value';
      label: string;
      count: number;
      token: NetworkFilterToken;
    };

export const NETWORK_FILTER_FIELDS = [
  { key: 'method', hint: 'HTTP method' },
  { key: 'status', hint: 'response code' },
  { key: 'path', hint: 'URL path' },
  { key: 'host', hint: 'captured domain' },
] as const satisfies ReadonlyArray<{
  key: Exclude<NetworkFilterKey, 'text'>;
  hint: string;
}>;

export function parseNetworkFilterToken(rawValue: string): NetworkFilterToken {
  let value = rawValue.trim();
  let neg = false;
  if (value.startsWith('-') || value.startsWith('!')) {
    neg = true;
    value = value.slice(1).trim();
  }

  const colonIndex = value.indexOf(':');
  if (colonIndex > 0) {
    const key = value.slice(0, colonIndex).toLowerCase() as NetworkFilterKey;
    const tokenValue = value.slice(colonIndex + 1).trim();
    if (
      tokenValue &&
      NETWORK_FILTER_FIELDS.some((field) => field.key === key)
    ) {
      return { key, value: tokenValue, neg };
    }
  }

  return { key: 'text', value, neg };
}

export function matchesNetworkFilterToken(
  request: MobilePreviewNetworkRequest,
  token: NetworkFilterToken,
) {
  const normalizedValue = token.value.trim().toLowerCase();
  if (!normalizedValue) return true;

  const rawMatch = (() => {
    if (token.key === 'method') {
      return request.method.toLowerCase() === normalizedValue;
    }
    if (token.key === 'status') {
      if (/^\dxx$/.test(normalizedValue)) {
        return request.status !== null
          ? Math.floor(request.status / 100) === Number(normalizedValue[0])
          : request.tunnelOnly && normalizedValue === '2xx';
      }
      return getNetworkStatusLabel(request).toString().toLowerCase() === normalizedValue;
    }
    if (token.key === 'path') {
      const path = getNetworkPath(request.url).toLowerCase();
      return token.exact ? path === normalizedValue : path.includes(normalizedValue);
    }
    if (token.key === 'host') {
      const host = getNetworkHostname(request.url).toLowerCase();
      return token.exact ? host === normalizedValue : host.includes(normalizedValue);
    }
    return [
      request.method,
      request.url,
      getNetworkStatusLabel(request).toString(),
      request.error ?? '',
      formatNetworkClient(request),
    ].some((value) => value.toLowerCase().includes(normalizedValue));
  })();

  return token.neg ? !rawMatch : rawMatch;
}

export function matchesNetworkFilter(
  request: MobilePreviewNetworkRequest,
  filter: NetworkFilterToken[],
) {
  return filter.every((token) => matchesNetworkFilterToken(request, token));
}

export function formatNetworkHeaders(headers: Record<string, string>) {
  const entries = Object.entries(headers);
  if (entries.length === 0) return '-';
  return entries.map(([key, value]) => `${key}: ${value}`).join('\n');
}

export function formatNetworkPreview(value: string | null) {
  if (!value) return '-';
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

export function quoteCurlArg(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function formatCurlCommand(request: MobilePreviewNetworkRequest) {
  const lines = [
    'curl',
    `  -X ${quoteCurlArg(request.method)}`,
    `  ${quoteCurlArg(request.url)}`,
  ];

  Object.entries(request.requestHeaders).forEach(([key, value]) => {
    lines.splice(-1, 0, `  -H ${quoteCurlArg(`${key}: ${value}`)}`);
  });

  if (request.requestBodyPreview) {
    lines.splice(
      -1,
      0,
      `  --data-raw ${quoteCurlArg(request.requestBodyPreview)}`,
    );
  }

  return lines.join(' \\\n');
}

export function getNetworkStatusClass(request: {
  error: string | null;
  status: number | null;
  tunnelOnly: boolean;
}) {
  if (request.error || (request.status !== null && request.status >= 400)) {
    return 'text-status-fail';
  }
  if (request.status !== null && request.status >= 300) {
    return 'text-amber-300';
  }
  if (request.tunnelOnly) return 'text-sky-300';
  return 'text-emerald-300';
}

export function getHeaderValue(headers: Record<string, string>, name: string) {
  const targetName = name.toLowerCase();
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === targetName,
  );
  return entry?.[1] ?? null;
}

export function getNetworkStatusLabel(request: {
  status: number | null;
  tunnelOnly: boolean;
}) {
  if (request.tunnelOnly) return 'Tunnel';
  return request.status ?? '...';
}

export function getNetworkMethodClass(method: string) {
  switch (method.toUpperCase()) {
    case 'POST':
      return 'text-amber-300';
    case 'PUT':
    case 'PATCH':
      return 'text-violet-300';
    case 'DELETE':
      return 'text-status-fail';
    default:
      return 'text-sky-300';
  }
}

export function getNetworkHostname(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return '-';
  }
}

export function getNetworkPath(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

export function getNetworkFilterFieldValues(
  requests: MobilePreviewNetworkRequest[],
  key: Exclude<NetworkFilterKey, 'text'>,
) {
  const values = requests.flatMap((request) => {
    if (key === 'method') return [request.method.toUpperCase()];
    if (key === 'status') {
      return request.status === null
        ? [getNetworkStatusLabel(request).toString()]
        : [`${Math.floor(request.status / 100)}xx`, request.status.toString()];
    }
    if (key === 'path') return [getNetworkPath(request.url)];
    return [getNetworkHostname(request.url)];
  });

  return [...new Set(values.filter(Boolean))].sort((first, second) =>
    first.localeCompare(second, undefined, { numeric: true }),
  );
}

export function buildNetworkFilterSuggestions({
  draft,
  requests,
}: {
  draft: string;
  requests: MobilePreviewNetworkRequest[];
}): NetworkFilterSuggestion[] {
  let value = draft.trim();
  let neg = false;
  if (value.startsWith('-') || value.startsWith('!')) {
    neg = true;
    value = value.slice(1).trim();
  }

  const colonIndex = value.indexOf(':');
  if (colonIndex > 0) {
    const key = value.slice(0, colonIndex).toLowerCase() as NetworkFilterKey;
    const field = NETWORK_FILTER_FIELDS.find((item) => item.key === key);
    if (field) {
      const filterValue = value.slice(colonIndex + 1).trim().toLowerCase();
      return getNetworkFilterFieldValues(requests, field.key)
        .filter((item) => item.toLowerCase().includes(filterValue))
        .slice(0, 8)
        .map((item) => {
          const token = {
            key: field.key,
            value: item,
            neg,
            exact: field.key === 'host' || field.key === 'path' || undefined,
          };
          return {
            kind: 'value',
            label: `${field.key}:${item}`,
            count: requests.filter((request) =>
              matchesNetworkFilterToken(request, { ...token, neg: false }),
            ).length,
            token,
          };
        });
    }
  }

  const suggestions: NetworkFilterSuggestion[] = [];
  if (value) {
    const token = { key: 'text' as const, value, neg };
    suggestions.push({
      kind: 'value',
      label: value,
      count: requests.filter((request) =>
        matchesNetworkFilterToken(request, { ...token, neg: false }),
      ).length,
      token,
    });
  }

  NETWORK_FILTER_FIELDS.filter(
    (field) => !value || field.key.startsWith(value.toLowerCase()),
  ).forEach((field) => {
    suggestions.push({
      kind: 'key',
      key: field.key,
      label: `${field.key}:`,
      hint: field.hint,
      neg,
    });
  });

  return suggestions;
}

export function appendNetworkFilterToken(
  currentTokens: NetworkFilterToken[],
  token: NetworkFilterToken,
) {
  const alreadyExists = currentTokens.some(
    (currentToken) =>
      currentToken.key === token.key &&
      currentToken.value === token.value &&
      currentToken.neg === token.neg &&
      !!currentToken.exact === !!token.exact,
  );
  return alreadyExists ? currentTokens : [...currentTokens, token];
}

export function getNetworkTransferredBytes(request: MobilePreviewNetworkRequest) {
  const length =
    getHeaderValue(request.responseHeaders, 'content-length') ??
    getHeaderValue(request.requestHeaders, 'content-length');
  const parsedLength = length ? Number.parseInt(length, 10) : Number.NaN;
  if (Number.isFinite(parsedLength)) return parsedLength;
  return (
    (request.requestBodyPreview?.length ?? 0) +
    (request.responseBodyPreview?.length ?? 0)
  );
}

export function getNetworkStats(requests: MobilePreviewNetworkRequest[]) {
  const failed = requests.filter(
    (request) =>
      request.error || (request.status !== null && request.status >= 400),
  ).length;
  const ok = requests.filter(
    (request) =>
      !request.error &&
      !request.tunnelOnly &&
      request.status !== null &&
      request.status >= 200 &&
      request.status < 400,
  ).length;
  const durations = requests
    .map((request) => request.durationMs)
    .filter((duration): duration is number => duration !== null);
  const avgDuration =
    durations.length === 0
      ? null
      : Math.round(
          durations.reduce((sum, duration) => sum + duration, 0) /
            durations.length,
        );
  const bytes = requests.reduce(
    (sum, request) => sum + getNetworkTransferredBytes(request),
    0,
  );
  return { total: requests.length, failed, ok, avgDuration, bytes };
}

export function getNetworkFacets(requests: MobilePreviewNetworkRequest[]) {
  const byPath = new Map<string, MobilePreviewNetworkRequest[]>();
  requests.forEach((request) => {
    const path = getNetworkPath(request.url);
    byPath.set(path, [...(byPath.get(path) ?? []), request]);
  });
  return [...byPath.entries()]
    .map(([path, facetRequests]) => ({
      path,
      count: facetRequests.length,
      failed: facetRequests.some(
        (request) =>
          request.error || (request.status !== null && request.status >= 400),
      ),
    }))
    .sort((firstFacet, secondFacet) => secondFacet.count - firstFacet.count);
}

export type NetworkPresetFilter = 'all' | 'errors' | 'post' | 'get';
export type NetworkDetailTab = 'all' | 'headers' | 'body' | 'request' | 'timing';
export type NetworkFilterContextMenuState = {
  x: number;
  y: number;
  title: string;
  subtitle: string;
  items: Array<{
    key: Exclude<NetworkFilterKey, 'text'>;
    value: string;
  }>;
};

export function matchesNetworkPreset(
  request: MobilePreviewNetworkRequest,
  preset: NetworkPresetFilter,
) {
  if (preset === 'errors') {
    return request.error || (request.status !== null && request.status >= 400);
  }
  if (preset === 'post') return request.method.toUpperCase() === 'POST';
  if (preset === 'get') return request.method.toUpperCase() === 'GET';
  return true;
}
