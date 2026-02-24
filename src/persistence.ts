import { KvStorage } from '@rejetto/kvstorage'
import { MINUTE } from './misc'
import { onProcessExit } from './first'

export const storedMap = new KvStorage({
    defaultPutDelay: 5000,
    maxPutDelay: MINUTE,
    maxPutDelayCreate: 1000,
    rewriteLater: true,
    bucketThreshold: 10_000,
})
storedMap.open('data.kv').catch(e => {
    console.error(e?.message.includes('locked') ? `Check if another HFS is running on the same config folder – ${e.message}` : String(e))
    process.exit(3)
})
onProcessExit(() => storedMap.flush())
