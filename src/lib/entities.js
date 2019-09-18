'use strict'

var aabb = require('aabb-3d')
var vec3 = require('gl-vec3')

import EntComp from 'ent-comp';
import components from '../components/*.js';
// var EntComp = require('../../../../npm-modules/ent-comp')




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
    // Hash containing the component names of built-in components.
    this.names = {}

    // optional arguments to supply to component creation functions
    var componentArgs = {
        'shadow': opts.shadowDistance,
    }

    // NOTE: Ideally there'd be no import magic as it becomes bundler-specific, but it's relatively cleaner to keep it this way...
    // Webpack import magic
    if (require.context !== undefined) {
        // Bundler magic to import everything in the ../components directory
        // each component module exports a default function: (noa) => compDefinition
        var reqContext = require.context('../components/', false, /\.js$/);
        reqContext.keys().forEach(name => {
            // convert name ('./foo.js') to bare name ('foo')
            var bareName = /\.\/(.*)\.js/.exec(name)[1]
            var arg = componentArgs[bareName] || undefined
            var compFn = reqContext(name)
            if (compFn.default) compFn = compFn.default
            var compDef = compFn(noa, arg)
            var comp = this.createComponent(compDef)
            this.names[bareName] = comp
        })
    }
    // Wildcard import magic (Parcel)
    else {
        for (var componentName in components) {
            if (components.hasOwnProperty(componentName)) {
                var componentFunction = components[componentName];
                if (componentFunction.default) componentFunction = componentFunction.default;
                
                var args = componentArgs[componentName] || undefined;
                var componentDef = componentFunction(noa, args);
                var component = this.createComponent(componentDef);
                this.names[componentName] = component;
            }
        }
    }


    // decorate the entities object with accessor functions
    this.isPlayer = function (id) { return id === noa.playerEntity }
    this.hasPhysics = this.getComponentAccessor(this.names.physics)
    this.cameraSmoothed = this.getComponentAccessor(this.names.smoothCamera)
    this.hasMesh = this.getComponentAccessor(this.names.mesh)

    // position functions
    this.hasPosition = this.getComponentAccessor(this.names.position)
    var getPos = this.getStateAccessor(this.names.position)
    this.getPositionData = getPos
    this.getPosition = function (id) { return getPos(id).position }
    this.setPosition = function (id, x, y, z) {
        var pdat = this.getPositionData(id)
        vec3.set(pdat.position, x, y, z)
        vec3.set(pdat.renderPosition, x, y, z)
        pdat._extentsChanged = true
        if (this.hasPhysics(id)) {
            setAABBFromPosition(this.getPhysicsBody(id).aabb, pdat)
        }
    }

    // physics
    var getPhys = this.getStateAccessor(this.names.physics)
    this.getPhysicsBody = function (id) { return getPhys(id).body }

    // misc
    this.getMeshData = this.getStateAccessor(this.names.mesh)
    this.getMovement = this.getStateAccessor(this.names.movement)
    this.getCollideTerrain = this.getStateAccessor(this.names.collideTerrain)
    this.getCollideEntities = this.getStateAccessor(this.names.collideEntities)

    // pairwise collideEntities event - this is for client to override
    this.onPairwiseEntityCollision = function (id1, id2) {}

    // events
    var self = this
    noa.on('tick', function (dt) { self.tick(dt) })
    noa.on('beforeRender', function (dt) { self.render(dt) })

}

// inherit from EntComp
Entities.prototype = Object.create(EntComp.prototype)
Entities.prototype.constructor = Entities




/*
 *
 *    ENTITY MANAGER API
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
    var box = _blockAABB
    var eps = 0.001
    box.setPosition([x + eps, y + eps, z + eps])
    var hits = this.getEntitiesInAABB(box, this.names.collideTerrain)
    return (hits.length > 0)
}
var _blockAABB = new aabb([0, 0, 0], [0.998, 0.998, 0.998])


/** @param x,y,z */
Entities.prototype.setEntitySize = function (id, xs, ys, zs) {
    // adding this so client doesn't need to understand the internals
    if (!this.hasPosition(id)) throw 'Set size of entity without a position component'
    var pdat = this.getPositionData(id)
    pdat.width = (xs + zs) / 2
    pdat.height = ys
    pdat._extentsChanged = true
    if (this.hasPhysics(id)) {
        var box = this.getPhysicsBody(id).aabb
        setAABBFromPosition(box, pdat)
    }
}


function setAABBFromPosition(box, posData) {
    var w = posData.width
    var pos = posData.position
    var hw = w / 2
    vec3.set(box.base, pos[0] - hw, pos[1], pos[2] - hw)
    vec3.set(box.vec, w, posData.height, w)
    vec3.add(box.max, box.base, box.vec)
}


// TODO: Test this, it should work
/** @param box */
Entities.prototype.getEntitiesInAABB = function (box, withComponents = this.names.position, excludeComponents) {
    // TODO - use bipartite box-intersect?
    var hits = []
    var self = this

    if (!withComponents || !withComponents.length) {
        withComponents = this.names.position;
    }

    var posArr = (Array.isArray(withComponents) 
        // Supports multiple withComponents
        ? (
            // Loop through every component and get every entity that has all of them
            withComponents
                // Convert component names to entity IDs (that have it)
                .map(component => self.getStatesList(component))
                .map(states => states.map(state => state.__id))
                // Only keep IDs that are common to all of the arrays
                .reduce((arr1, arr2) => arr1.filter((val) => arr2.includes(val)))
                // Convert all IDs to Position datas
                .map(id => self.getPositionData(id))
        ) 
        // Only one component is specified
        : (
            self.getStatesList(withComponents)
                .map(state => self.getPositionData(state.__id))
        )
    )

    if (excludeComponents) {
        // Create a lsit of all entity IDs that should be excluded
        var entitiesToExclude = Array.isArray(excludeComponents)
            // Supports multiple exclueComponents
            ? (
                excludeComponents
                    // Convert component names to entity IDs (that have it)
                    .map((component => self.getStatesList(component)))
                    .map(states => states.map(state => state.__id))
                    // Flatten to get a full list of all IDs (don't worry about duplicates)
                    .flat()
            )
            // Only one component is specified
            : (
                self.getStatesList(excludeComponents)
                    .map(state => state.__id)
            )

        // Filter to keep those that are not included in the toExclude list
        posArr.filter(posState => !entitiesToExclude.includes(posState.__id));
    }


    var tmpBox = _searchBox
    for (var i = 0; i < posArr.length; i++) {
        setAABBFromPosition(tmpBox, posArr[i])
        if (box.intersects(tmpBox)) hits.push(posArr[i].__id)
    }
    return hits
}
var _searchBox = new aabb([], [])



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

    // position component - force position vector to be a vec3
    var pos = vec3.create()
    vec3.copy(pos, position)
    this.addComponent(eid, this.names.position, {
        position: pos,
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
