/** Small JSON, validation and transport helpers. No dependency on a target product. */
import { randomUUID } from 'node:crypto';

export const uuid = () => randomUUID();
export const now = () => new Date().toISOString();
export const clone = (value) => structuredClone(value);
export const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
export const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const done = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
  });

export function at(value, path = '') {
  if (!path) return value;
  return path.split('.').reduce((cursor, key) => {
    assert(
      !['__proto__', 'constructor', 'prototype'].includes(key),
      'Unsafe JSON path',
    );
    return cursor != null && Object.hasOwn(Object(cursor), key)
      ? cursor[key]
      : undefined;
  }, value);
}

/** References retain their JSON type. Arbitrary expressions are never evaluated. */
export function bind(template, context) {
  if (typeof template === 'string' && template.startsWith('$')) {
    const value = at(context, template.slice(1));
    assert(value !== undefined, `Unbound reference ${template}`);
    return clone(value);
  }
  if (Array.isArray(template))
    return template.map((value) => bind(value, context));
  if (isObject(template))
    return Object.fromEntries(
      Object.entries(template).map(([key, value]) => [
        key,
        bind(value, context),
      ]),
    );
  return template;
}

export function safePath(path, context) {
  assert(
    typeof path === 'string' && path.startsWith('/') && !path.startsWith('//'),
    'An adapter path must be relative',
  );
  return path.replace(/\{([\w.]+)\}/g, (_, key) => {
    const value = at(context, key);
    assert(
      ['string', 'number'].includes(typeof value) && String(value).length > 0,
      `Unbound path ${key}`,
    );
    return encodeURIComponent(String(value));
  });
}

/** Secret environment values and common credential formats never enter reports or prompts. */
export function redact(value, secrets = []) {
  let text = JSON.stringify(value);
  for (const secret of secrets
    .filter((s) => typeof s === 'string' && s.length >= 6)
    .sort((a, b) => b.length - a.length))
    text = text.split(secret).join('[REDACTED]');
  text = text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(
      /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
      '[REDACTED JWT]',
    );
  const parsed = JSON.parse(text);
  const scrub = (item) => {
    if (Array.isArray(item)) return item.map(scrub);
    if (!isObject(item)) return item;
    return Object.fromEntries(
      Object.entries(item).map(([key, val]) => [
        key,
        /^(authorization|cookie|password|token|access_token|refresh_token|apiKey|api_key|secret)$/i.test(
          key,
        )
          ? '[REDACTED]'
          : scrub(val),
      ]),
    );
  };
  return scrub(parsed);
}

export class TransportError extends Error {
  constructor(message, { outcomeUnknown = false, status } = {}) {
    super(message);
    this.outcomeUnknown = outcomeUnknown;
    this.status = status;
  }
}

export async function jsonRequest(
  url,
  {
    method = 'GET',
    headers = {},
    body,
    signal,
    timeoutMs = 180000,
    fetchImpl = fetch,
  } = {},
) {
  const endpoint = new URL(url);
  assert(
    ['http:', 'https:'].includes(endpoint.protocol) &&
      !endpoint.username &&
      !endpoint.password,
    'Invalid HTTP endpoint',
  );
  const combined = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method,
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: combined,
    });
    const bytes = await response.text();
    assert(bytes.length <= 4_000_000, 'HTTP response exceeds 4 MB');
    const data = bytes ? JSON.parse(bytes) : {};
    if (!response.ok)
      throw new TransportError(`HTTP ${response.status}`, {
        status: response.status,
        outcomeUnknown: method !== 'GET' && response.status >= 500,
      });
    return { status: response.status, data };
  } catch (error) {
    if (error instanceof TransportError) throw error;
    throw new TransportError(
      'HTTP request did not produce a valid JSON receipt',
      { status: response?.status, outcomeUnknown: method !== 'GET' },
    );
  }
}

export function envHeaders(config = {}, env = process.env) {
  return Object.fromEntries(
    Object.entries(config).map(([header, envName]) => {
      assert(
        typeof envName === 'string' && env[envName],
        `Missing credential environment variable ${envName}`,
      );
      return [
        header,
        header.toLowerCase() === 'authorization' &&
        !/^(Bearer |Basic )/.test(env[envName])
          ? `Bearer ${env[envName]}`
          : env[envName],
      ];
    }),
  );
}
