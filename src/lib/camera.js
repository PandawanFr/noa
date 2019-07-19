const defaults = {
    rotationScaleX: 0.0025,
    rotationScaleY: 0.0025,
    inverseY: false,
}


/** 
 * @class
 * @typicalname noa.cameraControls
 * @classdesc Manages the camera,
 * exposes settings for mouse sensitivity.
 */


export default class CameraController {
    constructor(noa, opts) {
        this.noa = noa

        // options
        opts = Object.assign({}, defaults, opts)

        /** Horizontal sensitivity */
        this.rotationScaleX = opts.rotationScaleX

        /** Vertical sensitivity */
        this.rotationScaleY = opts.rotationScaleY

        /** Mouse look inverse setting */
        this.inverseY = opts.inverseY
    }

    /*
     *
     * On render, move/rotate the camera based on target and mouse inputs
     *
     */

    updateForRender() {
        // input state
        const state = this.noa.inputs.state

        // TODO: REMOVE EVENTUALLY
        bugFix(state)

        // Rotation: translate dx/dy inputs into y/x axis camera angle changes
        const dx = this.rotationScaleY * state.dy * ((this.inverseY) ? -1 : 1)
        const dy = this.rotationScaleX * state.dx

        // normalize/clamp/update
        const camrot = this.noa.rendering.getCameraRotation() // [x,y]
        const rotX = clamp(camrot[0] + dx, rotXcutoff)
        const rotY = (camrot[1] + dy) % (Math.PI * 2)
        this.noa.rendering.setCameraRotation(rotX, rotY)

    }
}

var rotXcutoff = (Math.PI / 2) - .0001 // engines can be weird when xRot == pi/2

function clamp(value, to) {
    return isFinite(to) ? Math.max(Math.min(value, to), -to) : value
}



// workaround for this Chrome 63 + Win10 bug
// https://bugs.chromium.org/p/chromium/issues/detail?id=781182
function bugFix(state) {
    const dx = state.dx
    const dy = state.dy
    const wval = document.body.clientWidth / 6
    const hval = document.body.clientHeight / 6
    const badx = (Math.abs(dx) > wval && (dx / lastx) < -1)
    const bady = (Math.abs(dy) > hval && (dy / lasty) < -1)
    if (badx || bady) {
        state.dx = lastx
        state.dy = lasty
        lastx = (dx > 0) ? 1 : -1
        lasty = (dy > 0) ? 1 : -1
    } else {
        if (dx) lastx = dx
        if (dy) lasty = dy
    }
}

var lastx = 0
var lasty = 0
