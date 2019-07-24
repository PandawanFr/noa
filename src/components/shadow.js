import vec3 from 'gl-vec3'

const down = vec3.fromValues(0, -1, 0)
const shadowPos = vec3.fromValues(0, 0, 0)

export default function (noa, dist) {

    let shadowDist = dist

    // create a mesh to re-use for shadows
    const scene = noa.rendering.getScene()
    const disc = noa.BABYLON.Mesh.CreateDisc('shadow', 0.75, 30, scene)
    disc.rotation.x = Math.PI / 2
    disc.material = noa.rendering.makeStandardMaterial('shadowMat')
    disc.material.diffuseColor = noa.BABYLON.Color3.Black()
    disc.material.ambientColor = noa.BABYLON.Color3.Black()
    disc.material.alpha = 0.5
    disc.setEnabled(false)

    // source mesh needn't be in the scene graph
    scene.removeMesh(disc)


    return {

        name: 'shadow',

        order: 80,

        state: {
            size: 0.5,
            _mesh: null,
        },


        onAdd: function (eid, state) {
            state._mesh = noa.rendering.makeMeshInstance(disc, false)
        },


        onRemove: function (eid, state) {
            state._mesh.dispose()
        },


        system: function shadowSystem(dt, states) {
            const cpos = noa.camera.getPosition()
            const dist = shadowDist
            states.forEach(state => {
                updateShadowHeight(state.__id, state._mesh, state.size, dist, cpos, noa)
            })
        },


        renderSystem: function (dt, states) {
            // before render adjust shadow x/z to render positions
            states.forEach(state => {
                const rpos = noa.ents.getPositionData(state.__id).renderPosition
                const spos = state._mesh.position
                spos.x = rpos[0]
                spos.z = rpos[2]
            })
        }




    }
}

function updateShadowHeight(id, mesh, size, shadowDist, camPos, noa) {
    const ents = noa.entities
    const dat = ents.getPositionData(id)
    const loc = dat.position
    let y

    // find Y location, from physics if on ground, otherwise by raycast
    if (ents.hasPhysics(id) && ents.getPhysicsBody(id).resting[1] < 0) {
        y = dat.renderPosition[1]
    } else {
        const pick = noa.pick(loc, down, shadowDist)
        if (pick) {
            y = pick.position[1]
        } else {
            mesh.setEnabled(false)
            return
        }
    }

    y = Math.round(y) // pick results get slightly countersunk
    // set shadow slightly above ground to avoid z-fighting
    vec3.set(shadowPos, mesh.position.x, y, mesh.position.z)
    const sqdist = vec3.squaredDistance(camPos, shadowPos)
    // offset ~ 0.01 for nearby shadows, up to 0.1 at distance of ~40
    let offset = 0.01 + 0.1 * (sqdist / 1600)
    if (offset > 0.1) offset = 0.1
    mesh.position.y = y + offset
    // set shadow scale
    const dist = loc[1] - y
    const scale = size * 0.7 * (1 - dist / shadowDist)
    mesh.scaling.copyFromFloats(scale, scale, scale)
    mesh.setEnabled(true)
}
