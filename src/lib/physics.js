import createPhysics from 'voxel-physics-engine'

/**
 * @class Physics
 * @typicalname noa.physics
 * @classdesc Wrapper module for the physics engine. For docs see 
 * [andyhall/voxel-physics-engine](https://github.com/andyhall/voxel-physics-engine)
 */


const defaults = {
    gravity: [0, -10, 0],
    airDrag: 0.1,
}


export default function makePhysics(noa, opts) {
    opts = Object.assign({}, defaults, opts)
    const world = noa.world
    const blockGetter = (x, y, z) => world.getBlockSolidity(x, y, z)
    const isFluidGetter = (x, y, z) => world.getBlockFluidity(x, y, z)

    const physics = createPhysics(opts, blockGetter, isFluidGetter)

    return physics
}
