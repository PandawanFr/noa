// helper to swap item to end and pop(), instead of splice()ing
export function removeUnorderedListItem(list, item) {
    const i = list.indexOf(item)
    if (i < 0) { return }
    if (i === list.length - 1) {
        list.pop()
    } else {
        list[i] = list.pop()
    }
}




// simple thing for reporting time split up between several activities
export function makeProfileHook(_every, _title) {
    const title = _title || ''
    const every = _every || 1
    const times = []
    const names = []
    let started = 0
    let last = 0
    let iter = 0
    let total = 0
    let clearNext = true

    this.start = () => {
        if (clearNext) {
            times.length = names.length = 0
            clearNext = false
        }
        started = last = performance.now()
        iter++
    }
    this.add = name => {
        const t = performance.now()
        if (!names.includes(name)) names.push(name)
        const i = names.indexOf(name)
        if (!times[i]) times[i] = 0
        times[i] += t - last
        last = t
    }
    this.report = () => {
        total += performance.now() - started
        if (iter === every) {
            const head = `${title} total ${(total / every).toFixed(2)}ms (avg, ${every} runs)    `
            console.log(head, names.map((name, i) => `${name}: ${(times[i] / every).toFixed(2)}ms    `).join(''))
            clearNext = true
            iter = 0
            total = 0
        }
    }
    return function profile_hook(state) {
        if (state === 'start') start()
        else if (state === 'end') report()
        else add(state)
    }
}
