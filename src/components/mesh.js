import vec3 from 'gl-vec3'

export default function (noa) {
    return {

        name: 'mesh',

        order: 100,

        state: {
            mesh: null,
            offset: null
        },


        onAdd: function (eid, state) {
            if (state.mesh) {
                // Keep a reference of the entity's ID in the mesh
                state.mesh._entityId = eid
                noa.rendering.addMeshToScene(state.mesh)
            } else {
                throw new Error('Mesh component added without a mesh - probably a bug!')
            }
            if (!state.offset) {
                state.offset = new vec3.create()
            }

            // initialize mesh to correct position
            const pos = noa.ents.getPosition(eid)
            const mpos = state.mesh.position
            mpos.x = pos[0] + state.offset[0]
            mpos.y = pos[1] + state.offset[1]
            mpos.z = pos[2] + state.offset[2]
        },


        onRemove: function (eid, state) {
            state.mesh.dispose()
        },



        renderSystem: function (dt, states) {
            // before render move each mesh to its render position, 
            // set by the physics engine or driving logic

            states.forEach(state => {
                const id = state.__id

                const rpos = noa.ents.getPositionData(id).renderPosition
                const x = rpos[0] + state.offset[0]
                const y = rpos[1] + state.offset[1]
                const z = rpos[2] + state.offset[2]

                state.mesh.position.copyFromFloats(x, y, z)
            })
        }


    }
}
