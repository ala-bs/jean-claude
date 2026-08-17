const REDACTED = '[REDACTED]';
const SENSITIVE_KEY =
  /(?:authorization|auth(?:entication)?|cookie|csrf|xsrf|token|secret|password|passwd|session|credential|api[-_]?key|saml|assertion|signature|ticket|relaystate)/i;
const SENSITIVE_URL_KEY = /^(?:code|sig|state)$/i;
const URL_HEADER = /^(?:location|referer|referrer|content-location)$/i;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const SECRET_ASSIGNMENT =
  /(\b(?:auth(?:entication)?|token|access[_-]?token|refresh[_-]?token|csrf|xsrf|secret|password|passwd|session(?:id)?|credential|api[_-]?key|code|samlresponse|assertion|signature|ticket|relaystate)\b\s*[=:]\s*)([^&\s<>"']+)/gi;
const SECRET_XML_ELEMENT =
  /(<(auth(?:entication)?|token|access[_-]?token|refresh[_-]?token|csrf|xsrf|secret|password|passwd|session(?:id)?|credential|api[_-]?key|code|samlresponse|assertion|signature|ticket|relaystate)[^>]*>)([\s\S]*?)(<\/\2>)/gi;
const MAX_SAMPLE_LENGTH = 1_000;

function isSensitiveKey(key) {
  return SENSITIVE_KEY.test(key) || SENSITIVE_URL_KEY.test(key);
}

function sanitizeString(value) {
  const sanitized = value
    .replace(EMAIL, '[REDACTED_EMAIL]')
    .replace(JWT, REDACTED)
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(SECRET_ASSIGNMENT, `$1${REDACTED}`)
    .replace(SECRET_XML_ELEMENT, `$1${REDACTED}$4`);

  if (sanitized.length <= MAX_SAMPLE_LENGTH) return sanitized;
  return `${sanitized.slice(0, MAX_SAMPLE_LENGTH)}...[TRUNCATED]`;
}

function sanitizeValue(value, key = '') {
  if (isSensitiveKey(key)) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        sanitizeValue(childValue, childKey),
      ]),
    );
  }
  if (typeof value === 'string') return sanitizeString(value);
  return value;
}

export function sanitizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.username = '';
    url.password = '';
    const pathSegments = url.pathname.split('/');
    for (let index = 0; index < pathSegments.length - 1; index += 1) {
      if (isSensitiveKey(pathSegments[index])) {
        pathSegments[index + 1] = REDACTED;
      }
    }
    url.pathname = pathSegments.join('/');
    for (const [key] of url.searchParams) {
      if (isSensitiveKey(key)) {
        url.searchParams.set(key, REDACTED);
      }
    }
    if (url.hash && !url.hash.includes('=')) {
      url.hash = REDACTED;
    } else if (url.hash.includes('=')) {
      const fragment = new URLSearchParams(url.hash.slice(1));
      for (const [key] of fragment) {
        if (isSensitiveKey(key)) {
          fragment.set(key, REDACTED);
        }
      }
      url.hash = fragment.toString();
    }
    return url.toString();
  } catch {
    return sanitizeString(rawUrl);
  }
}

export function sanitizeHeaders(headers = []) {
  return headers.map(({ name, value }) => ({
    name,
    value: SENSITIVE_KEY.test(name)
      ? REDACTED
      : URL_HEADER.test(name)
        ? sanitizeUrl(value)
        : sanitizeString(value),
  }));
}

export function sanitizePayload(text, mimeType = '') {
  if (typeof text !== 'string') return undefined;

  if (mimeType.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(
      [...new URLSearchParams(text)].map(([key, value]) => [
        key,
        sanitizeValue(value, key),
      ]),
    );
  }

  if (mimeType.includes('multipart/form-data')) {
    return '[MULTIPART_BODY_OMITTED]';
  }

  if (mimeType.includes('json') || /^[\s]*[[{]/.test(text)) {
    try {
      return sanitizeValue(JSON.parse(text));
    } catch {
      // Some endpoints label non-JSON payloads as JSON.
    }
  }

  return sanitizeString(text);
}

function sanitizeHarContent(content = {}) {
  if (/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(content.mimeType ?? '')) {
    return {
      mimeType: content.mimeType,
      size: content.size,
      payload: '[HTML_BODY_OMITTED]',
    };
  }
  let text = content.text;
  if (content.encoding === 'base64' && typeof text === 'string') {
    if (!/^(?:application\/json|text\/|application\/(?:javascript|xml|x-www-form-urlencoded))/.test(content.mimeType ?? '')) {
      return {
        mimeType: content.mimeType,
        size: content.size,
        payload: '[BINARY_PAYLOAD_OMITTED]',
      };
    }
    text = Buffer.from(text, 'base64').toString('utf8');
  }

  return {
    mimeType: content.mimeType,
    size: content.size,
    payload: sanitizePayload(text, content.mimeType),
  };
}

export function sanitizeHar(har) {
  return {
    generatedAt: new Date().toISOString(),
    entries: (har?.log?.entries ?? []).map((entry) => ({
      startedDateTime: entry.startedDateTime,
      time: entry.time,
      request: {
        method: entry.request?.method,
        url: sanitizeUrl(entry.request?.url ?? ''),
        headers: sanitizeHeaders(entry.request?.headers),
        postData: entry.request?.postData
          ? {
              mimeType: entry.request.postData.mimeType,
              payload: sanitizePayload(
                entry.request.postData.text,
                entry.request.postData.mimeType,
              ),
            }
          : undefined,
      },
      response: {
        status: entry.response?.status,
        statusText: entry.response?.statusText,
        headers: sanitizeHeaders(entry.response?.headers),
        content: sanitizeHarContent(entry.response?.content),
      },
    })),
  };
}

export function sanitizeWebSocketEvents(events) {
  return events.map((event) => ({
    type: event.type,
    url: sanitizeUrl(event.url),
    ...(event.timestamp ? { timestamp: event.timestamp } : {}),
    ...(event.payloadBase64
      ? { payload: '[BINARY_PAYLOAD_OMITTED]' }
      : typeof event.payload === 'string'
        ? { payload: sanitizePayload(event.payload, 'application/json') }
        : {}),
  }));
}
