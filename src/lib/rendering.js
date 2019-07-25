import glvec3 from 'gl-vec3'
import { removeUnorderedListItem, Timer } from './util'

// profiling flags
const PROFILE = 0



const defaults = {
    showFPS: false,
    antiAlias: true,
    clearColor: [0.8, 0.9, 1],
    ambientColor: [1, 1, 1],
    lightIntensity: 1,
    lightDiffuse: [1, 1, 1],
    lightSpecular: [1, 1, 1],
    groundLightColor: [0.5, 0.5, 0.5],
    useAO: true,
    AOmultipliers: [0.93, 0.8, 0.5],
    reverseAOmultiplier: 1.0,
    useOctreesForDynamicMeshes: true,
    preserveDrawingBuffer: true,
}



/**
 * @class
 * @typicalname noa.rendering
 * @classdesc Manages all rendering, and the BABYLON scene, materials, etc.
 */

export default class Rendering {
    constructor(noa, opts, canvas) {
        this.noa = noa

        /**
         * `noa.rendering` uses the following options (from the root `noa(opts)` options):
         * ```js
         * {
         *   showFPS: false,
         *   antiAlias: true,
         *   clearColor: [0.8, 0.9, 1],
         *   ambientColor: [1, 1, 1],
         *   lightIntensity: 1,
         *   lightDiffuse: [1, 1, 1],
         *   lightSpecular: [1, 1, 1],
         *   groundLightColor: [0.5, 0.5, 0.5],
         *   useAO: true,
         *   AOmultipliers: [0.93, 0.8, 0.5],
         *   reverseAOmultiplier: 1.0,
         *   useOctreesForDynamicMeshes: true,
         *   preserveDrawingBuffer: true,
         * }
         * ```
         */
        opts = Object.assign({}, defaults, opts)

        // internals
        this._dynamicMeshes = []
        this.useAO = !!opts.useAO
        this.aoVals = opts.AOmultipliers
        this.revAoVal = opts.reverseAOmultiplier
        this.meshingCutoffTime = 6 // ms
        this._dynamicMeshOctrees = opts.useOctreesForDynamicMeshes
        this._resizeDebounce = 250 // ms
        this._pendingResize = false
        this._highlightPos = glvec3.create()

        // set up babylon scene
        this.initScene(canvas, opts)

        // for debugging
        if (opts.showFPS) setUpFPS()
    }

    /*
     *   PUBLIC API 
     */

    
    // Constructor helper - set up the Babylon.js scene and basic components
    initScene(canvas, opts) {
        var BABYLON = this.noa.BABYLON

        // init internal properties
        this._engine = new BABYLON.Engine(canvas, opts.antiAlias, {
            preserveDrawingBuffer: opts.preserveDrawingBuffer,
        })
        this._scene = new BABYLON.Scene(this._engine)
        const scene = this._scene
        // remove built-in listeners
        scene.detachControl()

        // octree setup
        this._octree = new BABYLON.Octree($ => {})
        this._octree.blocks = []
        scene._selectionOctree = this._octree

        // camera, and empty mesh to hold it, and one to accumulate rotations
        this._cameraHolder = new BABYLON.Mesh('camHolder', scene)
        this._camera = new BABYLON.FreeCamera('camera', new BABYLON.Vector3(0, 0, 0), scene)
        this._camera.parent = this._cameraHolder
        this._camera.minZ = .01
        this._cameraHolder.visibility = false

        // plane obscuring the camera - for overlaying an effect on the whole view
        this._camScreen = BABYLON.Mesh.CreatePlane('camScreen', 10, scene)
        this.addMeshToScene(this._camScreen)
        this._camScreen.position.z = .1
        this._camScreen.parent = this._camera
        this._camScreenMat = this.makeStandardMaterial('camscreenmat')
        this._camScreen.material = this._camScreenMat
        this._camScreen.setEnabled(false)
        this._camLocBlock = 0

        // apply some defaults
        /*
            TODO: Setup custom light system.
                First, remove this HemisphericLight because it lights up the entire level and prevents shadows from appearing.
                Second, set every mesh (probably do that in Chunk.js, or something) to `receiveShadows: true`
                Then, add lights where wanted (Note: make sure their ranges aren't too far because they can travel through walls), perhaps make a cone light so it doesn't do it through walls?
                Then, make sure to enable/disable lights that are furthest from player. 
                    (This might not be needed, it seems that each Material can only ever be affected by 4 lights, but I'm not sure if each chunk has its own material or shares one).
        */
       
        var lightVec = new BABYLON.Vector3(0.1, 1, 0.3)
        this._light = new BABYLON.HemisphericLight('light', lightVec, scene)

        function arrToColor(a) { return new BABYLON.Color3(a[0], a[1], a[2]) }
        scene.clearColor = arrToColor(opts.clearColor)
        scene.ambientColor = arrToColor(opts.ambientColor)
        this._light.diffuse = arrToColor(opts.lightDiffuse)
        this._light.specular = arrToColor(opts.lightSpecular)
        this._light.groundColor = arrToColor(opts.groundLightColor)
        this._light.intensity = opts.lightIntensity
        
        
        // make a default flat material (used or clone by terrain, etc)
        this.flatMaterial = this.makeStandardMaterial('flatmat')

    }

    /**
     * The Babylon `scene` object representing the game world.
     * @member
     */
    getScene() {
        return this._scene
    }

    // per-tick listener for rendering-related stuff
    tick(dt) {
        if (this._dynamicMeshOctrees) this.updateDynamicMeshOctrees()
    }

    render(dt) {
        profile_hook('start')
        updateCameraForRender(this)
        profile_hook('updateCamera')
        this._engine.beginFrame()
        profile_hook('beginFrame')
        this._scene.render()
        profile_hook('render')
        fps_hook()
        this._engine.endFrame()
        profile_hook('endFrame')
        profile_hook('end')
    }

    resize(e) {
        if (!this._pendingResize) {
            this._pendingResize = true
            setTimeout(() => {
                this._engine.resize()
                this._pendingResize = false
            }, this._resizeDebounce)
        }
    }

    highlightBlockFace(show, posArr, normArr) {
        const m = getHighlightMesh(this)
        if (show) {
            // bigger slop when zoomed out
            const dist = glvec3.dist(this.noa.camera.getPosition(), posArr)
            const slop = 0.0005 * dist
            const pos = this._highlightPos
            for (let i = 0; i < 3; ++i) {
                pos[i] = Math.floor(posArr[i]) + .5 + ((0.5 + slop) * normArr[i])
            }
            m.position.copyFromFloats(pos[0], pos[1], pos[2])
            m.rotation.x = (normArr[1]) ? Math.PI / 2 : 0
            m.rotation.y = (normArr[0]) ? Math.PI / 2 : 0
        }
        m.setEnabled(show)
    }

    // runs once per tick - move any dynamic meshes to correct chunk octree
    updateDynamicMeshOctrees() {
        for (let i = 0; i < this._dynamicMeshes.length; i++) {
            const mesh = this._dynamicMeshes[i]
            if (mesh._isDisposed) continue // shouldn't be possible
            const pos = mesh.position
            const prev = mesh._currentNoaChunk || null
            const next = this.noa.world._getChunkByCoords(pos.x, pos.y, pos.z) || null
            if (prev === next) continue
            // mesh has moved chunks since last update
            // remove from previous location...
            if (prev && prev.octreeBlock) {
                removeUnorderedListItem(prev.octreeBlock.entries, mesh)
            } else {
                removeUnorderedListItem(this._octree.dynamicContent, mesh)
            }
            // ... and add to new location
            if (next && next.octreeBlock) {
                next.octreeBlock.entries.push(mesh)
            } else {
                this._octree.dynamicContent.push(mesh)
            }
            mesh._currentNoaChunk = next
        }
    }

    /**
     * add a mesh to the scene's octree setup so that it renders
     * pass in isStatic=true if the mesh won't move (i.e. change octree blocks)
     * @method
     */
    addMeshToScene(mesh, isStatic) {
        // exit silently if mesh has already been added and not removed
        if (mesh._currentNoaChunk || this._octree.dynamicContent.includes(mesh)) {
            return
        }
        const pos = mesh.position
        const chunk = this.noa.world._getChunkByCoords(pos.x, pos.y, pos.z)
        if (this._dynamicMeshOctrees && chunk && chunk.octreeBlock) {
            // add to an octree
            chunk.octreeBlock.entries.push(mesh)
            mesh._currentNoaChunk = chunk
        } else {
            // mesh added outside an active chunk - so treat as scene-dynamic
            this._octree.dynamicContent.push(mesh)
        }
        // remember for updates if it's not static
        if (!isStatic) this._dynamicMeshes.push(mesh)
        // handle remover when mesh gets disposed
        const remover = this.removeMeshFromScene.bind(this, mesh)
        mesh.onDisposeObservable.add(remover)
        // Add mesh lighting/shadows
        if (mesh._currentNoaChunk) mesh.receiveShadows = true
    }

    /**  Undoes everything `addMeshToScene` does
     * @method
     */
    removeMeshFromScene(mesh) {
        if (mesh._currentNoaChunk && mesh._currentNoaChunk.octreeBlock) {
            removeUnorderedListItem(mesh._currentNoaChunk.octreeBlock.entries, mesh)
        }
        mesh._currentNoaChunk = null
        removeUnorderedListItem(this._octree.dynamicContent, mesh)
        removeUnorderedListItem(this._dynamicMeshes, mesh)
    }

    makeMeshInstance(mesh, isStatic) {
        const m = mesh.createInstance(`${mesh.name} instance` || 'instance')
        if (mesh.billboardMode) m.billboardMode = mesh.billboardMode
        // add to scene so as to render
        this.addMeshToScene(m, isStatic)

        // testing performance tweaks

        // make instance meshes skip over getLOD checks, since there may be lots of them
        // mesh.getLOD = m.getLOD = function () { return mesh }
        m._currentLOD = mesh

        // make terrain instance meshes skip frustum checks 
        // (they'll still get culled by octree checks)
        // if (isStatic) m.isInFrustum = function () { return true }

        return m
    }

    // Create a default standardMaterial:
    //      flat, nonspecular, fully reflects diffuse and ambient light
    makeStandardMaterial(name) {
        const StdMat = this.noa.BABYLON.StandardMaterial
        const mat = new StdMat(name, this._scene)
        mat.specularColor.copyFromFloats(0, 0, 0)
        mat.ambientColor.copyFromFloats(1, 1, 1)
        mat.diffuseColor.copyFromFloats(1, 1, 1)
        return mat
    }

    /*
     *
     * 
     *   ACCESSORS FOR CHUNK ADD/REMOVAL/MESHING
     *
     * 
     */

    prepareChunkForRendering(chunk) {    
        const BABYLON = this.noa.BABYLON
        const cs = chunk.size
        const min = new BABYLON.Vector3(chunk.x, chunk.y, chunk.z)
        const max = new BABYLON.Vector3(chunk.x + cs, chunk.y + cs, chunk.z + cs)
        chunk.octreeBlock = new BABYLON.OctreeBlock(min, max, undefined, undefined, undefined, $ => {})
        this._octree.blocks.push(chunk.octreeBlock)
    }

    disposeChunkForRendering(chunk) {
        this.removeTerrainMesh(chunk)
        removeUnorderedListItem(this._octree.blocks, chunk.octreeBlock)
        chunk.octreeBlock.entries.length = 0
        chunk.octreeBlock = null
    }

    addTerrainMesh(chunk, mesh) {
        this.removeTerrainMesh(chunk)
        if (mesh.getIndices().length) this.addMeshToScene(mesh, true)
        chunk._terrainMesh = mesh
    }

    removeTerrainMesh(chunk) {
        if (!chunk._terrainMesh) return
        chunk._terrainMesh.dispose()
        chunk._terrainMesh = null
    }
}

/*
 *
 *   INTERNALS
 *
 */


// updates camera position/rotation to match settings from noa.camera

function updateCameraForRender(self) {
    const cam = self.noa.camera
    const tgt = cam.getTargetPosition()
    self._cameraHolder.position.copyFromFloats(tgt[0], tgt[1], tgt[2])
    self._cameraHolder.rotation.x = cam.pitch
    self._cameraHolder.rotation.y = cam.heading
    self._camera.position.z = -cam.currentZoom

    // applies screen effect when camera is inside a transparent voxel
    const id = self.noa.getBlock(self.noa.camera.getPosition())
    checkCameraEffect(self, id)
}



//  If camera's current location block id has alpha color (e.g. water), apply/remove an effect

function checkCameraEffect(self, id) {
    if (id === self._camLocBlock) return
    if (id === 0) {
        self._camScreen.setEnabled(false)
    } else {
        const matId = self.noa.registry.getBlockFaceMaterial(id, 0)
        if (matId) {
            const matData = self.noa.registry.getMaterialData(matId)
            const col = matData.color
            const alpha = matData.alpha
            if (col && alpha && alpha < 1) {
                self._camScreenMat.diffuseColor.set(0, 0, 0)
                self._camScreenMat.ambientColor.set(col[0], col[1], col[2])
                self._camScreenMat.alpha = alpha
                self._camScreen.setEnabled(true)
            }
        }
    }
    self._camLocBlock = id
}






// make or get a mesh for highlighting active voxel
function getHighlightMesh(rendering) {
    const BABYLON = rendering.noa.BABYLON
    let m = rendering._highlightMesh
    if (!m) {
        const mesh = BABYLON.Mesh.CreatePlane("highlight", 1.0, rendering._scene)
        const hlm = rendering.makeStandardMaterial('highlightMat')
        hlm.backFaceCulling = false
        hlm.emissiveColor = new BABYLON.Color3(1, 1, 1)
        hlm.alpha = 0.2
        mesh.material = hlm
        m = rendering._highlightMesh = mesh
        // outline
        const s = 0.5
        const lines = BABYLON.Mesh.CreateLines("hightlightLines", [
            new BABYLON.Vector3(s, s, 0),
            new BABYLON.Vector3(s, -s, 0),
            new BABYLON.Vector3(-s, -s, 0),
            new BABYLON.Vector3(-s, s, 0),
            new BABYLON.Vector3(s, s, 0)
        ], rendering._scene)
        lines.color = new BABYLON.Color3(1, 1, 1)
        lines.parent = mesh

        rendering.addMeshToScene(m)
        rendering.addMeshToScene(lines)
    }
    return m
}









var profile_hook = (() => {
    if (!PROFILE) return () => {}
    const every = 200
    const timer = new(Timer)(every, 'render internals')
    return state => {
        if (state === 'start') timer.start()
        else if (state === 'end') timer.report()
        else timer.add(state)
    }
})()



var fps_hook = () => {}

function setUpFPS() {
    const div = document.createElement('div')
    div.id = 'noa_fps'
    let style = 'position:absolute; top:0; right:0; z-index:0;'
    style += 'color:white; background-color:rgba(0,0,0,0.5);'
    style += 'font:14px monospace; text-align:center;'
    style += 'min-width:2em; margin:4px;'
    div.style = style
    document.body.appendChild(div)
    const every = 1000
    let ct = 0
    let longest = 0
    let start = performance.now()
    let last = start
    fps_hook = () => {
        ct++
        const nt = performance.now()
        if (nt - last > longest) longest = nt - last
        last = nt
        if (nt - start < every) return
        const fps = Math.round(ct / (nt - start) * 1000)
        const min = Math.round(1 / longest * 1000)
        div.innerHTML = `${fps}<br>${min}`
        ct = 0
        longest = 0
        start = nt
    }
}
