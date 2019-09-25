'use strict'

import ndHash from 'ndarray-hash'
import { EventEmitter } from 'events'
import Chunk from './chunk'



export default function (noa, opts) {
    return new World(noa, opts)
}


var PROFILE = 0
var PROFILE_QUEUES = 0


var defaultOptions = {
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

function World(noa, opts) {
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
    var self = this
    noa.on('beforeRender', function () { beforeRender(self) })

    // actual chunk storage - hash size hard coded for now
    this._chunkHash = ndHash([1024, 1024, 1024])

    // instantiate coord conversion functions based on the chunk size
    // use bit twiddling if chunk size is a power of 2
    var cs = this.chunkSize
    if (cs & cs - 1 === 0) {
        var shift = Math.log2(cs) | 0
        var mask = (cs - 1) | 0
        worldCoordToChunkCoord = coord => (coord >> shift) | 0
        worldCoordToChunkIndex = coord => (coord & mask) | 0
    } else {
        worldCoordToChunkCoord = coord => Math.floor(coord / cs) | 0
        worldCoordToChunkIndex = coord => (((coord % cs) + cs) % cs) | 0
    }

}
World.prototype = Object.create(EventEmitter.prototype)

var worldCoordToChunkCoord
var worldCoordToChunkIndex




/*
 *   PUBLIC API 
 */



/** @param x,y,z */
World.prototype.getBlockID = function (x, y, z) {
    var chunk = this._getChunkByCoords(x, y, z)
    if (!chunk) return 0

    var ix = worldCoordToChunkIndex(x)
    var iy = worldCoordToChunkIndex(y)
    var iz = worldCoordToChunkIndex(z)
    return chunk.get(ix, iy, iz)
}

/** @param x,y,z */
World.prototype.getBlockSolidity = function (x, y, z) {
    var chunk = this._getChunkByCoords(x, y, z)
    if (!chunk) return 0

    var ix = worldCoordToChunkIndex(x)
    var iy = worldCoordToChunkIndex(y)
    var iz = worldCoordToChunkIndex(z)
    return !!chunk.getSolidityAt(ix, iy, iz)
}

/** @param x,y,z */
World.prototype.getBlockOpacity = function (x, y, z) {
    var id = this.getBlockID(x, y, z)
    return this.noa.registry.getBlockOpacity(id)
}

/** @param x,y,z */
World.prototype.getBlockFluidity = function (x, y, z) {
    var id = this.getBlockID(x, y, z)
    return this.noa.registry.getBlockFluidity(id)
}

/** @param x,y,z */
World.prototype.getBlockProperties = function (x, y, z) {
    var id = this.getBlockID(x, y, z)
    return this.noa.registry.getBlockProps(id)
}

/** @param x,y,z */
World.prototype.getBlockObjectMesh = function (x, y, z) {
    var chunk = this._getChunkByCoords(x, y, z)
    if (!chunk) return 0

    var ix = worldCoordToChunkIndex(x)
    var iy = worldCoordToChunkIndex(y)
    var iz = worldCoordToChunkIndex(z)
    return chunk.getObjectMeshAt(ix, iy, iz)
}


/** @param x,y,z */
World.prototype.setBlockID = function (val, x, y, z) {
    var i = worldCoordToChunkCoord(x)
    var j = worldCoordToChunkCoord(y)
    var k = worldCoordToChunkCoord(z)
    var ix = worldCoordToChunkIndex(x)
    var iy = worldCoordToChunkIndex(y)
    var iz = worldCoordToChunkIndex(z)

    // if update is on chunk border, update neighbor's padding data too
    _updateChunkAndBorders(this, i, j, k, this.chunkSize, ix, iy, iz, val)
}


/** @param x,y,z */
World.prototype.isBoxUnobstructed = function (box) {
    var base = box.base
    var max = box.max
    for (var i = Math.floor(base[0]); i < max[0] + 1; i++) {
        for (var j = Math.floor(base[1]); j < max[1] + 1; j++) {
            for (var k = Math.floor(base[2]); k < max[2] + 1; k++) {
                if (this.getBlockSolidity(i, j, k)) return false
            }
        }
    }
    return true
}





World.prototype.tick = function () {
    profile_hook('start')

    // check player position and needed/unneeded chunks
    var pos = getPlayerChunkCoords(this)
    var chunkID = getChunkID(pos[0], pos[1], pos[2])
    if (chunkID != this._lastPlayerChunkID) {
        this.emit('playerEnteredChunk', pos[0], pos[1], pos[2])
        buildChunkAddQueue(this, pos[0], pos[1], pos[2])
        buildChunkRemoveQueue(this, pos[0], pos[1], pos[2])
    }
    this._lastPlayerChunkID = chunkID
    profile_hook('build queues')

    // process (create or mesh) some chunks. If fast enough, do several
    profile_queues(this, 'start')
    var cutoff = performance.now() + this._maxProcessingPerTick
    var done = false
    while (!done && (performance.now() < cutoff)) {
        var d1 = processMeshingQueues(this, false)
        var d2 = processChunkQueues(this)
        if (!d2) d2 = processChunkQueues(this)
        done = d1 && d2
    }
    profile_queues(this, 'end')


    // track whether the player's local chunk is loaded and ready or not
    var pChunk = getChunk(this, pos[0], pos[1], pos[2])
    var okay = !!(pChunk && pChunk.isGenerated && !pChunk.isInvalid)
    this.playerChunkLoaded = okay

    profile_hook('end')
}



function beforeRender(self) {
    // on render, quickly process the high-priority meshing queue
    // to help avoid flashes of background while neighboring chunks update
    var cutoff = performance.now() + self._maxProcessingPerRender
    var done = false
    while (!done && (performance.now() < cutoff)) {
        done = processMeshingQueues(self, true)
    }
}




/** client should call this after creating a chunk's worth of data (as an ndarray)  
 * If userData is passed in it will be attached to the chunk
 * @param id
 * @param array
 * @param userData
 */
World.prototype.setChunkData = function (id, array, userData) {
    profile_queues(this, 'received')
    var arr = parseChunkID(id)
    var chunk = getChunk(this, arr[0], arr[1], arr[2])
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
World.prototype.invalidateAllChunks = function () {
    var toInval = this._chunkIDsInMemory.concat(this._chunkIDsToCreate)
    for (var id of toInval) {
        var loc = parseChunkID(id)
        var chunk = getChunk(this, loc[0], loc[1], loc[2])
        chunk.isInvalid = true
    }
    // this causes chunk queues to get rebuilt next tick
    this._lastPlayerChunkID = ''
}



// debugging
World.prototype.report = function () {
    console.log('World report - playerChunkLoaded: ', this.playerChunkLoaded)
    _report(this, '  to add     ', this._chunkIDsToAdd)
    _report(this, '  to remove: ', this._chunkIDsToRemove)
    _report(this, '  in memory: ', this._chunkIDsInMemory, true)
    _report(this, '  creating:  ', this._chunkIDsToCreate)
    _report(this, '  meshing:   ', this._chunkIDsToMesh.concat(this._chunkIDsToMeshFirst))
}

function _report(world, name, arr, ext) {
    var ct = 0,
        full = 0,
        empty = 0
    for (var id of arr) {
        if (id.size) {
            if (id.isInvalid) ct++
            continue
        }
        var loc = parseChunkID(id)
        var chunk = getChunk(world, loc[0], loc[1], loc[2])
        if (chunk.isInvalid) ct++
        if (chunk.isFull) full++
        if (chunk.isEmpty) empty++
    }
    var len = (arr.length + '        ').substr(0, 6)
    var es = (ext) ? [', ', full, ' full, ', empty, ' empty'].join('') : ''
    console.log(name, len, ct, 'invalid' + es)
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
    return i + '|' + j + '|' + k
}

function parseChunkID(id) {
    var arr = id.split('|')
    return [parseInt(arr[0]), parseInt(arr[1]), parseInt(arr[2])]
}

// canonical functions to store/retrieve a chunk held in memory
function getChunk(world, i, j, k) {
    var mi = (i | 0) & 1023
    var mj = (j | 0) & 1023
    var mk = (k | 0) & 1023
    return world._chunkHash.get(mi, mj, mk)
}

function setChunk(world, i, j, k, value) {
    var mi = (i | 0) & 1023
    var mj = (j | 0) & 1023
    var mk = (k | 0) & 1023
    world._chunkHash.set(mi, mj, mk, value)
}



function getPlayerChunkCoords(world) {
    var pos = world.noa.entities.getPosition(world.noa.playerEntity)
    var i = worldCoordToChunkCoord(pos[0])
    var j = worldCoordToChunkCoord(pos[1])
    var k = worldCoordToChunkCoord(pos[2])
    return [i, j, k]
}


// for internal use
World.prototype._getChunkByCoords = function (x, y, z) {
    var i = worldCoordToChunkCoord(x)
    var j = worldCoordToChunkCoord(y)
    var k = worldCoordToChunkCoord(z)
    return getChunk(this, i, j, k)
}




// run through chunk tracking queues looking for work to do next
function processChunkQueues(self) {
    var done = true
    // both queues are sorted by ascending distance
    if (self._chunkIDsToRemove.length) {
        var remove = parseChunkID(self._chunkIDsToRemove.pop())
        removeChunk(self, remove[0], remove[1], remove[2])
        profile_queues(self, 'removed')
        profile_hook('removed')
        done = false
    }
    if (self._chunkIDsToCreate.length >= self._maxChunksPendingCreation) return done
    // if (self._chunkIDsToMesh.length >= self._maxChunksPendingMeshing) return done
    if (self._chunkIDsToAdd.length) {
        var id = self._chunkIDsToAdd.shift()
        requestNewChunk(self, id)
        profile_hook('requested')
        profile_queues(self, 'requested')
        done = false
    }
    return done
}


// similar to above but for chunks waiting to be meshed
function processMeshingQueues(self, firstOnly) {
    var id
    if (self._chunkIDsToMeshFirst.length) {
        id = self._chunkIDsToMeshFirst.pop()
    } else if (firstOnly) {
        return true
    } else if (self._chunkIDsToMesh.length) {
        id = self._chunkIDsToMesh.pop()
    } else return true

    var arr = parseChunkID(id)
    var chunk = getChunk(self, arr[0], arr[1], arr[2])
    if (chunk.isInvalid) return
    if (!chunk.isGenerated) {
        // client code triggered a remesh too early, requeue it
        self._chunkIDsToMesh.unshift(id)
        return
    }
    chunk.updateMeshes()
    self.emit('chunkMeshUpdated', chunk)

    profile_queues(self, 'meshed')
    profile_hook('meshed')
    return false
}









// make a new chunk and emit an event for it to be populated with world data
function requestNewChunk(world, id) {
    var pos = parseChunkID(id)
    var i = pos[0]
    var j = pos[1]
    var k = pos[2]
    var size = world.chunkSize
    var chunk = new Chunk(world.noa, id, i, j, k, size)
    setChunk(world, i, j, k, chunk)
    var x = i * size - 1
    var y = j * size - 1
    var z = k * size - 1
    enqueueID(id, world._chunkIDsToCreate)
    world.emit('worldDataNeeded', id, chunk.array, x, y, z)
}




// remove a chunk that wound up in the remove queue
function removeChunk(world, i, j, k) {
    var chunk = getChunk(world, i, j, k)
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
    // weird nested loops to update the modified chunk, and also
    // any neighbors whose border padding was modified
    var imin = (x === 0) ? -1 : 0
    var imax = (x === size - 1) ? 1 : 0
    var jmin = (y === 0) ? -1 : 0
    var jmax = (y === size - 1) ? 1 : 0
    var kmin = (z === 0) ? -1 : 0
    var kmax = (z === size - 1) ? 1 : 0

    for (var di = imin; di <= imax; di++) {
        var lx = (di === 0) ? x : (di === -1) ? size : -1
        for (var dj = jmin; dj <= jmax; dj++) {
            var ly = (dj === 0) ? y : (dj === -1) ? size : -1
            for (var dk = kmin; dk <= kmax; dk++) {
                var lz = (dk === 0) ? z : (dk === -1) ? size : -1
                var isPadding = !!(di || dj || dk)
                _modifyBlockData(world,
                    i + di, j + dj, k + dk,
                    lx, ly, lz, val, isPadding)
            }
        }
    }
}



// internal function to modify a chunk's block

function _modifyBlockData(world, i, j, k, x, y, z, val, isPadding) {
    var chunk = getChunk(world, i, j, k)
    if (!chunk) return
    chunk.set(x, y, z, val, isPadding)
    enqueueID(chunk.id, world._chunkIDsToMeshFirst)
    if (!isPadding) world.emit('chunkChanged', chunk)
}




// rebuild queue of chunks to be added around (ci,cj,ck)
function buildChunkAddQueue(world, ci, cj, ck) {
    var add = Math.ceil(world.chunkAddDistance)
    var pending = world._chunkIDsToCreate
    var queue = []
    var distArr = []

    var addDistSq = world.chunkAddDistance * world.chunkAddDistance
    for (var i = ci - add; i <= ci + add; ++i) {
        for (var j = cj - add; j <= cj + add; ++j) {
            for (var k = ck - add; k <= ck + add; ++k) {
                var di = i - ci
                var dj = j - cj
                var dk = k - ck
                var horizDistSq = di * di + dk * dk
                var totalDistSq = horizDistSq + dj * dj
                if (totalDistSq > addDistSq) continue

                if (getChunk(world, i, j, k)) continue
                var id = getChunkID(i, j, k)
                if (pending.indexOf(id) > -1) continue
                queue.push(id)
                distArr.push(horizDistSq + Math.abs(dj))
            }
        }
    }
    world._chunkIDsToAdd = sortByReferenceArray(queue, distArr)
}


// rebuild queue of chunks to be removed from around (ci,cj,ck)
function buildChunkRemoveQueue(world, ci, cj, ck) {
    var remDistSq = world.chunkRemoveDistance * world.chunkRemoveDistance
    var list = world._chunkIDsInMemory
    var queue = []
    var distArr = []

    for (var i = 0; i < list.length; i++) {
        var id = list[i]
        var loc = parseChunkID(id)
        var di = loc[0] - ci
        var dj = loc[1] - cj
        var dk = loc[2] - ck
        var distSq = di * di + dj * dj + dk * dk
        if (distSq < remDistSq) {
            var chunk = getChunk(world, loc[0], loc[1], loc[2])
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
    var ind = Object.keys(ref)
    ind.sort((i, j) => ref[i] - ref[j])
    return ind.map(i => data[i])
}





// uniquely enqueue a string id into an array of them
function enqueueID(id, queue) {
    var i = queue.indexOf(id)
    if (i >= 0) return
    queue.push(id)
}

// remove string id from queue if it exists
function unenqueueID(id, queue) {
    var i = queue.indexOf(id)
    if (i >= 0) queue.splice(i, 1)
}





var profile_queues = function (w, s) {}
if (PROFILE_QUEUES)(function () {
    var every = 100
    var iter = 0
    var t, nrem, nreq, totalrec, nmesh
    var reqcts, remcts, meshcts
    var qadd, qrem, qmem, qgen, qmesh
    profile_queues = function (world, state) {
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
                var dt = (performance.now() - t) / 1000
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
    var sum = function (num, prev) { return num + prev }
    var rnd = function (n) { return Math.round(n * 10) / 10 }
})()






import { makeProfileHook } from './util'
var profile_hook = (PROFILE) ?
    makeProfileHook(200, 'world ticks') : () => {}
