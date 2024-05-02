import { defineConfig } from './config'
import { Callback, CFG, HOUR, repeat, replace, splitAt } from './cross'
import _ from 'lodash'
import { httpWithBody } from './util-http'
import { isIPv4 } from 'node:net'
import { isIPv6 } from 'net'
import { VERSION } from './const'
import events from './events'
import { once } from 'stream'
import { getPublicIps } from './nat'

// optionally you can append '>' and a regular expression to determine what body is considered successful
const dynamicDnsUrl = defineConfig(CFG.dynamic_dns_url, '')

let stop: Callback | undefined
export interface DynamicDnsResult { ts: string, error: string, url: string }
let last: undefined | DynamicDnsResult
dynamicDnsUrl.sub(v => {
    stop?.()
    if (!v) return
    let lastIps: any
    stop = repeat(HOUR, async () => {
        const ips = await getPublicIps()
        if (_.isEqual(lastIps, ips)) return
        lastIps = ips
        const all = await Promise.all(v.split('\n').map(async line => {
            const [templateUrl, re] = splitAt('>', line)
            const url = replace(templateUrl, {
                IPX: ips[0] || '',
                IP4: _.find(ips, isIPv4) || '',
                IP6: _.find(ips, isIPv6) || '',
            }, '$')
            const error = await httpWithBody(url, { httpThrow: false, headers: { 'User-Agent': "HFS/" + VERSION } }) // UA specified as requested by no-ip guidelines
                .then(async res => {
                    const str = String(res.body).trim()
                    return (re ? str.match(re) : res.ok) ? '' : (str || res.statusMessage)
                }, (err: any) => err.code || err.message || String(err) )
            return { ts: new Date().toJSON(), error, url }
        }))
        last = _.find(all, 'error') || all[0] // the system is designed for just one result, and we give precedence to errors
        events.emit('dynamicDnsError', last)
        console.log('dynamic dns update', last?.error || 'ok')
    })
})

export async function* get_dynamic_dns_error() {
    while (1) {
        yield last
        await once(events, 'dynamicDnsError')
    }
}