export default function (noa) {
    return {

        name: 'collideTerrain',

        state: {
            callback: null
        },

        onAdd: function (eid, state) {
            // add collide handler for physics engine to call
            const ents = noa.entities
            if (ents.hasPhysics(eid)) {
                const body = ents.getPhysicsBody(eid)
                body.onCollide = function bodyOnCollide(impulse) {
                    const cb = noa.ents.getCollideTerrain(eid).callback
                    if (cb) cb(impulse, eid)
                }
            }
        },

        onRemove: function (eid, state) {
            const ents = noa.entities
            if (ents.hasPhysics(eid)) {
                ents.getPhysicsBody(eid).onCollide = null
            }
        },



    }
}
