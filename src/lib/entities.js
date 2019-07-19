import aabb from 'aabb-3d'
import vec3 from 'gl-vec3'
import EntComp from 'ent-comp'

import positionComponent from '../components/position'
import physicsComponent from '../components/physics'
import followsEntityComponent from '../components/followsEntity'
import meshComponent from '../components/mesh'
import shadowComponent from '../components/shadow'
import collideTerrainComponent from '../components/collideTerrain'
import collideEntitiesComponent from '../components/collideEntities'
import smoothCameraComponent from '../components/smoothCamera'
import movementComponent from '../components/movement'
import receivesInputsComponent from '../components/receivesInputs'
import fadeOnZoomComponent from '../components/fadeOnZoom'

const defaults = {
    shadowDistance: 10,
}



/**
 * @class Entities
 * @typicalname noa.ents
 * @classdesc Wrangles entities. Aliased as `noa.ents`.
 * 
 * This class is an instance of [ECS](https://github.com/andyhall/ent-comp), 
 * and as such implements the usual ECS methods.
 * It's also decorated with helpers and accessor functions for getting component existence/state.
 * 
 * Expects entity definitions in a specific format - see source `components` folder for examples.
 */

export default class Entities extends EntComp {
    constructor(noa, opts) {
        // inherit from the ECS library
        super()

        this.noa = noa
        opts = Object.assign({}, defaults, opts)

        // properties
        // Hash containing the component names of built-in components.
        this.names = {}

        // options
        const shadowDist = opts.shadowDistance

        // register components with the ECS
        this.names.position = this.createComponent(positionComponent(noa))
        this.names.physics = this.createComponent(physicsComponent(noa))
        this.names.followsEntity = this.createComponent(followsEntityComponent(noa))
        this.names.mesh = this.createComponent(meshComponent(noa))
        this.names.shadow = this.createComponent(shadowComponent(noa, shadowDist))
        this.names.collideTerrain = this.createComponent(collideTerrainComponent(noa))
        this.names.collideEntities = this.createComponent(collideEntitiesComponent(noa))
        this.names.smoothCamera = this.createComponent(smoothCameraComponent(noa))
        this.names.movement = this.createComponent(movementComponent(noa))
        this.names.receivesInputs = this.createComponent(receivesInputsComponent(noa))
        this.names.fadeOnZoom = this.createComponent(fadeOnZoomComponent(noa))

        // decorate the entities object with accessor functions
        this.isPlayer = id => id === noa.playerEntity
        this.hasPhysics = this.getComponentAccessor(this.names.physics)
        this.cameraSmoothed = this.getComponentAccessor(this.names.smoothCamera)
        this.hasMesh = this.getComponentAccessor(this.names.mesh)

        // position functions
        this.hasPosition = this.getComponentAccessor(this.names.position)
        const getPos = this.getStateAccessor(this.names.position)
        this.getPositionData = getPos
        this.getPosition = id => getPos(id).position
        this.setPosition = function (id, x, y, z) {
            const pdat = this.getPositionData(id)
            vec3.set(pdat.position, x, y, z)
            vec3.set(pdat.renderPosition, x, y, z)
            pdat._extentsChanged = true
            if (this.hasPhysics(id)) {
                setAABBFromPosition(this.getPhysicsBody(id).aabb, pdat)
            }
        }

        // physics
        const getPhys = this.getStateAccessor(this.names.physics)
        this.getPhysicsBody = id => getPhys(id).body

        // misc
        this.getMeshData = this.getStateAccessor(this.names.mesh)
        this.getMovement = this.getStateAccessor(this.names.movement)
        this.getCollideTerrain = this.getStateAccessor(this.names.collideTerrain)
        this.getCollideEntities = this.getStateAccessor(this.names.collideEntities)

        // pairwise collideEntities event - this is for client to override
        this.onPairwiseEntityCollision = (id1, id2) => {}

        // events
        const self = this
        noa.on('tick', dt => { self.tick(dt) })
        noa.on('beforeRender', dt => { self.render(dt) })

    }

    /*
     *
     *    ENTITY MANAGER API
     *
     */


    /** @param id,name,state */
    addComponentAgain(id, name, state) {
        // removes component first if necessary
        if (this.hasComponent(id, name)) this.removeComponent(id, name, true)
        this.addComponent(id, name, state)
    }

    /** @param x,y,z */
    isTerrainBlocked(x, y, z) {
        // checks if terrain location is blocked by entities
        const box = _blockAABB
        const eps = 0.001
        box.setPosition([x + eps, y + eps, z + eps])
        const hits = this.getEntitiesInAABB(box, this.names.collideTerrain)
        return (hits.length > 0)
    }

    /** @param x,y,z */
    setEntitySize(id, xs, ys, zs) {
        // adding this so client doesn't need to understand the internals
        if (!this.hasPosition(id)) throw 'Set size of entity without a position component'
        const pdat = this.getPositionData(id)
        pdat.width = (xs + zs) / 2
        pdat.height = ys
        pdat._extentsChanged = true
        if (this.hasPhysics(id)) {
            const box = this.getPhysicsBody(id).aabb
            setAABBFromPosition(box, pdat)
        }
    }

    /** @param box */
    getEntitiesInAABB(box, withComponent) {
        // TODO - use bipartite box-intersect?
        const hits = []
        const self = this
        let posArr = (withComponent) ?
            self.getStatesList(withComponent).map(state => self.getPositionData(state.__id)) :
            posArr = self.getStatesList(this.names.position)
        const tmpBox = _searchBox
        for (let i = 0; i < posArr.length; i++) {
            setAABBFromPosition(tmpBox, posArr[i])
            if (box.intersects(tmpBox)) hits.push(posArr[i].__id)
        }
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
    add(
        position,
        width,
        // required
        height,
        mesh,
        meshOffset,
        doPhysics,
        shadow
    ) {

        const self = this

        // new entity
        const eid = this.createEntity()

        // position component - force position vector to be a vec3
        const pos = vec3.create()
        vec3.copy(pos, position)
        this.addComponent(eid, this.names.position, {
            position: pos,
            width,
            height
        })

        // rigid body in physics simulator
        if (doPhysics) {
            // body = this.noa.physics.addBody(box)
            this.addComponent(eid, this.names.physics)
            const body = this.getPhysicsBody(eid)

            // handler for physics engine to call on auto-step
            const smoothName = this.names.smoothCamera
            body.onStep = () => {
                self.addComponentAgain(eid, smoothName)
            }
        }

        // mesh for the entity
        if (mesh) {
            if (!meshOffset) meshOffset = vec3.create()
            this.addComponent(eid, this.names.mesh, {
                mesh,
                offset: meshOffset
            })
        }

        // add shadow-drawing component
        if (shadow) {
            this.addComponent(eid, this.names.shadow, { size: width })
        }

        return eid
    }
}

var _blockAABB = new aabb([0, 0, 0], [0.998, 0.998, 0.998])


function setAABBFromPosition(box, posData) {
    const w = posData.width
    const pos = posData.position
    const hw = w / 2
    vec3.set(box.base, pos[0] - hw, pos[1], pos[2] - hw)
    vec3.set(box.vec, w, posData.height, w)
    vec3.add(box.max, box.base, box.vec)
}


var _searchBox = new aabb([], [])
