import aabb from 'aabb-3d'
import vec3 from 'gl-vec3'

import EntComp from 'ent-comp'
import components from '../components/*.js'
// var EntComp = require('../../../../npm-modules/ent-comp')


import { updatePositionExtents } from '../components/position'
import { setPhysicsFromPosition } from '../components/physics'



export default function (noa, opts) {
    return new Entities(noa, opts)
}



var defaults = {
    shadowDistance: 10,
}


/**
 * @class Entities
 * @typicalname noa.ents
 * @classdesc Wrangles entities. Aliased as `noa.ents`.
 * @extends {EntComp}
 * 
 * This class is an instance of [ECS](https://github.com/andyhall/ent-comp), 
 * and as such implements the usual ECS methods.
 * It's also decorated with helpers and accessor functions for getting component existence/state.
 * 
 * Expects entity definitions in a specific format - see source `components` folder for examples.
 */

function Entities(noa, opts) {
    // inherit from the ECS library
    EntComp.call(this)

    this.noa = noa
    opts = Object.assign({}, defaults, opts)

    // properties
    /** Hash containing the component names of built-in components. */
    this.names = {}

    // optional arguments to supply to component creation functions
    var componentArgs = {
        'shadow': opts.shadowDistance,
    }

    // NOTE: Ideally there'd be no import magic as it becomes bundler-specific, but it's relatively cleaner to keep it this way...
    // Wildcard import magic (should work with webpack, only tried with parcel)
    for (var componentName in components) {
        if (components.hasOwnProperty(componentName)) {
            var componentFunction = components[componentName]
            if (componentFunction.default) componentFunction = componentFunction.default
            var args = componentArgs[componentName] || undefined
            var componentDef = componentFunction(noa, args)
            var component = this.createComponent(componentDef)
            this.names[componentName] = component
        }
    }


    // decorate the entities object with accessor functions
    /** @param id */
    this.isPlayer = function (id) { return id === noa.playerEntity }

    /** @param id */
    this.hasPhysics = this.getComponentAccessor(this.names.physics)

    /** @param id */
    this.cameraSmoothed = this.getComponentAccessor(this.names.smoothCamera)

    /** @param id */
    this.hasMesh = this.getComponentAccessor(this.names.mesh)

    // position functions
    /** @param id */
    this.hasPosition = this.getComponentAccessor(this.names.position)
    var getPos = this.getStateAccessor(this.names.position)

    /** @param id */
    this.getPositionData = getPos

    /** @param id */
    this._localGetPosition = function (id) {
        return getPos(id)._localPosition
    }

    /** @param id */
    this.getPosition = function (id) {
        return getPos(id).position
    }

    /** @param id */
    this._localSetPosition = function (id, pos) {
        var posDat = getPos(id)
        vec3.copy(posDat._localPosition, pos)
        updateDerivedPositionData(id, posDat)
    }

    /** @param id, positionArr */
    this.setPosition = (id, pos, _yarg, _zarg) => {
        // check if called with "x, y, z" args
        if (typeof pos === 'number') pos = [pos, _yarg, _zarg]
        // convert to local and defer impl
        var loc = noa.globalToLocal(pos, null, [])
        this._localSetPosition(id, loc)
    }

    /** @param id, xs, ys, zs */
    this.setEntitySize = function (id, xs, ys, zs) {
        var posDat = getPos(id)
        posDat.width = (xs + zs) / 2
        posDat.height = ys
        updateDerivedPositionData(id, posDat)
    }

    // called when engine rebases its local coords
    this._rebaseOrigin = function (delta) {
        this.getStatesList(this.names.position).forEach(state => {
            vec3.subtract(state._localPosition, state._localPosition, delta)
            updateDerivedPositionData(state.__id, state)
        })
    }

    // helper to update everything derived from `_localPosition`
    function updateDerivedPositionData(id, posDat) {
        vec3.copy(posDat._renderPosition, posDat._localPosition)
        vec3.add(posDat.position, posDat._localPosition, noa.worldOriginOffset)
        updatePositionExtents(posDat)
        var physDat = getPhys(id)
        if (physDat) setPhysicsFromPosition(physDat, posDat)
    }



    // physics
    var getPhys = this.getStateAccessor(this.names.physics)
    this.getPhysics = getPhys
    this.getPhysicsBody = function (id) { return getPhys(id).body }

    // misc
    this.getMeshData = this.getStateAccessor(this.names.mesh)
    this.getMovement = this.getStateAccessor(this.names.movement)
    this.getCollideTerrain = this.getStateAccessor(this.names.collideTerrain)
    this.getCollideEntities = this.getStateAccessor(this.names.collideEntities)

    // pairwise collideEntities event - this is for client to override
    this.onPairwiseEntityCollision = function (id1, id2) {}
}

// inherit from EntComp
Entities.prototype = Object.create(EntComp.prototype)
Entities.prototype.constructor = Entities




/*
 *
 *    ENTITY MANAGER API
 * 
 *  note most APIs are on the original ECS module (ent-comp)
 *  these are some overlaid extras for noa
 *
 */


/** @param id,name,state */
Entities.prototype.addComponentAgain = function (id, name, state) {
    // removes component first if necessary
    if (this.hasComponent(id, name)) this.removeComponent(id, name, true)
    this.addComponent(id, name, state)
}


/** @param x,y,z */
Entities.prototype.isTerrainBlocked = function (x, y, z) {
    // checks if terrain location is blocked by entities
    var off = this.noa.worldOriginOffset
    var xlocal = Math.floor(x - off[0])
    var ylocal = Math.floor(y - off[1])
    var zlocal = Math.floor(z - off[2])
    var blockExt = [
        xlocal + 0.001, ylocal + 0.001, zlocal + 0.001,
        xlocal + 0.999, ylocal + 0.999, zlocal + 0.999,
    ]
    var list = this.getStatesList(this.names.collideTerrain)
    for (var i = 0; i < list.length; i++) {
        var id = list[i].__id
        var ext = this.getPositionData(id)._extents
        if (extentsOverlap(blockExt, ext)) return true
    }
    return false
}



function extentsOverlap(extA, extB) {
    if (extA[0] > extB[3]) return false
    if (extA[1] > extB[4]) return false
    if (extA[2] > extB[5]) return false
    if (extA[3] < extB[0]) return false
    if (extA[4] < extB[1]) return false
    if (extA[5] < extB[2]) return false
    return true
}




/** @param box */
Entities.prototype.getEntitiesInAABB = function (box, withComponents = this.names.position, excludeComponents) {
    // extents to test against
    var off = this.noa.worldOriginOffset
    var testExtents = [
        box.base[0] + off[0], box.base[1] + off[1], box.base[2] + off[2],
        box.max[0] + off[0], box.max[1] + off[1], box.max[2] + off[2],
    ]

    if (!withComponents || !withComponents.length) {
        withComponents = this.names.position
    }

    // entity position state list
    var posStates = (Array.isArray(withComponents) 
        // Supports multiple withComponents
        ? (
            // Loop through every component and get every entity that has all of them
            withComponents
                // Convert component names to entity IDs (that have it)
                .map(component => this.getStatesList(component))
                .map(states => states.map(state => state.__id))
                // Only keep IDs that are common to all of the arrays
                .reduce((arr1, arr2) => arr1.filter((val) => arr2.includes(val)))
                // Convert all IDs to Position datas
                .map(id => this.getPositionData(id))
        ) 
        // Only one component is specified
        : (
            this.getStatesList(withComponents)
                .map(state => this.getPositionData(state.__id))
        )
    )

    if (excludeComponents) {
        // Create a lsit of all entity IDs that should be excluded
        var entitiesToExclude = Array.isArray(excludeComponents)
            // Supports multiple exclueComponents
            ? (
                excludeComponents
                    // Convert component names to entity IDs (that have it)
                    .map((component => this.getStatesList(component)))
                    .map(states => states.map(state => state.__id))
                    // Flatten to get a full list of all IDs (don't worry about duplicates)
                    .flat()
            )
            // Only one component is specified
            : (
                this.getStatesList(excludeComponents)
                    .map(state => state.__id)
            )

        // Filter to keep those that are not included in the toExclude list
        posStates.filter(posState => !entitiesToExclude.includes(posState.__id))
    }


    // run each test
    var hits = []
    posStates.forEach(state => {
        if (extentsOverlap(testExtents, state._extents)) {
            hits.push(state.__id)
        }
    })
    return hits
}



/** 
 * Helper to set up a general entity, and populate with some common components depending on arguments.
 * 
 * Parameters: position, width, height [, mesh, meshOffset, doPhysics, shadow]
 * 
 * @param position
 * @param width
 * @param height..
 */
Entities.prototype.add = function (position, width, height, // required
    mesh, meshOffset, doPhysics, shadow) {

    var self = this

    // new entity
    var eid = this.createEntity()

    // position component
    this.addComponent(eid, this.names.position, {
        position: position || [0, 0, 0],
        width: width,
        height: height
    })

    // rigid body in physics simulator
    if (doPhysics) {
        // body = this.noa.physics.addBody(box)
        this.addComponent(eid, this.names.physics)
        var body = this.getPhysicsBody(eid)

        // handler for physics engine to call on auto-step
        var smoothName = this.names.smoothCamera
        body.onStep = function () {
            self.addComponentAgain(eid, smoothName)
        }
    }

    // mesh for the entity
    if (mesh) {
        if (!meshOffset) meshOffset = vec3.create()
        this.addComponent(eid, this.names.mesh, {
            mesh: mesh,
            offset: meshOffset
        })
    }

    // add shadow-drawing component
    if (shadow) {
        this.addComponent(eid, this.names.shadow, { size: width })
    }

    return eid
}
