/*!
 * noa: an experimental voxel game engine.
 * @url      github.com/andyhall/noa
 * @author   Andy Hall <andy@fenomas.com>
 * @license  MIT
 */
import pkg from '../package.json'

import vec3 from 'gl-vec3'
import ndarray from 'ndarray'
import { EventEmitter } from 'events'
import Container from './lib/container'
import Rendering from './lib/rendering'
import World from './lib/world'
import createInputs from './lib/inputs'
import createPhysics from './lib/physics'
import Camera from './lib/camera'
import Registry from './lib/registry'
import Entities from './lib/entities'
import raycast from 'fast-voxel-raycast'

import constants from './lib/constants'
import { makeProfileHook } from './lib/util'

// profiling flag
const PROFILE = 0
const PROFILE_RENDER = 0
// const DEBUG_QUEUES = 0




const defaults = {
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
 * @emits tick(dt)
 * @emits beforeRender(dt)
 * @emits afterRender(dt)
 * @emits targetBlockChanged(blockDesc)
 * @classdesc Root class of the noa engine
 * 
 * Extends: `EventEmitter`
 */

export default class Engine extends EventEmitter {
    constructor(opts) {
        super()

        /**  version string, e.g. `"0.25.4"` */
        this.version = pkg.version

        opts = Object.assign({}, defaults, opts)
        this._tickRate = opts.tickRate
        this._paused = false
        this._dragOutsideLock = opts.dragCameraOutsidePointerLock
        const self = this

        if (!opts.silent) {
            var debugstr = (opts.debug) ? ' (debug)' : ''
            console.log(`noa-engine v${this.version}${debugstr}`)
        }

        // how far engine is into the current tick. Updated each render.
        this.positionInCurrentTick = 0

        /**
         * container (html/div) manager
         */
        this.container = new Container(this, opts)

        /**
         * inputs manager - abstracts key/mouse input
         */
        this.inputs = createInputs(this, opts, this.container.element)

        /**
         * block/item property registry
         */
        this.registry = new Registry(this, opts)

        /**
         * world manager
         */
        this.world = new World(this, opts)

        /**
         * Rendering manager
         */
        this.rendering = new Rendering(this, opts, this.container.canvas)

        /** Entity manager / Entity Component System (ECS) 
         * Aliased to `noa.ents` for convenience.
         */
        this.entities = new Entities(this, opts)
        this.ents = this.entities

        /**
         * physics engine - solves collisions, properties, etc.
         */
        this.physics = createPhysics(this, opts)

        const ents = this.ents

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
        const body = ents.getPhysicsBody(this.playerEntity)
        body.gravityMultiplier = 2 // less floaty
        body.autoStep = opts.playerAutoStep // auto step onto blocks

        /** Reference to player entity's physics body
         * Equivalent to: `noa.ents.getPhysicsBody(noa.playerEntity)`
         */
        this.playerBody = body

        // input component - sets entity's movement state from key inputs
        ents.addComponent(this.playerEntity, ents.names.receivesInputs)

        // add a component to make player mesh fade out when zooming in
        ents.addComponent(this.playerEntity, ents.names.fadeOnZoom)

        // movement component - applies movement forces
        // todo: populate movement settings from options
        const moveOpts = {
            airJumps: 1
        }
        ents.addComponent(this.playerEntity, ents.names.movement, moveOpts)

        /**
         * Manages camera, view angle, etc.
         */
        this.camera = new Camera(this, opts)

        // set up block targeting
        this.blockTestDistance = opts.blockTestDistance

        /** function for which block IDs are targetable. 
         * Defaults to a solidity check, but can be overridden */
        this.blockTargetIdCheck = this.registry.getBlockTargetability

        /** Dynamically updated object describing the currently targeted block */
        this.targetedBlock = null

        // add a default block highlighting function
        if (!opts.skipDefaultHighlighting) {
            // the default listener, defined onto noa in case people want to remove it later
            this.defaultBlockHighlightFunction = tgt => {
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
            let debug = false
            this.inputs.bind('debug', 'Z')
            this.inputs.down.on('debug', function onDebug() {
                debug = !debug
                if (debug) window.scene.debugLayer.show()
                else window.scene.debugLayer.hide()
            })
        }

        deprecateStuff(this)
    }

    /*
     *   Core Engine API
     */




    /*
     * Tick function, called by container module at a fixed timestep. Emits #tick(dt),
     * where dt is the tick rate in ms (default 16.6)
     */

    tick() {
        if (this._paused) return
        profile_hook('start')
        const dt = this._tickRate // fixed timesteps!
        this.world.tick(dt) // chunk creation/removal
        profile_hook('world')
        if (!this.world.playerChunkLoaded) {
            // when waiting on worldgen, just tick the meshing queue and exit
            this.rendering.tick(dt)
            return
        }
        this.physics.tick(dt) // iterates physics
        profile_hook('physics')
        this.rendering.tick(dt) // zooms camera, does deferred chunk meshing
        profile_hook('rendering')
        updateBlockTargets(this) // finds targeted blocks, and highlights one if needed
        profile_hook('targets')
        this.emit('tick', dt)
        profile_hook('tick event')
        profile_hook('end')

        // clear accumulated mouseMove inputs (scroll inputs cleared on render)
        this.inputs.state.dx = this.inputs.state.dy = 0
    }

    /*
     * Render function, called every animation frame. Emits #beforeRender(dt), #afterRender(dt) 
     * where dt is the time in ms *since the last tick*.
     */

    render(framePart) {
        if (this._paused) return
        profile_hook_render('start')
        // update frame position property and calc dt
        let framesAdvanced = framePart - this.positionInCurrentTick
        if (framesAdvanced < 0) framesAdvanced += 1
        this.positionInCurrentTick = framePart
        const dt = framesAdvanced * this._tickRate // ms since last tick
        // core render:
        // only move camera during pointerlock or mousedown, or if pointerlock is unsupported
        if (this.container.hasPointerLock ||
            !this.container.supportsPointerLock ||
            (this._dragOutsideLock && this.inputs.state.fire)) {
            this.camera.applyInputsToCamera()
        }
        // clear cumulative mouse inputs
        this.inputs.state.dx = this.inputs.state.dy = 0
        
        // events and render
        this.camera.updateBeforeEntityRenderSystems()
        this.emit('beforeRender', dt)
        this.camera.updateAfterEntityRenderSystems()
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
     *   Utility APIs
     */

    /** 
     * Pausing the engine will also stop render/tick events, etc.
     * @param paused
     */
    setPaused(paused) {
        this._paused = !!paused
        // when unpausing, clear any built-up mouse inputs
        if (!paused) {
            this.inputs.state.dx = this.inputs.state.dy = 0
        }
    }

    /** @param x,y,z */
    getBlock(x, y, z) {
        if (x.length) {
            return this.world.getBlockID(x[0], x[1], x[2])
        } else {
            return this.world.getBlockID(x, y, z)
        }
    }

    /** @param x,y,z */
    setBlock(id, x, y, z) {
        // skips the entity collision check
        if (x.length) {
            return this.world.setBlockID(id, x[0], x[1], x[2])
        } else {
            return this.world.setBlockID(id, x, y, z)
        }
    }

    /**
     * Adds a block unless obstructed by entities 
     * @param id,x,y,z */
    addBlock(id, x, y, z) {
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
     * Raycast through the world, returning a result object for any non-air block
     * @param pos
     * @param vec
     * @param dist
     */
    pick(pos, vec, dist, blockIdTestFunction) {
        if (dist === 0) return null
        // if no block ID function is specified default to solidity check
        const testFn = blockIdTestFunction || this.registry.getBlockTargetability
        const world = this.world
        const testVoxel = (x, y, z) => {
            const id = world.getBlockID(x, y, z)
            return testFn(id)
        }
        pos = pos || this.camera.getTargetPosition()
        vec = vec || this.camera.getDirection()
        dist = dist || this.blockTestDistance
        const rpos = _hitResult.position
        const rnorm = _hitResult.normal
        const hit = raycast(testVoxel, pos, vec, dist, rpos, rnorm)
        if (!hit) return null
        // position is right on a voxel border - adjust it so flooring will work as expected
        for (let i = 0; i < 3; i++) rpos[i] -= 0.01 * rnorm[i]
        return _hitResult
    }
}


var _hitResult = {
    position: vec3.create(),
    normal: vec3.create(),
}



// Each frame, by default pick along the player's view vector 
// and tell rendering to highlight the struck block face
function updateBlockTargets(noa) {
    let newhash = ''
    const blockIdFn = noa.blockTargetIdCheck || noa.registry.getBlockTargetability
    const result = noa.pick(null, null, null, blockIdFn)
    if (result) {
        const dat = _targetedBlockDat
        for (let i = 0; i < 3; i++) {
            // position values are right on a border, so adjust them before flooring!
            const n = result.normal[i] | 0
            const p = Math.floor(result.position[i])
            dat.position[i] = p
            dat.normal[i] = n
            dat.adjacent[i] = p + n
            newhash += `|${p}|${n}`
        }
        dat.blockID = noa.world.getBlockID(dat.position[0], dat.position[1], dat.position[2])
        newhash += `|${result.blockID}`
        noa.targetedBlock = dat
    } else {
        noa.targetedBlock = null
    }
    if (newhash != _prevTargetHash) {
        noa.emit('targetBlockChanged', noa.targetedBlock)
        _prevTargetHash = newhash
    }
}

var _targetedBlockDat = {
    blockID: 0,
    position: [],
    normal: [],
    adjacent: [],
}

var _prevTargetHash = ''




/*
 * 
 *  add some hooks for guidance on removed APIs
 * 
 */

function deprecateStuff(noa) {
    var ver = `0.27`
    var dep = (loc, name, msg) => {
        var throwFn = () => { throw `Incorrect usage of method ${name} was removed in ${ver} - ${msg}` }
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
    dep(noa.rendering, 'getCameraPosition', 'use `noa.camera.getPosition`')
    dep(noa.rendering, 'getCameraRotation', 'use `noa.camera.heading` and `noa.camera.pitch`')
    dep(noa.rendering, 'setCameraRotation', 'to customize camera behavior see API docs for `noa.camera`')
}







var profile_hook = (PROFILE) ?
    makeProfileHook(200, 'tick   ') : () => {}
var profile_hook_render = (PROFILE_RENDER) ?
    makeProfileHook(200, 'render ') : () => {}

