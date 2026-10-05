/**
 * Run the dev server's Connect-style provider middleware inside a fetch
 * handler (Cloudflare Pages Functions, or any runtime with Request/Response).
 *
 * The providers are written against Node's req/res: `res.writeHead`,
 * `setHeader`, `statusCode` and `end`, `req.url` relative to the mount
 * point, and `next()` to fall through to a later mount. They only ever send
 * one buffered body, so a fake response that collects it into a Response is
 * enough; nothing here streams.
 */

/**
 * Workers' fetch refuses `redirect: 'error'`, which the providers use so an
 * upstream can never bounce a request somewhere else. Keep that guarantee
 * the edge's way: fetch with 'manual' and fail on any redirect. Installed
 * once, before the providers first fetch.
 */
export function installEdgeFetch(scope = globalThis) {
  const original = scope.fetch;
  if (typeof original !== 'function' || original.__edgeRedirects) return;
  const edgeFetch = async (input, init) => {
    if (init?.redirect !== 'error') return original(input, init);
    const response = await original(input, { ...init, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      throw new TypeError('Upstream redirected, and redirects are refused');
    }
    return response;
  };
  edgeFetch.__edgeRedirects = true;
  scope.fetch = edgeFetch;
}

/** A minimal event emitter for the few listeners the providers attach. */
function emitter(target) {
  const listeners = new Map();
  const add = (name, fn, once = false) => {
    if (!listeners.has(name)) listeners.set(name, []);
    listeners.get(name).push({ fn, once });
    return target;
  };
  target.on = (name, fn) => add(name, fn);
  target.addListener = target.on;
  target.once = (name, fn) => add(name, fn, true);
  target.off = target.removeListener = (name, fn) => {
    const list = listeners.get(name);
    if (list)
      listeners.set(
        name,
        list.filter((entry) => entry.fn !== fn),
      );
    return target;
  };
  target.emit = (name, ...args) => {
    const list = listeners.get(name) ?? [];
    listeners.set(
      name,
      list.filter((entry) => !entry.once),
    );
    for (const entry of list) entry.fn(...args);
    return list.length > 0;
  };
  return target;
}

/** A Node-like request for `path` (already stripped of its mount). */
function nodeRequest(request, path, body) {
  const headers = {};
  for (const [key, value] of request.headers)
    headers[key.toLowerCase()] = value;
  const req = emitter({
    url: path,
    originalUrl: new URL(request.url).pathname + new URL(request.url).search,
    method: request.method,
    headers,
    socket: {
      // Per-client throttles key on this; behind Cloudflare the client is
      // the connecting IP the edge reports.
      remoteAddress:
        headers['cf-connecting-ip'] || headers['x-real-ip'] || '0.0.0.0',
      encrypted: new URL(request.url).protocol === 'https:',
    },
    aborted: false,
    async *[Symbol.asyncIterator]() {
      if (body.length) yield body;
    },
  });
  // Body-reading providers listen for data/end; deliver after they attach.
  queueMicrotask(() => {
    if (body.length) req.emit('data', body);
    req.emit('end');
  });
  return req;
}

/** A Node-like response that resolves `done` with a Response on end(). */
function nodeResponse() {
  let resolve;
  const done = new Promise((r) => {
    resolve = r;
  });
  const headers = new Headers();
  const res = emitter({
    statusCode: 200,
    statusMessage: '',
    headersSent: false,
    writableEnded: false,
    writableNeedDrain: false,
    destroyed: false,
    chunks: [],
    setHeader(name, value) {
      headers.delete(name);
      for (const item of Array.isArray(value) ? value : [value])
        headers.append(name, String(item));
      return res;
    },
    getHeader(name) {
      return headers.get(name) ?? undefined;
    },
    hasHeader(name) {
      return headers.has(name);
    },
    removeHeader(name) {
      headers.delete(name);
    },
    writeHead(status, message, extra) {
      res.statusCode = status;
      const values = typeof message === 'object' ? message : extra;
      for (const [name, value] of Object.entries(values ?? {}))
        res.setHeader(name, value);
      res.headersSent = true;
      return res;
    },
    write(chunk) {
      if (chunk != null) res.chunks.push(toBytes(chunk));
      res.headersSent = true;
      return true;
    },
    end(chunk, encoding, callback) {
      if (res.writableEnded) return res;
      if (typeof chunk === 'function') callback = chunk;
      else if (chunk != null) res.chunks.push(toBytes(chunk));
      res.writableEnded = true;
      res.headersSent = true;
      const body = concat(res.chunks);
      const status = res.statusCode || 200;
      // A status that may not carry a body must not be given one.
      const empty = status === 204 || status === 304;
      resolve(new Response(empty ? null : body, { status, headers }));
      queueMicrotask(() => res.emit('finish'));
      if (typeof callback === 'function') queueMicrotask(callback);
      return res;
    },
    destroy() {
      res.destroyed = true;
      res.emit('close');
    },
  });
  return { res, done };
}

const encoder = new TextEncoder();
function toBytes(chunk) {
  if (typeof chunk === 'string') return encoder.encode(chunk);
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  return encoder.encode(String(chunk));
}
function concat(chunks) {
  if (chunks.length === 1) return chunks[0];
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Collect the middleware a set of Vite plugins installs, in order, as
 * `[{ route, handler }]`, by calling each plugin's `configureServer` with a
 * stand-in server.
 */
export function collectMiddleware(plugins) {
  const stack = [];
  const server = {
    middlewares: {
      use(route, handler) {
        if (typeof route === 'function')
          stack.push({ route: '/', handler: route });
        else stack.push({ route, handler });
      },
    },
    httpServer: null,
    config: { command: 'serve', mode: 'production' },
  };
  for (const plugin of plugins) {
    const configure =
      plugin.configurePreviewServer ?? plugin.configureServer ?? null;
    configure?.call(plugin, server);
  }
  return stack;
}

/** Whether a mount at `route` handles `pathname`, Connect's way. */
function mountMatches(route, pathname) {
  if (route === '/') return true;
  if (!pathname.startsWith(route)) return false;
  const next = pathname.charAt(route.length);
  return next === '' || next === '/' || next === '?' || next === '.';
}

/**
 * Dispatch a fetch Request through the middleware stack. Resolves null when
 * no middleware answered, so the caller can fall through.
 */
export async function runMiddleware(stack, request) {
  const url = new URL(request.url);
  const body =
    request.method === 'GET' || request.method === 'HEAD'
      ? new Uint8Array(0)
      : new Uint8Array(await request.arrayBuffer());
  const { res, done } = nodeResponse();
  // Aborted requests close the response, which providers listen for.
  request.signal?.addEventListener?.('abort', () => res.destroy(), {
    once: true,
  });
  let index = 0;
  const fallthrough = Symbol('fallthrough');
  let unanswered;
  const finished = new Promise((r) => {
    unanswered = () => r(fallthrough);
  });

  const next = (error) => {
    if (error) {
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'Provider error' }));
      }
      return;
    }
    while (index < stack.length) {
      const { route, handler } = stack[index++];
      if (!mountMatches(route, url.pathname)) continue;
      const rest = url.pathname.slice(route === '/' ? 0 : route.length) || '/';
      const req = nodeRequest(request, rest + url.search, body);
      try {
        const result = handler(req, res, next);
        if (result && typeof result.catch === 'function')
          result.catch((err) => next(err));
      } catch (err) {
        next(err);
      }
      return;
    }
    unanswered();
  };
  next();
  const outcome = await Promise.race([done, finished]);
  return outcome === fallthrough ? null : outcome;
}
