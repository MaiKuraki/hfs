import { srpClientSequence } from '../src/srp'
import { createReadStream, statSync } from 'fs'
import { basename, dirname, resolve } from 'path'
import { exec } from 'child_process'
import _ from 'lodash'
import { findDefined, randomId, try_, tryJson, wait } from '../src/cross'
import { httpStream, stream2string, XRequestOptions } from '../src/util-http'
import { ThrottledStream, ThrottleGroup } from '../src/ThrottledStream'
import { rm, writeFile } from 'fs/promises'
import { Readable } from 'stream'
/*
import { PORT, srv } from '../src'

process.chdir('..')
const appStarted = new Promise(resolve =>
    srv.on( 'app_started', resolve) )
*/

const username = 'rejetto'
const password = 'password'
const API = '/~/api/'
const ROOT = 'tests/'
const BASE_URL = 'http://localhost:81'
const UPLOAD_ROOT = '/for-admins/upload/'
const UPLOAD_RELATIVE = 'temp/gpl.png'
const UPLOAD_DEST = UPLOAD_ROOT + UPLOAD_RELATIVE
const BIG_CONTENT = _.repeat(randomId(10), 200_000) // 2MB, big enough to saturate buffers
const throttle = BIG_CONTENT.length /1000 /0.8 // KB, finish in 0.8s, quick but still overlapping downloads
const SAMPLE_FILE_PATH = resolve(__dirname, 'page/gpl.png')
let defaultBaseUrl = BASE_URL

class StringRepeaterStream extends Readable {
    constructor(private str: string, private n: number, readonly length=n*str.length) {
        super()
    }
    _read() {
        this.push(this.n-- > 0 ? this.str : null)
    }
}

function makeReadableThatTakes(ms: number) {
    return Object.assign(Readable.from(BIG_CONTENT).pipe(new ThrottledStream(new ThrottleGroup(BIG_CONTENT.length / ms))),
        { length: BIG_CONTENT.length })
}

describe('basics', () => {
    //before(async () => appStarted)
    it('frontend', req('/', /<body>/, { headers: { accept: '*/*' } })) // workaround: 'accept' is necessary when running server-for-test-dev, still don't know why
    it('force slash', req('/f1', 302, { noRedirect: true }))
    it('list', reqList('/f1/', { inList:['f2/', 'page/'] }))
    it('search', reqList('f1', { inList:['f2/'], outList:['page'] }, { search:'2' }))
    it('search root', reqList('/', { inList:['cantListPage/'], outList:['cantListPage/page/'] }, { search:'page' }))
    it('download.mime', req('/f1/f2/alfa.txt', { re:/abcd/, mime:'text/plain' }))
    it('download.partial', req('/f1/f2/alfa.txt', /a[^d]+$/, { // only "abc" is expected
        headers: { Range: 'bytes=0-2' }
    }))
    it('bad range', req('/f1/f2/alfa.txt', 416, {
        headers: { Range: 'bytes=7-' }
    }))
    it('roots', req('/f2/alfa.txt', 200, { baseUrl: BASE_URL.replace('localhost', '127.0.0.1') })) // host 127.0.0.1 is rooted in /f1
    it('website', req('/f1/page/', { re:/This is a test/, mime:'text/html' }))
    it('traversal', req('/f1/page/.%2e/.%2e/README.md', 418))
    it('custom mime from above', req('/tests/page/index.html', { status: 200, mime:'text/plain' }))
    it('name encoding', req('/x%25%23x', 200))

    it('missing perm', reqList('/for-admins/', 401))
    it('missing perm.file', req('/for-admins/alfa.txt', 401))

    it('forbidden list', req('/cantListPage/page/', 403))
    it('forbidden list.api', reqList('/cantListPage/page/', 403))
    it('forbidden list.cant see', reqList('/cantListPage/', { outList:['page/'] }))
    it('forbidden list.but readable file', req('/cantListPage/page/gpl.png', 200))
    it('forbidden list.alternative method', reqList('/cantListPageAlt/page/', 403))
    it('forbidden list.match **', req('/cantListPageAlt/page/gpl.png', 401))

    it('cantListBut', reqList('/cantListBut/', 403))
    it('cantListBut.zip', req('/cantListBut/?get=zip', 403))
    it('cantListBut.parent', reqList('/', { permInList: { 'cantListBut/': 'l' } }))
    it('cantListBut.child masked', reqList('/cantListBut/page', 200))
    it('cantSearchForMasks', reqList('/', { outList: ['cantSearchForMasks/page/gpl.png'] }, { search: 'gpl' }))
    it('cantReadBut', reqList('/cantReadBut/', 403))
    it('cantReadBut.can', req('/cantReadBut/alfa.txt', 200))
    it('cantReadBut.parent', reqList('/', { permInList: { 'cantReadBut/': '!r' } }))
    it('cantReadButChild', req('/cantReadButChild/alfa.txt', 401))
    it('cantReadButChild.parent', reqList('/', { permInList: { 'cantReadButChild/': 'R' } }))

    it('cantReadPage', reqList('/cantReadPage/page', 403))
    it('cantReadPage.zip', req('/cantReadPage/page/?get=zip', 403, { method:'HEAD' }))
    it('cantReadPage.file', req('/cantReadPage/page/gpl.png', 403))
    it('cantReadPage.parent', reqList('/cantReadPage', { permInList: { 'page/': 'lr' } }))
    it('cantReadRealFolder', reqList('/cantReadRealFolder', 403))
    it('cantReadRealFolder.file', req('/cantReadRealFolder/page/gpl.png', 403))

    it('renameChild', reqList('/renameChild/tests', { inList:['renamed1'] }))
    it('renameChild.get', req('/renameChild/tests/renamed1', /abc/))
    it('renameChild.deeper', reqList('/renameChild/tests/page', { inList:['renamed2'] }))
    it('renameChild.get deeper', req('/renameChild/tests/page/renamed2', /PNG/))

    it('cantSeeThis', reqList('/', { outList:['cantSeeThis/'] }))
    it('cantSeeThis.children', reqList('/cantSeeThis', { outList:['hi/'] }))
    it('cantSeeThisButChildren', reqList('/', { outList:['cantSeeThisButChildren/'] }))
    it('cantSeeThisButChildren.children', reqList('/cantSeeThisButChildren', { inList:['hi/'] }))
    it('cantZipFolder', req('/cantSeeThisButChildren/?get=zip', 403))
    it('cantZipFolder.butChildren', req('/cantSeeThisButChildren/hi/?get=zip', 200))
    it('cantSeeThisButChildrenMasks', reqList('/', { outList:['cantSeeThisButChildrenMasks/'] }))
    it('cantSeeThisButChildrenMasks.children', reqList('/cantSeeThisButChildrenMasks', { inList:['hi/'] }))

    it('masks.only', reqList('/cantSeeThisButChildren/hi', { inList:['page/'] }))
    it('masks.only.fromDisk', reqList('/cantSeeThisButChildren/hi/page', 403))
    it('masks.only.fromDisk.file', req('/cantSeeThisButChildren/hi/page/gpl.png', 403))

    it('protectFromAbove', req('/protectFromAbove/child/alfa.txt', 403))
    it('protectFromAbove.list', reqList('/protectFromAbove/child/', { inList:['alfa.txt'] }))
    it('inheritNegativeMask', reqList('/tests/page', { outList: ['index.html'] }))

    const zipSize = 13010
    const zipOfs = 0x1359
    it('zip.head', req('/f1/?get=zip', { empty:true, length:zipSize }, { method:'HEAD' }) )
    it('zip.partial', req('/f1/?get=zip', { re:/^C3$/, length: 2 }, { headers: { Range: `bytes=${zipOfs}-${zipOfs+1}` } }) )
    it('zip.partial.resume', req('/f1/?get=zip', { re:/^C3/, length:zipSize-zipOfs }, { headers: { Range: `bytes=${zipOfs}-` } }) )
    it('zip.partial.end', req('/f1/f2/?get=zip', { re:/^6/, length:10 }, { headers: { Range: 'bytes=-10' } }) )
    it('zip.alfa is forbidden', req('/protectFromAbove/child/?get=zip&list=alfa.txt//renamed', { empty: true, length:118 }, { method:'HEAD' }))
    it('zip.cantReadPage', req('/cantReadPage/?get=zip', { length: 4800 }, { method:'HEAD' }))

    it('referer', req('/f1/page/gpl.png', 403, {
        headers: { Referer: 'https://some-website.com/try-to-trick/x.com/' }
    }))

    it('upload.need account', reqUpload( UPLOAD_DEST, 401))
    it('upload.post', done => { // this is also testing basic-auth
        const cmd = `curl -u ${username}:${password} -F upload=@${SAMPLE_FILE_PATH} ${BASE_URL}${UPLOAD_ROOT}`;
        exec(cmd, (err, out) => {
            if (err) return done(err)
            const fn = resolve(__dirname, basename(decodeURI(tryJson(out)?.uris?.[0])))
            if (!fn) return done("unexpected output " + out)
            try {
                const stats = statSync(fn)
                rm(fn).catch(() => {}) // clear
                done(stats?.size !== statSync(SAMPLE_FILE_PATH).size && "unexpected size for " + fn)
            }
            catch (e) { done(e) }
        })
    })
    it('create_folder', reqApi('create_folder', { uri: UPLOAD_ROOT, name: 'temp' }, 401))
    it('delete.no perm', req('/for-admins/', 405, { method: 'delete' }))
    it('delete.need account', req(UPLOAD_ROOT, 401, { method: 'delete'}))
    it('rename.no perm', reqApi('rename', { uri: '/for-admins', dest: 'any' }, 401))
    it('of_disabled.cantLogin', () => login('of_disabled').then(() => { throw Error('logged in') }, () => 0))
    it('allow_net.canLogin', () => login('rejetto')) // localhost is normally resolved as ::1
    it('allow_net.cantLogin', () => {
        defaultBaseUrl = BASE_URL.replace('localhost', '127.0.0.1')
        return login('rejetto').then(() => { throw Error('logged in') }, () => 0)
            .finally(() => defaultBaseUrl = BASE_URL)
    })

    it('folder size', reqApi('get_folder_size', { uri: 'f1/page' }, res => res.bytes === 6328 ))
    it('folder size.cant', reqApi('get_folder_size', { uri: 'for-admins' }, 401))

    it('get_accounts', reqApi('get_accounts', {}, 401)) // admin api requires login
    it('url login', done =>
        exec(`curl -v "${BASE_URL}/for-admins/?login=${username}:${password}"`, (err, out) =>
            done(err || (out?.includes('Redirect') ? null : "failed")) ) )
})

// do this before login, or max_dl_accounts config will override max_dl
describe('limits', () => {
    const fn = ROOT + 'big'
    before(() => writeFile(fn, BIG_CONTENT))
    it('max_dl', () => testMaxDl('/' + fn, 1, 2))
    after(() => rm(fn))
})

describe('accounts', () => {
    before(() => login(username))
    it('get_accounts', reqApi('get_accounts', {}, ({ list }) => _.find(list, { username }) && _.find(list, { username: 'admins' })))
    const add = 'test-Add'
    it('accounts.add', reqApi('add_account', { username: add, overwrite: true }, res => res?.username === add.toLowerCase()))
    it('accounts.remove', reqApi('del_account', { username: add }, 200))
})

describe('after-login', () => {
    before(() => login(username))
    it('create_folder', reqApi('create_folder', { uri: UPLOAD_ROOT, name: 'temp' }, 200))
    it('inherit.perm', reqList('/for-admins/', { inList:['alfa.txt'] }))
    it('inherit.disabled', reqList('/for-disabled/', 401))
    it('upload.never', reqUpload('/random', 403))
    it('upload.ok', reqUpload(UPLOAD_DEST, 200))
    it('upload.crossing', reqUpload(UPLOAD_DEST.replace('temp', '../..'), 418))
    it('upload.overlap', async () => {
        const ms = 300
        const first = reqUpload(UPLOAD_DEST, 200, makeReadableThatTakes(ms))()
        await wait(ms/3)
        await reqUpload(UPLOAD_DEST, 409)() // should conflict
        await first
    })
    it('upload.concurrent', () => Promise.all([
        reqUpload(UPLOAD_DEST, 200, new StringRepeaterStream(BIG_CONTENT, 150))(), // 300MB
        ..._.range(3).map(i =>  reqUpload(UPLOAD_DEST + i, 200, new StringRepeaterStream(BIG_CONTENT, 50))()) // 3 x 100MB
    ])).timeout(5000)
    it('upload.interrupted', async () => {
        const fn = resolve(__dirname, UPLOAD_RELATIVE.replace('/', '/hfs$upload-'))
        await rm(fn, {force: true})
        const neededTime = 300
        const makeAbortedRequest = (afterMs: number) => {
            const r = reqUpload(UPLOAD_DEST, 0, makeReadableThatTakes(neededTime))()
            setTimeout(r.abort, afterMs)
            return r.catch(() => {}) // wait for it to fail
        }
        const timeFirstRequest = neededTime * .5 // not enough to finish
        await makeAbortedRequest(timeFirstRequest)
        const getTempSize = () => try_(() => statSync(fn)?.size)
        const size = getTempSize()
        if (!size) // shouldn't be empty
            throw Error("missing temp file")
        await makeAbortedRequest(timeFirstRequest * .5) // upload less than r1
        if (size !== getTempSize()) // shouldn't change, as r2 is smaller
            throw Error("modified temp file")
        await makeAbortedRequest(timeFirstRequest * 1.5) // upload more than r1
        if (!(size < getTempSize()!)) // should be increased
            throw Error("temp file not enlarged")
        await reqUpload(UPLOAD_DEST, 200, makeReadableThatTakes(0))() // quickly complete the upload, and check for final size
        if (getTempSize())
            throw Error("temp file should be cleared")
        // test resume
        await makeAbortedRequest(timeFirstRequest)
        const partial = getTempSize()
        if (!partial)
            throw Error("partial file missing")
        await reqUpload(UPLOAD_DEST, 200, Readable.from(BIG_CONTENT.slice(partial)), BIG_CONTENT.length, partial)()
    })
    const renameTo = 'z'
    it('rename.ok', reqApi('rename', { uri: UPLOAD_DEST, dest: renameTo }, 200))
    it('delete.miss renamed', req(UPLOAD_DEST, 404, { method: 'delete' }))
    it('delete.ok', req(dirname(UPLOAD_DEST) + '/' + renameTo, 200, { method: 'delete' }))
    it('reupload', reqUpload(UPLOAD_DEST, 200))
    it('delete.method', req(UPLOAD_DEST, 200, { method: 'DELETE' }))
    it('delete.miss deleted', req(UPLOAD_DEST, 404, { method: 'delete' }))
    it('upload.too much', reqUpload(UPLOAD_ROOT + 'temp/tooMuch', 400, BIG_CONTENT, BIG_CONTENT.length / 2)) // 400 is caused by nodejs itself, intercepting the mismatch
    it('max_dl.account', async () => {
        const uri = UPLOAD_ROOT + 'temp/big'
        await reqUpload(uri, 200, BIG_CONTENT)()
        await testMaxDl(uri, 2, 1)
    })
    after(() => rm(resolve(__dirname, 'temp'), { recursive: true }).catch(() => 0))
})

function login(usr: string, pwd=password) {
    return srpClientSequence(usr, pwd, (cmd: string, params: any) =>
        reqApi(cmd, params, (x,res)=> res.statusCode < 400)())
}

function reqUpload(dest: string, tester: Tester, body?: string | Readable, size?: number, resume?: number) {
    if (resume)
        dest += '?resume=' + resume
    size ??= (body as any)?.length ?? statSync(SAMPLE_FILE_PATH).size  // it's ok that Readable.length is undefined
    if (tester === 200)
        tester = {
            status: tester,
            cb(data) {
                const fn = ROOT + decodeURI(data.uri).replace(UPLOAD_ROOT, '')
                const stats = try_(() => statSync(fn))
                if (!stats)
                    throw Error("uploaded file not found: " + fn)
                if (size !== stats.size)
                    throw Error(`uploaded file wrong size: ${fn} = ${stats.size.toLocaleString()} expected ${size?.toLocaleString()}`)
                return true
            }
        }
    return req(dest, tester, {
        method: 'PUT',
        headers: { 'content-length': size === undefined ? size : size - (resume||0) },
        body: body ?? createReadStream(SAMPLE_FILE_PATH)
    })
}

async function testMaxDl(uri: string, good: number, bad: number) {
    let i = 0
    const reqs = []
    while (good--)
        reqs.push( req(uri + '?' + (++i), 200, { throttle })() )
    await wait(1) // ensure the requests are worked by hfs before the next ones, and slots are taken. This is subject to race conditions: if the operations take less than this, the test will fail
    while (bad--)
        reqs.push( req(uri + '?' + (++i), 429, { throttle })() )
    await Promise.all(reqs)
}

type TesterFunction = ((data: any, fullResponse: any) => boolean)
type Tester = number
    | TesterFunction
    | RegExp
    | {
        mime?: string
        status?: number
        re?: RegExp
        inList?: string[]
        outList?: string[]
        permInList?: Record<string, string>
        empty?: true
        length?: number
        cb?: TesterFunction
    }

const jar = {}

function req(url: string, test:Tester, { baseUrl, throttle, ...requestOptions }: XRequestOptions & { throttle?: number, baseUrl?: string }={}) {
    // passing 'path' keeps it as it is, avoiding internal resolving
    let abortable // copy abortable interface to returned promise
    return () => Object.assign((abortable = httpStream((baseUrl || defaultBaseUrl) + url, { path: url, jar, ...requestOptions })).catch(e => {
        if (e.code === 'ECONNREFUSED')
            throw e
        return e.cause
    }).then(process), _.pick(abortable, 'abort'))

    async function process(res:any) {
        //console.debug('sent', requestOptions, 'got', res instanceof Error ? String(res) : [res.status])
        if (test && test instanceof RegExp)
            test = { re:test }
        if (typeof test === 'number')
            test = { status: test }
        const stream = throttle ? res.pipe(new ThrottledStream(new ThrottleGroup(throttle))) : res
        const data = await stream2string(stream)
        const obj = tryJson(data)
        if (typeof test === 'object') {
            let { status, mime, re, inList, outList, length, permInList } = test
            if (inList || outList)
                status ||= 200
            const gotMime = res.headers?.['content-type']
            const gotStatus = res.statusCode
            const gotLength = res.headers?.['content-length']
            const err = mime && !gotMime?.startsWith(mime) && 'expected mime ' + mime + ' got ' + gotMime
                || status && gotStatus !== status && 'expected status ' + status + ' got ' + gotStatus
                || re && !re.test(data) && 'expected content '+String(re)+' got '+(data || '-empty-')
                || inList && !inList.every(x => isInList(obj, x)) && 'expected in list '+inList
                || outList && !outList.every(x => !isInList(obj, x)) && 'expected not in list '+outList
                || permInList && findDefined(permInList, (v, k) => {
                    const got = _.find(obj.list, { n: k })?.p
                    const negate = v[0] === '!'
                    return findDefined(v.slice(negate ? 1 : 0).split(''), char =>
                        got?.includes(char) === negate ? `expected perm ${v} on ${k}, got ${got}` : undefined)
                })
                || test.empty && data && 'expected empty body'
                || length !== undefined && gotLength !== String(length) && "expected content-length " + length + " got " + gotLength
                || test.cb?.(obj ?? data, res) === false && 'error'
                || ''
            if (err)
                throw Error(err)
        }
        if (typeof test === 'function')
            if (!test(obj ?? data, res))
                throw Error("failed test: " + test)
        return obj ?? data
    }
}

function reqApi(api: string, params: object, test:Tester) {
    const isGet = api.startsWith('/')
    return req(API+api, test, {
        body: JSON.stringify(params),
        headers: isGet ? undefined : { 'x-hfs-anti-csrf': '1'}
    })
}

function reqList(uri:string, tester:Tester, params?: object) {
    return reqApi('get_file_list', { uri, ...params }, tester)
}

function isInList(res:any, name:string) {
    return Array.isArray(res?.list) && Boolean((res.list as any[]).find(x => x.n===name))
}