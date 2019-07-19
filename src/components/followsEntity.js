import vec3 from 'gl-vec3'

/*
 * Indicates that an entity should be moved to another entity's position each tick,
 * possibly by a fixed offset, and the same for renderPositions each render
 */

export default function (noa) {

    return {

        name: 'followsEntity',

        order: 50,

        state: {
            entity: 0 | 0,
            offset: null,
        },

        onAdd: function (eid, state) {
            const off = vec3.create()
            state.offset = (state.offset) ? vec3.copy(off, state.offset) : off
            updatePosition(state)
            updateRenderPosition(state)
        },

        onRemove: null,


        // on tick, copy over regular positions
        system: function followEntity(dt, states) {
            states.forEach(state => {
                updatePosition(state)
            })
        },


        // on render, copy over render positions
        renderSystem: function followEntityMesh(dt, states) {
            states.forEach(state => {
                updateRenderPosition(state)
            })
        }
    }



    function updatePosition(state) {
        const id = state.__id
        const self = noa.ents.getPositionData(id)
        const other = noa.ents.getPositionData(state.entity)
        if (other) {
            vec3.add(self.position, other.position, state.offset)
            self._extentsChanged = true
        } else {
            noa.ents.removeComponent(id, noa.ents.names.followsEntity)
        }
    }

    function updateRenderPosition(state) {
        const id = state.__id
        const self = noa.ents.getPositionData(id)
        const other = noa.ents.getPositionData(state.entity)
        if (other) {
            vec3.add(self.renderPosition, other.renderPosition, state.offset)
        } else {
            noa.ents.removeComponent(id, noa.ents.names.followsEntity)
        }
    }

}
