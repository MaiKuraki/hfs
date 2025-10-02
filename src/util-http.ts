// This file is part of HFS - Copyright 2021-2023, Massimo Melina <a@rejetto.com> - License https://www.gnu.org/licenses/gpl-3.0.txt

import { parse } from 'node:url'
import https from 'node:https'
import http, { IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'
import _ from 'lodash'
import { text as stream2string, buffer } from 'node:stream/consumers'
import * as tls from 'node:tls'
export { stream2string }

export async function httpString(url: string, options?: XRequestOptions): Promise<string> {
    return await stream2string(await httpStream(url, options))
}

export async function httpWithBody(url: string, options?: XRequestOptions): Promise<IncomingMessage & { ok: boolean, body: Buffer | undefined }> {
    const req = await httpStream(url, options)
    return Object.assign(req, {
        ok: _.inRange(req.statusCode!, 200, 300),
        body: req.statusCode ? await buffer(req) : undefined,
    })
}

export interface XRequestOptions extends https.RequestOptions {
    body?: string | Buffer | Readable
    proxy?: string // url format
    // very basic cookie store
    jar?: Record<string, string>
    noRedirect?: boolean
    // throw for http-level errors. Default is true.
    httpThrow?: boolean
}

export declare namespace httpStream { let defaultProxy: string | undefined }
export function httpStream(url: string, { body, proxy, jar, noRedirect, httpThrow=true, ...options }: XRequestOptions ={}) {
    const controller = new AbortController()
    options.signal ??= controller.signal
    return Object.assign(new Promise<IncomingMessage>(async (resolve, reject) => {
        proxy ??= httpStream.defaultProxy
        options.headers ??= {}
        if (body) {
            options.method ||= 'POST'
            if (_.isPlainObject(body)) {
                options.headers['content-type'] ??= 'application/json'
                body = JSON.stringify(body)
            }
            if (!(body instanceof Readable))
                options.headers['content-length'] ??= Buffer.byteLength(body)
        }
        if (jar)
            options.headers.cookie = _.map(jar, (v,k) => `${k}=${v}; `).join('')
                + (options.headers.cookie || '') // preserve parameter
        const { auth, ...parsed } = parse(url)
        const proxyParsed = proxy ? parse(proxy) : null
        Object.assign(options, _.pick(proxyParsed || parsed, ['hostname', 'port', 'path', 'protocol']))
        if (auth) {
            options.auth = auth
            if (proxy)
                url = parsed.protocol + '//' + parsed.host + parsed.path // rewrite without authentication part
        }
        if (proxy) {
            options.path = url // full url as path
            options.headers.host ??= parse(url).host || undefined // keep original host header
        }
        // this needs the prefix "proxy-"
        const proxyAuth = proxyParsed?.auth ? { 'proxy-authorization': `Basic ${Buffer.from(proxyParsed.auth, 'utf8').toString('base64')}` } : undefined

        // https through proxy is better with CONNECT
        if (!proxy || parsed.protocol === 'http:' || !await connect())
            Object.assign(options.headers, proxyAuth)

        const proto = options.protocol === 'https:' ? https : http
        const req = proto.request(options, res => {
            console.debug("http responded", res.statusCode, "to", url)
            if (jar) for (const entry of res.headers['set-cookie'] || []) {
                const [, k, v] = /(.+?)=([^;]+)/.exec(entry) || []
                if (!k) continue
                if (v) jar[k] = v
                else delete jar[k]
            }
            if (!res.statusCode || httpThrow && res.statusCode >= 400)
                return reject(new Error(String(res.statusCode), { cause: res }))
            let r = res.headers.location
            if (r && !noRedirect) {
                r = new URL(r, url).toString() // rewrite in case r is just a path, and thus relative to current url
                const stack = ((options as any)._stack ||= [])
                if (stack.length > 20 || stack.includes(r))
                    return reject(new Error('endless http redirection'))
                stack.push(r)
                delete options.method // redirections are always GET
                delete options.headers?.['content-length']
                delete options.auth
                return resolve(httpStream(r, options))
            }
            resolve(res)
        }).on('error', (e: any) => {
            if (proxy && e?.code === 'ECONNREFUSED')
                console.debug("cannot connect to proxy ", proxy)
            reject((req as any).res || e)
        })
        if (body && body instanceof Readable)
            body.pipe(req).on('end', () => req.end())
        else
            req.end(body)

        function connect() {
            return proxyParsed && new Promise<boolean>(resolve => {
                (proxyParsed.protocol === 'https:' ? https : http).request({
                    ...proxyParsed,
                    method: 'CONNECT',
                    path: `${parsed.hostname}:${parsed.port || 443}`,
                    auth: undefined,
                    headers: proxyAuth
                }).on('error', reject).on('connect', (res, socket) => {
                    if (res.statusCode !== 200)
                        return resolve(false)
                    // a TLS for every request is inefficient. Consider optimizing in the future, especially for reading plugins from github, which makes tens of requests.
                    options.createConnection = () => tls.connect({ socket, servername: parsed.hostname || undefined })
                    resolve(true)
                }).end()
            })
        }

    }), {
        abort() { controller.abort() }
    })
}
