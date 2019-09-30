'use strict'

/*!
 * noa: an experimental voxel game engine.
 * @url      github.com/andyhall/noa
 * @author   Andy Hall <andy@fenomas.com>
 * @license  MIT
 */

import vec3 from 'gl-vec3'

import ndarray from 'ndarray'
import raycast from 'fast-voxel-raycast'
import { EventEmitter } from 'events'

import createContainer from './lib/container'
import createRendering from './lib/rendering'
import createWorld from './lib/world'
import createInputs from './lib/inputs'
import createPhysics from './lib/physics'
import createCamera from './lib/camera'
import createRegistry from './lib/registry'
import createEntities from './lib/entities'
import { constants } from './lib/constants'




export default Engine


// profiling flags
var PROFILE = 0
var PROFILE_RENDER = 0


/**
 * // TODO: Make this `[number, number, number]`
 * @typedef {number[]} Vector3
 */


/**
 * @typedef Options
 * @property {boolean} debug Enable debug mode
 * @property {boolean} silent Prevent noa from printing noa version in console
 * @property {number} playerHeight Height of player entity
 * @property {number} playerWidth Width of player entity
 * @property {Vector3} playerStart Starting position of the player entity
 * @property {boolean} playerAutoStep Enable auto-jumping when player runs into a block
 * @property {number} tickRate How long to wait between ticks (ms per tick, not ticks per second)
 * @property {number} blockTestDistance Distance for which the player can target blocks
 * @property {boolean} stickyPointerLock Whether or not to lock the pointer
 * @property {boolean} dragCameraOutsidePointerLock Whether or not to update camera facing even without pointer lock
 * @property {boolean} skipDefaultHighlighting Skip rendering the default block highlighting function
 * @property {number} originRebaseDistance How far to go from origin before re-basing positions
 */

/**
 * Default values
 * @type {Options}
 */
var defaults = {
    debug: false,
    silent: false,
    playerHeight: 1.8,
    playerWidth: 0.6,
    playerStart: [0, 10, 0],
    playerAutoStep: false,
    tickRate: 33, // ms per tick - not ticks per second
    blockTestDistance: 10,
    stickyPointerLock: true,
    dragCameraOutsidePointerLock: true,
    skipDefaultHighlighting: false,
    originRebaseDistance: 25,
}


/**
 * Main engine object.
 * Takes a big options object full of flags and settings as a parameter.
 * 
 * ```js
 * var opts = {
 *     debug: false,
 *     silent: false,
 *     playerHeight: 1.8,
 *     playerWidth: 0.6,
 *     playerStart: [0, 10, 0],
 *     playerAutoStep: false,
 *     tickRate: 33, // ms per tick - not ticks per second
 *     blockTestDistance: 10,
 *     stickyPointerLock: true,
 *     dragCameraOutsidePointerLock: true,
 *     skipDefaultHighlighting: false,
 *     originRebaseDistance: 25,
 * }
 * var NoaEngine = require('noa-engine')
 * var noa = NoaEngine(opts)
 * ```
 * 
 * All option parameters are, well, optional. Note that 
 * the root `opts` parameter object is also passed to 
 * noa's child modules (rendering, camera, etc). 
 * See docs for each module for which options they use.
 * 
 * @class
 * @alias Noa
 * @typicalname noa
 * @classdesc Root class of the noa engine
 * 
 * @param {Options=} opts
 * 
 * @extends EventEmitter
 * @emits tick(dt)
 * @emits beforeRender(dt)
 * @emits afterRender(dt)
 * @emits targetBlockChanged(blockDesc)
 */

function Engine(opts) {
    if (!(this instanceof Engine)) return new Engine(opts)

    /** 
     * Version string, e.g. `"0.25.4"`
     * @type {number} 
     */
    this.version = require('../package.json').version

    opts = Object.assign({}, defaults, opts)
    this._tickRate = opts.tickRate
    this._paused = false
    this._dragOutsideLock = opts.dragCameraOutsidePointerLock
    var self = this

    if (!opts.silent) {
        var debugstr = (opts.debug) ? ' (debug)' : ''
        console.log(`noa-engine v${this.version}${debugstr}`)
    }

    /** 
     * World origin offset, used throughout engine for origin rebasing
     * @type {Vector3} 
     */
    this.worldOriginOffset = [0, 0, 0]
    this._originRebaseDistance = opts.originRebaseDistance

    // vec3 library used throughout the engine
    this.vec3 = vec3

    // how far engine is into the current tick. Updated each render.
    this.positionInCurrentTick = 0

    /**
     * container (html/div) manager
     * @type {Container}
     */
    this.container = createContainer(this, opts)

    /**
     * inputs manager - abstracts key/mouse input
     * @type {Inputs}
     */
    this.inputs = createInputs(this, opts, this.container.element)

    /**
     * block/item property registry
     * @type {Registry}
     */
    this.registry = createRegistry(this, opts)

    /**
     * world manager
     * @type {World}
     */
    this.world = createWorld(this, opts)

    /**
     * Rendering manager
     * @type {Rendering}
     */
    this.rendering = createRendering(this, opts, this.container.canvas)

    /**
     * physics engine - solves collisions, properties, etc.
     * @type {Physics}
     */
    this.physics = createPhysics(this, opts)

    /** Entity manager / Entity Component System (ECS) 
     * Aliased to `noa.ents` for convenience.
     * @type {Entities}
     */
    this.entities = createEntities(this, opts)
    this.ents = this.entities
    var ents = this.ents

    /** Entity id for the player entity */
    this.playerEntity = ents.add(
        opts.playerStart, // starting location
        opts.playerWidth, opts.playerHeight,
        null, null, // no mesh for now, no meshOffset, 
        true, true
    )

    // make player entity it collide with terrain and other entities
    ents.addComponent(this.playerEntity, ents.names.collideTerrain)
    ents.addComponent(this.playerEntity, ents.names.collideEntities)

    // adjust default physics parameters
    var body = ents.getPhysicsBody(this.playerEntity)
    body.gravityMultiplier = 2 // less floaty
    body.autoStep = opts.playerAutoStep // auto step onto blocks

    // input component - sets entity's movement state from key inputs
    ents.addComponent(this.playerEntity, ents.names.receivesInputs)

    // add a component to make player mesh fade out when zooming in
    ents.addComponent(this.playerEntity, ents.names.fadeOnZoom)

    // movement component - applies movement forces
    // todo: populate movement settings from options
    var moveOpts = {
        airJumps: 1
    }
    ents.addComponent(this.playerEntity, ents.names.movement, moveOpts)


    /**
     * Manages camera, view angle, etc.
     * @type {Camera}
     */
    this.camera = createCamera(this, opts)


    // set up block targeting
    this.blockTestDistance = opts.blockTestDistance

    /**
     * Function for which block IDs are targetable. 
     * @callback BlockTargetIdCheck
     * @param {number} id
     */

    /** 
     * Function for which block IDs are targetable. 
     * Defaults to a targetability check, but can be overridden
     * 
     * @type {BlockTargetIdCheck}
     */
    this.blockTargetIdCheck = this.registry.getBlockTargetability

    /** Dynamically updated object describing the currently targeted block.
     * Gets updated each tick, to `null` if not block is targeted, or 
     * to an object like:
     * 
     *     {
     *        blockID,   // voxel ID
     *        position,  // the (solid) block being targeted
     *        adjacent,  // the (non-solid) block adjacent to the targeted one
     *        normal,    // e.g. [0, 1, 0] when player is targting the top face of a voxel
     *     }
     * 
     * @type {?TargetedBlock}
     */
    this.targetedBlock = null

    // add a default block highlighting function
    if (!opts.skipDefaultHighlighting) {
        /**
         * The default listener, defined onto noa in case people want to remove it later.
         * 
         * @param {?TargetedBlock} tgt
         */
        this.defaultBlockHighlightFunction = function (tgt) {
            if (tgt) {
                self.rendering.highlightBlockFace(true, tgt.position, tgt.normal)
            } else {
                self.rendering.highlightBlockFace(false)
            }
        }
        this.on('targetBlockChanged', this.defaultBlockHighlightFunction)
    }


    // expose constants, for HACKING™
    this._constants = constants

    // temp hacks for development
    if (opts.debug) {
        window.noa = this
        window.scene = this.rendering._scene
        window.ndarray = ndarray
        window.vec3 = vec3
        var debug = false
        this.inputs.bind('debug', 'Z')
        this.inputs.down.on('debug', function onDebug() {
            debug = !debug
            if (debug) window.scene.debugLayer.show()
            else window.scene.debugLayer.hide()
        })
        ents.getMovement(1).airJumps = 999
        /**
         * @param {number} dist
         */
        this.setViewDistance = function (dist) {
            var cs = this.world.chunkSize
            this.world.chunkAddDistance = dist / cs
            this.world.chunkRemoveDistance = dist / cs + 1
            this.world._lastPlayerChunkID = '' // pings noa's chunk queues
        }
    }

    // add hooks to throw helpful errors when using deprecated methods
    deprecateStuff(this)
}

Engine.prototype = Object.create(EventEmitter.prototype)





/*
 *
 *
 *   Core Engine API
 *
 *
 */


/**
 * Tick function, called by container module at a fixed timestep. Emits #tick(dt),
 * where dt is the tick rate in ms (default 16.6)
 */
Engine.prototype.tick = function () {
    if (this._paused) return
    profile_hook('start')
    checkWorldOffset(this)
    var dt = this._tickRate // fixed timesteps!
    this.world.tick(dt) // chunk creation/removal
    profile_hook('world')
    if (!this.world.playerChunkLoaded) {
        // when waiting on worldgen, just tick the meshing queue and exit
        this.rendering.tick(dt)
        return
    }
    this.physics.tick(dt) // iterates physics
    profile_hook('physics')
    this.rendering.tick(dt) // does deferred chunk meshing
    profile_hook('rendering')
    updateBlockTargets(this) // finds targeted blocks, and highlights one if needed
    profile_hook('targets')
    this.entities.tick(dt) // runs all entity systems
    profile_hook('entities')
    this.emit('tick', dt)
    profile_hook('tick event')
    profile_hook('end')
    // clear accumulated scroll inputs (mouseMove is cleared on render)
    var st = this.inputs.state
    st.scrollx = st.scrolly = st.scrollz = 0
}





/**
 * Render function, called every animation frame. 
 * 
 * Emits #beforeRender(dt), #afterRender(dt) where dt is the time in ms *since the last tick*.
 * 
 * @param {number} framePart
 */
Engine.prototype.render = function (framePart) {
    if (this._paused) return
    profile_hook_render('start')
    // update frame position property and calc dt
    var framesAdvanced = framePart - this.positionInCurrentTick
    if (framesAdvanced < 0) framesAdvanced += 1
    this.positionInCurrentTick = framePart
    var dt = framesAdvanced * this._tickRate // ms since last tick
    // only move camera during pointerlock or mousedown, or if pointerlock is unsupported
    if (this.container.hasPointerLock ||
        !this.container.supportsPointerLock ||
        (this._dragOutsideLock && this.inputs.state.fire)) {
        this.camera.applyInputsToCamera()
    }
    profile_hook('init')

    // entity render systems
    this.camera.updateBeforeEntityRenderSystems()
    this.entities.render(dt)
    this.camera.updateAfterEntityRenderSystems()
    profile_hook('entities')

    // events and render
    this.emit('beforeRender', dt)
    profile_hook_render('before render')

    this.rendering.render(dt)
    profile_hook_render('render')

    this.emit('afterRender', dt)
    profile_hook_render('after render')
    profile_hook_render('end')

    // clear accumulated mouseMove inputs (scroll inputs cleared on render)
    this.inputs.state.dx = this.inputs.state.dy = 0
}









/*
 *   Rebasing local <-> global coords
 */


/** 
 * Precisely converts a world position to the current internal 
 * local frame of reference.
 * 
 * See `/doc/positions.md` for more info.
 * 
 * @param {Vector3} global Input position in global coords
 * @param {Vector3=} globalPrecise (optional) Sub-voxel offset to the global position
 * @param {Vector3} local Output array which receives the result
 */ // NOTE: It's not super clean to have required, optional, required (intellisense will mess it up)
Engine.prototype.globalToLocal = function (global, globalPrecise, local) {
    var off = this.worldOriginOffset
    if (globalPrecise) {
        for (var i = 0; i < 3; i++) {
            var coord = global[i] - off[i]
            coord += globalPrecise[i]
            local[i] = coord
        }
        return local
    } else {
        return vec3.sub(local, global, off)
    }
}

/** 
 * Precisely converts a world position to the current internal 
 * local frame of reference.
 * 
 * See `/doc/positions.md` for more info.
 * 
 * If both output arrays are passed in, `global` will get int values and 
 * `globalPrecise` will get fractional parts. If only one array is passed in,
 * `global` will get the whole output position.
 * 
 * @param {Vector3} local Input array of local coords
 * @param {Vector3} global Output array which receives the result
 * @param {Vector3=} globalPrecise (optional) Sub-voxel offset to the output global position
 */
Engine.prototype.localToGlobal = function (local, global, globalPrecise) {
    var off = this.worldOriginOffset
    if (globalPrecise) {
        for (var i = 0; i < 3; i++) {
            var floored = Math.floor(local[i])
            global[i] = floored + off[i]
            globalPrecise[i] = local[i] - floored
        }
        return global
    } else {
        return vec3.add(global, local, off)
    }
}




/**
 * Rebase world origin offset around the player if necessary
 * @param {Engine} noa
 */
function checkWorldOffset(noa) {
    var t = performance.now()
    var lpos = noa.ents.getPositionData(noa.playerEntity)._localPosition
    var cutoff = noa._originRebaseDistance
    if (vec3.sqrLen(lpos) < cutoff * cutoff) return
    var delta = []
    for (var i = 0; i < 3; i++) {
        var d = Math.floor(lpos[i])
        delta[i] = d
        noa.worldOriginOffset[i] += d
    }
    noa.rendering._rebaseOrigin(delta)
    noa.entities._rebaseOrigin(delta)
}






/*
 *   Utility APIs
 */

/** 
 * Pausing the engine will also stop render/tick events, etc.
 * @param {boolean} paused
 */
Engine.prototype.setPaused = function (paused) {
    this._paused = !!paused
    // when unpausing, clear any built-up mouse inputs
    if (!paused) {
        this.inputs.state.dx = this.inputs.state.dy = 0
    }
}

/**
 * @param {number | Vector3} x
 * @param {?number} y
 * @param {?number} z
 * @returns {number} blockId
 */
Engine.prototype.getBlock = function (x, y, z) {
    if (x.length) {
        return this.world.getBlockID(x[0], x[1], x[2])
    } else {
        return this.world.getBlockID(x, y, z)
    }
}

/**
 * @param {number} id
 * @param {number | Vector3} x
 * @param {?number} y
 * @param {?number} z
 */
Engine.prototype.setBlock = function (id, x, y, z) {
    // skips the entity collision check
    if (x.length) {
        return this.world.setBlockID(id, x[0], x[1], x[2])
    } else {
        return this.world.setBlockID(id, x, y, z)
    }
}

/**
 * Adds a block unless obstructed by entities 
 * @param {number} id
 * @param {number | Vector3} x
 * @param {?number} y
 * @param {?number} z
 */
Engine.prototype.addBlock = function (id, x, y, z) {
    // add a new terrain block, if nothing blocks the terrain there
    if (x.length) {
        if (this.entities.isTerrainBlocked(x[0], x[1], x[2])) return
        this.world.setBlockID(id, x[0], x[1], x[2])
        return id
    } else {
        if (this.entities.isTerrainBlocked(x, y, z)) return
        this.world.setBlockID(id, x, y, z)
        return id
    }
}



/**
 * @typedef PickResult
 * @property {Vector3} position
 * @property {Vector3} normal
 * @property {Vector3} _localPosition
 */

/**
 * Raycast through the world, returning a result object for any non-air block
 * @param {Vector3=} pos (default: to player eye position)
 * @param {Vector3=} vec (default: to camera vector)
 * @param {number=} dist (default: `noa.blockTestDistance`)
 * @param {BlockTargetIdCheck=} blockIdTestFunction (default: voxel solidity)
 * 
 * @returns {?PickResult}
 * 
 * See `/doc/positions.md` for info on working with precise positions.
 */
Engine.prototype.pick = function (pos, vec, dist, blockIdTestFunction) {
    if (dist === 0) return null
    // input position to local coords, if any
    if (pos) {
        this.globalToLocal(pos, null, _pickPos)
        pos = _pickPos
    }
    return this._localPick(pos, vec, dist, blockIdTestFunction)
}
var _pickPos = vec3.create()



/**
 * Do a raycast in local coords. 
 * See `/doc/positions.md` for more info.
 * @param {Vector3=} pos (default: to player eye position)
 * @param {Vector3=} vec (default: to camera vector)
 * @param {number=} dist (default: `noa.blockTestDistance`)
 * @param {BlockTargetIdCheck=} blockIdTestFunction (default: voxel solidity)
 * 
 * @returns {PickResult | null}
 */
Engine.prototype._localPick = function (pos, vec, dist, blockIdTestFunction) {
    // do a raycast in local coords - result obj will be in global coords
    if (dist === 0) return null
    // if no block ID function is specified default to solidity check
    var testFn = blockIdTestFunction || this.registry.getBlockTargetability
    var world = this.world
    var off = this.worldOriginOffset
    var testVoxel = function (x, y, z) {
        var id = world.getBlockID(x + off[0], y + off[1], z + off[2])
        return testFn(id)
    }
    if (!pos) pos = this.camera._localGetTargetPosition()
    vec = vec || this.camera.getDirection()
    dist = dist || this.blockTestDistance
    var rpos = _hitResult._localPosition
    var rnorm = _hitResult.normal
    var hit = raycast(testVoxel, pos, vec, dist, rpos, rnorm)
    if (!hit) return null
    // position is right on a voxel border - adjust it so that flooring works reliably
    // adjust along normal direction, i.e. away from the block struck
    vec3.scaleAndAdd(rpos, rpos, rnorm, 0.01)
    // add global result
    this.localToGlobal(rpos, _hitResult.position)
    return _hitResult
}
var _hitResult = {
    _localPosition: vec3.create(),
    position: [0, 0, 0],
    normal: [0, 0, 0],
}




/**
 * @typedef TargetedBlock
 * @property {number} blockId Voxel ID
 * @property {Vector3} position The position of the block being targeted
 * @property {Vector3} normal e.g. [0, 1, 0] when player is targting the top face of a voxel
 * @property {Vector3} adjacent The position adjacent to the targeted one
 */

/**
 * Each frame, by default pick along the player's view vector 
 * and tell rendering to highlight the struck block face
 * @param {Engine} noa 
 */
function updateBlockTargets(noa) {
    var newhash = ''
    var blockIdFn = noa.blockTargetIdCheck || noa.registry.getBlockTargetability
    var result = noa._localPick(null, null, null, blockIdFn)
    if (result) {
        var dat = _targetedBlockDat
        // pick stops just shy of voxel boundary, so floored pos is the adjacent voxel
        vec3.floor(dat.adjacent, result.position)
        vec3.copy(dat.normal, result.normal)
        vec3.sub(dat.position, dat.adjacent, dat.normal)
        dat.blockID = noa.world.getBlockID(dat.position[0], dat.position[1], dat.position[2])
        noa.targetedBlock = dat
        newhash = dat.position.join('|') + dat.normal.join('|') + '|' + dat.blockID
    } else {
        noa.targetedBlock = null
    }
    if (newhash != _prevTargetHash) {
        noa.emit('targetBlockChanged', noa.targetedBlock)
        _prevTargetHash = newhash
    }
}

/**
 * @type {TargetedBlock}
 */
var _targetedBlockDat = {
    blockID: 0,
    position: [],
    normal: [],
    adjacent: [],
}

var _prevTargetHash = ''




/**
 * Add some hooks for guidance on removed APIs
 * @param {Engine} noa
 */

function deprecateStuff(noa) {
    var ver = `0.27`
    var dep = (loc, name, msg) => {
        var throwFn = () => { throw `Method ${name} was removed in ${ver} - ${msg}` }
        Object.defineProperty(loc, name, { get: throwFn, set: throwFn })
    }
    dep(noa, 'getPlayerEyePosition', 'to get the camera/player offset see API docs for `noa.camera.cameraTarget`')
    dep(noa, 'setPlayerEyePosition', 'to set the camera/player offset see API docs for `noa.camera.cameraTarget`')
    dep(noa, 'getPlayerPosition', 'use `noa.ents.getPosition(noa.playerEntity)` or similar')
    dep(noa, 'getCameraVector', 'use `noa.camera.getDirection`')
    dep(noa, 'getPlayerMesh', 'use `noa.ents.getMeshData(noa.playerEntity).mesh` or similar')
    dep(noa, 'playerBody', 'use `noa.ents.getPhysicsBody(noa.playerEntity)`')
    dep(noa.rendering, 'zoomDistance', 'use `noa.camera.zoomDistance`')
    dep(noa.rendering, '_currentZoom', 'use `noa.camera.currentZoom`')
    dep(noa.rendering, '_cameraZoomSpeed', 'use `noa.camera.zoomSpeed`')
    dep(noa.rendering, 'getCameraVector', 'use `noa.camera.getDirection`')
    dep(noa.rendering, 'getCameraPosition', 'use `noa.camera.getLocalPosition`')
    dep(noa.rendering, 'getCameraRotation', 'use `noa.camera.heading` and `noa.camera.pitch`')
    dep(noa.rendering, 'setCameraRotation', 'to customize camera behavior see API docs for `noa.camera`')
    ver = '0.28'
    dep(noa.rendering, 'makeMeshInstance', 'removed, use Babylon\'s `mesh.createInstance`')
}







import { makeProfileHook } from './lib/util'
var profile_hook = (PROFILE) ?
    makeProfileHook(200, 'tick   ') : () => {}
var profile_hook_render = (PROFILE_RENDER) ?
    makeProfileHook(200, 'render ') : () => {}
