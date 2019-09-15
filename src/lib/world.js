import ndHash from 'ndarray-hash'
import { EventEmitter } from 'events'
import Chunk from './chunk'
import { makeProfileHook } from './util'

const PROFILE = 0
const PROFILE_QUEUES = 0


const defaultOptions = {
    chunkSize: 24,
    chunkAddDistance: 3,
    chunkRemoveDistance: 4
}

/**
 * @class
 * @typicalname noa.world
 * @emits worldDataNeeded(id, ndarray, x, y, z)
 * @emits chunkAdded(chunk)
 * @emits chunkChanged(chunk)
 * @emits chunkBeingRemoved(id, ndarray, userData)
 * @emits chunkMeshUpdated(chunk) Called when the chunk's mesh has been updated
 * @classdesc Manages the world and its chunks
 * 
 * Extends `EventEmitter`
 */

export default class World extends EventEmitter {
    constructor(noa, opts) {
        super()

        this.noa = noa
        opts = Object.assign({}, defaultOptions, opts)

        this.userData = null
        this.playerChunkLoaded = false
        this.Chunk = Chunk

        this.chunkSize = opts.chunkSize
        this.chunkAddDistance = opts.chunkAddDistance
        this.chunkRemoveDistance = opts.chunkRemoveDistance
        if (this.chunkRemoveDistance < this.chunkAddDistance) {
            this.chunkRemoveDistance = this.chunkAddDistance
        }

        // internals
        this._chunkIDsToAdd = []
        this._chunkIDsToRemove = []
        this._chunkIDsInMemory = []
        this._chunkIDsToCreate = []
        this._chunkIDsToMesh = []
        this._chunkIDsToMeshFirst = []
        this._maxChunksPendingCreation = 20
        this._maxChunksPendingMeshing = 20
        this._maxProcessingPerTick = 9 // ms
        this._maxProcessingPerRender = 5 // ms

        // triggers a short visit to the meshing queue before renders
        const self = this
        noa.on('beforeRender', () => { beforeRender(self) })

        // actual chunk storage - hash size hard coded for now
        this._chunkHash = ndHash([1024, 1024, 1024])

        // instantiate coord conversion functions based on the chunk size
        // use bit twiddling if chunk size is a power of 2
        const cs = this.chunkSize
        if (cs & cs - 1 === 0) {
            const shift = Math.log2(cs) | 0
            const mask = (cs - 1) | 0
            worldCoordToChunkCoord = coord => (coord >> shift) | 0
            worldCoordToChunkIndex = coord => (coord & mask) | 0
        } else {
            worldCoordToChunkCoord = coord => Math.floor(coord / cs) | 0
            worldCoordToChunkIndex = coord => (((coord % cs) + cs) % cs) | 0
        }

    }

    /*
     *   PUBLIC API 
     */



    /** @param x,y,z */
    getBlockID(x, y, z) {
        const chunk = this._getChunkByCoords(x, y, z)
        if (!chunk) return 0

        const ix = worldCoordToChunkIndex(x)
        const iy = worldCoordToChunkIndex(y)
        const iz = worldCoordToChunkIndex(z)
        return chunk.get(ix, iy, iz)
    }

    /** @param x,y,z */
    getBlockSolidity(x, y, z) {
        const chunk = this._getChunkByCoords(x, y, z)
        if (!chunk) return 0

        const ix = worldCoordToChunkIndex(x)
        const iy = worldCoordToChunkIndex(y)
        const iz = worldCoordToChunkIndex(z)
        return !!chunk.getSolidityAt(ix, iy, iz)
    }

    /** @param x,y,z */
    getBlockOpacity(x, y, z) {
        const id = this.getBlockID(x, y, z)
        return this.noa.registry.getBlockOpacity(id)
    }

    /** @param x,y,z */
    getBlockFluidity(x, y, z) {
        const id = this.getBlockID(x, y, z)
        return this.noa.registry.getBlockFluidity(id)
    }

    /** @param x,y,z */
    getBlockProperties(x, y, z) {
        const id = this.getBlockID(x, y, z)
        return this.noa.registry.getBlockProps(id)
    }

    /** @param x,y,z */
    getBlockObjectMesh(x, y, z) {
        const chunk = this._getChunkByCoords(x, y, z)
        if (!chunk) return 0

        const ix = worldCoordToChunkIndex(x)
        const iy = worldCoordToChunkIndex(y)
        const iz = worldCoordToChunkIndex(z)
        return chunk.getObjectMeshAt(ix, iy, iz)
    }

    /** @param x,y,z */
    setBlockID(val, x, y, z) {
        const i = worldCoordToChunkCoord(x)
        const j = worldCoordToChunkCoord(y)
        const k = worldCoordToChunkCoord(z)
        const ix = worldCoordToChunkIndex(x)
        const iy = worldCoordToChunkIndex(y)
        const iz = worldCoordToChunkIndex(z)

        // if update is on chunk border, update neighbor's padding data too
        _updateChunkAndBorders(this, i, j, k, this.chunkSize, ix, iy, iz, val)
    }

    /** @param x,y,z */
    isBoxUnobstructed(box) {
        const base = box.base
        const max = box.max
        for (let i = Math.floor(base[0]); i < max[0] + 1; i++) {
            for (let j = Math.floor(base[1]); j < max[1] + 1; j++) {
                for (let k = Math.floor(base[2]); k < max[2] + 1; k++) {
                    if (this.getBlockSolidity(i, j, k)) return false
                }
            }
        }
        return true
    }

    tick() {
        profile_hook('start')

        // check player position and needed/unneeded chunks
        const pos = getPlayerChunkCoords(this)
        const chunkID = getChunkID(pos[0], pos[1], pos[2])
        if (chunkID != this._lastPlayerChunkID) {
            this.emit('playerEnteredChunk', pos[0], pos[1], pos[2])
            buildChunkAddQueue(this, pos[0], pos[1], pos[2])
            buildChunkRemoveQueue(this, pos[0], pos[1], pos[2])
        }
        this._lastPlayerChunkID = chunkID
        profile_hook('build queues')

        // process (create or mesh) some chunks. If fast enough, do several
        profile_queues(this, 'start')
        const cutoff = performance.now() + this._maxProcessingPerTick
        let done = false
        while (!done && (performance.now() < cutoff)) {
            const d1 = processMeshingQueues(this, false)
            let d2 = processChunkQueues(this)
            if (!d2) d2 = processChunkQueues(this)
            done = d1 && d2
        }
        profile_queues(this, 'end')


        // track whether the player's local chunk is loaded and ready or not
        const pChunk = getChunk(this, pos[0], pos[1], pos[2])
        const okay = !!(pChunk && pChunk.isGenerated && !pChunk.isInvalid)
        this.playerChunkLoaded = okay

        profile_hook('end')
    }

    /** client should call this after creating a chunk's worth of data (as an ndarray)  
     * If userData is passed in it will be attached to the chunk
     * @param id
     * @param array
     * @param userData
     */
    setChunkData(id, array, userData) {
        profile_queues(this, 'received')
        const arr = parseChunkID(id)
        const chunk = getChunk(this, arr[0], arr[1], arr[2])
        // ignore if chunk was invalidated while being prepared
        if (!chunk || chunk.isInvalid) return
        chunk.array = array
        if (userData) chunk.userData = userData
        chunk.initData()
        enqueueID(id, this._chunkIDsInMemory)
        unenqueueID(id, this._chunkIDsToCreate)

        // chunk can now be meshed...
        this.noa.rendering.prepareChunkForRendering(chunk)
        enqueueID(id, this._chunkIDsToMesh)
        this.emit('chunkAdded', chunk)
    }

    /*
     * Calling this causes all world chunks to get unloaded and recreated 
     * (after receiving new world data from the client). This is useful when
     * you're teleporting the player to a new world, e.g.
     */
    invalidateAllChunks() {
        const toInval = this._chunkIDsInMemory.concat(this._chunkIDsToCreate)
        for (const id of toInval) {
            const loc = parseChunkID(id)
            const chunk = getChunk(this, loc[0], loc[1], loc[2])
            chunk.isInvalid = true
        }
        // this causes chunk queues to get rebuilt next tick
        this._lastPlayerChunkID = ''
    }

    // debugging
    report() {
        console.log('World report - playerChunkLoaded: ', this.playerChunkLoaded)
        _report(this, '  to add     ', this._chunkIDsToAdd)
        _report(this, '  to remove: ', this._chunkIDsToRemove)
        _report(this, '  in memory: ', this._chunkIDsInMemory, true)
        _report(this, '  creating:  ', this._chunkIDsToCreate)
        _report(this, '  meshing:   ', this._chunkIDsToMesh.concat(this._chunkIDsToMeshFirst))
    }

    // for internal use
    _getChunkByCoords(x, y, z) {
        const i = worldCoordToChunkCoord(x)
        const j = worldCoordToChunkCoord(y)
        const k = worldCoordToChunkCoord(z)
        return getChunk(this, i, j, k)
    }
}

var worldCoordToChunkCoord
var worldCoordToChunkIndex




function beforeRender(self) {
    // on render, quickly process the high-priority meshing queue
    // to help avoid flashes of background while neighboring chunks update
    const cutoff = performance.now() + self._maxProcessingPerRender
    let done = false
    while (!done && (performance.now() < cutoff)) {
        done = processMeshingQueues(self, true)
    }
}




function _report(world, name, arr, ext) {
    let ct = 0
    let full = 0
    let empty = 0
    for (const id of arr) {
        if (id.size) {
            if (id.isInvalid) ct++
            continue
        }
        const loc = parseChunkID(id)
        const chunk = getChunk(world, loc[0], loc[1], loc[2])
        if (chunk.isInvalid) ct++
        if (chunk.isFull) full++
        if (chunk.isEmpty) empty++
    }
    const len = (`${arr.length}        `).substr(0, 6)
    const es = (ext) ? [', ', full, ' full, ', empty, ' empty'].join('') : ''
    console.log(name, len, ct, `invalid${es}`)
}




/*
 *
 *
 *            INTERNALS
 *
 *
 */


// canonical string ID handling for the i,j,k-th chunk
function getChunkID(i, j, k) {
    return `${i}|${j}|${k}`
}

function parseChunkID(id) {
    const arr = id.split('|')
    return [parseInt(arr[0]), parseInt(arr[1]), parseInt(arr[2])]
}

// canonical functions to store/retrieve a chunk held in memory
function getChunk(world, i, j, k) {
    const mi = (i | 0) & 1023
    const mj = (j | 0) & 1023
    const mk = (k | 0) & 1023
    return world._chunkHash.get(mi, mj, mk)
}

function setChunk(world, i, j, k, value) {
    const mi = (i | 0) & 1023
    const mj = (j | 0) & 1023
    const mk = (k | 0) & 1023
    world._chunkHash.set(mi, mj, mk, value)
}



function getPlayerChunkCoords(world) {
    const pos = world.noa.entities.getPosition(world.noa.playerEntity)
    const i = worldCoordToChunkCoord(pos[0])
    const j = worldCoordToChunkCoord(pos[1])
    const k = worldCoordToChunkCoord(pos[2])
    return [i, j, k]
}




// run through chunk tracking queues looking for work to do next
function processChunkQueues(self) {
    let done = true
    // both queues are sorted by ascending distance
    if (self._chunkIDsToRemove.length) {
        const remove = parseChunkID(self._chunkIDsToRemove.pop())
        removeChunk(self, remove[0], remove[1], remove[2])
        profile_queues(self, 'removed')
        profile_hook('removed')
        done = false
    }
    if (self._chunkIDsToCreate.length >= self._maxChunksPendingCreation) return done
    // if (self._chunkIDsToMesh.length >= self._maxChunksPendingMeshing) return done
    if (self._chunkIDsToAdd.length) {
        const id = self._chunkIDsToAdd.shift()
        requestNewChunk(self, id)
        profile_hook('requested')
        profile_queues(self, 'requested')
        done = false
    }
    return done
}


// similar to above but for chunks waiting to be meshed
function processMeshingQueues(self, firstOnly) {
    let id
    if (self._chunkIDsToMeshFirst.length) {
        id = self._chunkIDsToMeshFirst.pop()
    } else if (firstOnly) {
        return true
    } else if (self._chunkIDsToMesh.length) {
        id = self._chunkIDsToMesh.pop()
    } else return true

    const arr = parseChunkID(id)
    const chunk = getChunk(self, arr[0], arr[1], arr[2])
    if (chunk.isInvalid) return
    if (!chunk.isGenerated) {
        // client code triggered a remesh too early, requeue it
        self._chunkIDsToMesh.unshift(id)
        return
    }
    chunk.updateMeshes()
    self.emit('chunkMeshUpdated', chunk);

    profile_queues(self, 'meshed')
    profile_hook('meshed')
    return false
}









// make a new chunk and emit an event for it to be populated with world data
function requestNewChunk(world, id) {
    const pos = parseChunkID(id)
    const i = pos[0]
    const j = pos[1]
    const k = pos[2]
    const size = world.chunkSize
    const chunk = new Chunk(world.noa, id, i, j, k, size)
    setChunk(world, i, j, k, chunk)
    const x = i * size - 1
    const y = j * size - 1
    const z = k * size - 1
    enqueueID(id, world._chunkIDsToCreate)
    world.emit('worldDataNeeded', id, chunk.array, x, y, z)
}




// remove a chunk that wound up in the remove queue
function removeChunk(world, i, j, k) {
    const chunk = getChunk(world, i, j, k)
    world.emit('chunkBeingRemoved', chunk.id, chunk.array, chunk.userData)
    world.noa.rendering.disposeChunkForRendering(chunk)
    chunk.dispose()
    setChunk(world, i, j, k, 0)
    unenqueueID(chunk.id, world._chunkIDsInMemory)
    unenqueueID(chunk.id, world._chunkIDsToMesh)
    unenqueueID(chunk.id, world._chunkIDsToMeshFirst)
    // when removing a chunk because it was invalid, arrange for chunk queues to get rebuilt
    if (chunk.isInvalid) world._lastPlayerChunkID = ''
}





// for a given chunk (i/j/k) and local location (x/y/z), 
// update all chunks that need it (including border chunks with the 
// changed block in their 1-block padding)

function _updateChunkAndBorders(world, i, j, k, size, x, y, z, val) {
    const ilocs = [0]
    const jlocs = [0]
    const klocs = [0]
    if (x === 0) { ilocs.push(-1) } else if (x === size - 1) { ilocs.push(1) }
    if (y === 0) { jlocs.push(-1) } else if (y === size - 1) { jlocs.push(1) }
    if (z === 0) { klocs.push(-1) } else if (z === size - 1) { klocs.push(1) }

    for (const di of ilocs) {
        const lx = [size, x, -1][di + 1]
        for (const dj of jlocs) {
            const ly = [size, y, -1][dj + 1]
            for (const dk of klocs) {
                const lz = [size, z, -1][dk + 1]
                _modifyBlockData(world,
                    i + di, j + dj, k + dk,
                    lx, ly, lz, val)
            }
        }
    }
}



// internal function to modify a chunk's block

function _modifyBlockData(world, i, j, k, x, y, z, val) {
    const chunk = getChunk(world, i, j, k)
    if (!chunk) return
    chunk.set(x, y, z, val)
    enqueueID(chunk.id, world._chunkIDsToMeshFirst)
    world.emit('chunkChanged', chunk)
}




// rebuild queue of chunks to be added around (ci,cj,ck)
function buildChunkAddQueue(world, ci, cj, ck) {

    // TODO: make this more sane
    
    const add = Math.ceil(world.chunkAddDistance)
    const pending = world._chunkIDsToCreate
    const queue = []
    const distArr = []

    const addDistSq = world.chunkAddDistance * world.chunkAddDistance
    for (let i = ci - add; i <= ci + add; ++i) {
        for (let j = cj - add; j <= cj + add; ++j) {
            for (let k = ck - add; k <= ck + add; ++k) {
                const di = i - ci
                const dj = j - cj
                const dk = k - ck
                const distSq = di * di + dj * dj + dk * dk
                if (distSq > addDistSq) continue

                if (getChunk(world, i, j, k)) continue
                const id = getChunkID(i, j, k)
                if (pending.includes(id)) continue
                queue.push(id)
                distArr.push(distSq)
            }
        }
    }
    world._chunkIDsToAdd = sortByReferenceArray(queue, distArr)
}


// rebuild queue of chunks to be removed from around (ci,cj,ck)
function buildChunkRemoveQueue(world, ci, cj, ck) {
    const remDistSq = world.chunkRemoveDistance * world.chunkRemoveDistance
    const list = world._chunkIDsInMemory
    const queue = []
    const distArr = []

    for (let i = 0; i < list.length; i++) {
        const id = list[i]
        const loc = parseChunkID(id)
        const di = loc[0] - ci
        const dj = loc[1] - cj
        const dk = loc[2] - ck
        let distSq = di * di + dj * dj + dk * dk
        if (distSq < remDistSq) {
            const chunk = getChunk(world, loc[0], loc[1], loc[2])
            if (!chunk.isInvalid) continue
            distSq *= -1 // rig sort so that invalidated chunks get removed first
        }
        queue.push(id)
        distArr.push(distSq)
    }
    world._chunkIDsToRemove = sortByReferenceArray(queue, distArr)
}



// sorts [A, B, C] and [3, 1, 2] into [B, C, A]
function sortByReferenceArray(data, ref) {
    const ind = Object.keys(ref)
    ind.sort((i, j) => ref[i] - ref[j])
    return ind.map(i => data[i])
}





// uniquely enqueue a string id into an array of them
function enqueueID(id, queue) {
    const i = queue.indexOf(id)
    if (i >= 0) return
    queue.push(id)
}

// remove string id from queue if it exists
function unenqueueID(id, queue) {
    const i = queue.indexOf(id)
    if (i >= 0) queue.splice(i, 1)
}





var profile_queues = (w, s) => {}
if (PROFILE_QUEUES)(() => {
    const every = 100
    let iter = 0
    let t
    let nrem
    let nreq
    let totalrec
    let nmesh
    let reqcts
    let remcts
    let meshcts
    let qadd
    let qrem
    let qmem
    let qgen
    let qmesh
    profile_queues = (world, state) => {
        if (state === 'start') {
            if (iter === 0) {
                t = performance.now()
                qadd = qrem = qmem = qgen = qmesh = 0
                totalrec = 0
                remcts = []
                reqcts = []
                meshcts = []
            }
            iter++
            nrem = nreq = nmesh = 0
        } else if (state === 'removed') {
            nrem++
        } else if (state === 'received') {
            totalrec++
        } else if (state === 'requested') {
            nreq++
        } else if (state === 'meshed') {
            nmesh++
        } else if (state === 'end') {
            // counts for frames that were fully worked
            if (world._chunkIDsToAdd.length) reqcts.push(nreq)
            if (world._chunkIDsToRemove.length) remcts.push(nrem)
            if (world._chunkIDsToMesh.length + world._chunkIDsToMeshFirst.length) meshcts.push(nmesh)
            // avg queue sizes
            qadd += world._chunkIDsToAdd.length
            qrem += world._chunkIDsToRemove.length
            qmem += world._chunkIDsInMemory.length
            qgen += world._chunkIDsToCreate.length
            qmesh += world._chunkIDsToMesh.length + world._chunkIDsToMeshFirst.length
            // on end
            if (iter === every) {
                const dt = (performance.now() - t) / 1000
                console.log('world chunk queues:',
                    'made', rnd(totalrec / dt), 'cps',
                    '- avg queuelen: ',
                    'add', qadd / every,
                    'rem', qrem / every,
                    'mem', qmem / every,
                    'gen', qgen / every,
                    'mesh', qmesh / every,
                    '- work/frame: ',
                    'req', rnd(reqcts.reduce(sum, 0) / reqcts.length),
                    'rem', rnd(remcts.reduce(sum, 0) / remcts.length),
                    'mesh', rnd(meshcts.reduce(sum, 0) / meshcts.length)
                )
                iter = 0
            }
        }
    }
    var sum = (num, prev) => num + prev
    var rnd = n => Math.round(n * 10) / 10
})()


var profile_hook = (PROFILE) ?
    makeProfileHook(200, 'world ticks') : () => {}


