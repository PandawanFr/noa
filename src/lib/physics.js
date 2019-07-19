import createPhysics from 'voxel-physics-engine'

/**
 * @class Physics
 * @typicalname noa.physics
 * @classdesc Wrapper module for the 
 * [physics engine](https://github.com/andyhall/voxel-physics-engine)
 */


var defaults = {
    gravity: [0, -10, 0],
    airDrag: 0.1,
}


export default function makePhysics(noa, opts) {
    opts = Object.assign({}, defaults, opts)
    var world = noa.world
    var blockGetter = (x, y, z) => world.getBlockSolidity(x, y, z)
    var isFluidGetter = (x, y, z) => world.getBlockFluidity(x, y, z)

    var physics = createPhysics(opts, blockGetter, isFluidGetter)

    return physics
}
