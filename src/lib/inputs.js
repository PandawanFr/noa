import createInputs from 'game-inputs'

/**
 * @class Inputs
 * @typicalname noa.inputs
 * @classdesc Abstracts key/mouse input. 
 * For docs see [andyhall/game-inputs](https://github.com/andyhall/game-inputs)
 */


const defaultBindings = {
    bindings: {
        "forward": ["W", "<up>"],
        "left": ["A", "<left>"],
        "backward": ["S", "<down>"],
        "right": ["D", "<right>"],
        "fire": "<mouse 1>",
        "mid-fire": ["<mouse 2>", "Q"],
        "alt-fire": ["<mouse 3>", "E"],
        "jump": "<space>",
        "sprint": "<shift>",
        "crouch": "<control>"
    }
}


export default function makeInputs(noa, opts, element) {
    opts = Object.assign({}, defaultBindings, opts)
    const inputs = createInputs(element, opts)
    const b = opts.bindings
    for (const name in b) {
        const arr = (Array.isArray(b[name])) ? b[name] : [b[name]]
        arr.unshift(name)
        inputs.bind(...arr)
    }
    return inputs
}
